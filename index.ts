import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { hasNative, spawn as spawnPty } from "zigpty";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

const DEFAULT_TOKENS = 10_000;
const MEMORY_LIMIT = 64 * 1024;
const TAIL_LENGTH = 4_000;
const EXIT_RETENTION_MS = 5 * 60_000;
const PIPE_DRAIN_MS = 50;
const PROCESS_SAMPLE_MS = 250;
const PROCESS_TERM_MS = 100;
const PROCESS_REAP_MS = 500;
const TRUNCATION_MARKER = "\n… output truncated …\n";

// Pi accepts JSON Schema here. These definitions also load in standalone Node.
const string = { type: "string" } as const;
const boolean = { type: "boolean" } as const;
const integer = { type: "integer" } as const;
const number = { type: "number" } as const;
const options = {
  yield_time_ms: { ...number, description: "Wait between 100 and 120000 ms before returning." },
  max_output_tokens: { ...number, minimum: 0, default: DEFAULT_TOKENS, description: "Output budget, estimated at four characters per token." },
};
const outputFields = {
  output: string,
  wall_time_ms: integer,
  truncated: boolean,
  full_output_path: string,
};
const status = (value: string) => ({ type: "string", const: value });
function objectSchema<T extends Record<string, object>>(properties: T, required: Array<keyof T>) {
  return { type: "object" as const, properties, required, additionalProperties: false };
}

const outputRequired = ["status", "output", "wall_time_ms", "truncated"] as const;
const execOutputSchema = {
  anyOf: [
    objectSchema({ ...outputFields, status: status("exited"), exit_code: integer }, [...outputRequired, "exit_code"]),
    objectSchema({ ...outputFields, status: status("running"), session_id: string }, [...outputRequired, "session_id"]),
  ],
};
const writeOutputSchema = {
  anyOf: [
    objectSchema({ ...outputFields, status: status("running"), session_id: string }, [...outputRequired, "session_id"]),
    objectSchema({ ...outputFields, status: status("exited"), session_id: string, exit_code: integer }, [...outputRequired, "session_id", "exit_code"]),
    objectSchema({ ...outputFields, status: status("killed"), session_id: string, exit_code: integer }, [...outputRequired, "session_id"]),
  ],
};

interface ExecOptions {
  cmd: string;
  workdir?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
  tty?: boolean;
  shell?: string;
  login?: boolean;
}
interface WriteOptions {
  session_id: string;
  chars?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
  kill?: boolean;
}

// Keep terminal and UTF-8 parsing state across chunks and tool calls.
class TerminalText {
  private decoder = new StringDecoder("utf8");
  private mode: "text" | "escape" | "intermediate" | "csi" | "osc" | "string" = "text";
  private stringEscape = false;
  private afterCR = false;

  write(bytes: Buffer) { return this.normalize(this.decoder.write(bytes)); }
  end() { return this.normalize(this.decoder.end()); }

  private normalize(text: string) {
    let output = "";
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (this.mode === "osc" || this.mode === "string") {
        if (code === 0x9c || (this.stringEscape && char === "\\") || (this.mode === "osc" && code === 7)) {
          this.mode = "text";
        }
        this.stringEscape = code === 0x1b;
        continue;
      }
      if (code === 0x1b) {
        this.mode = "escape";
        continue;
      }
      if (code === 0x9b || (this.mode === "escape" && char === "[")) {
        this.mode = "csi";
        continue;
      }
      if (code === 0x9d || (this.mode === "escape" && char === "]")) {
        this.mode = "osc";
        continue;
      }
      if ([0x90, 0x98, 0x9e, 0x9f].includes(code) || (this.mode === "escape" && "PX^_".includes(char))) {
        this.mode = "string";
        continue;
      }
      if (this.mode !== "text") {
        if (this.mode === "csi" && code >= 0x20 && code <= 0x3f) continue;
        if (this.mode !== "csi" && code >= 0x20 && code <= 0x2f) {
          this.mode = "intermediate";
          continue;
        }
        const finalByte = this.mode === "csi" ? 0x40 : 0x30;
        this.mode = "text";
        if (code >= finalByte && code <= 0x7e) continue;
      }
      if (char === "\r" || char === "\n") {
        if (!(this.afterCR && char === "\n")) output += "\n";
        this.afterCR = char === "\r";
      } else if (char === "\t" || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))) {
        this.afterCR = false;
        output += char;
      }
    }
    return output;
  }
}

function head(text: string, length: number) {
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

function tail(text: string, length: number) {
  const start = Math.max(0, text.length - length);
  const first = text.charCodeAt(start);
  return text.slice(first >= 0xdc00 && first <= 0xdfff ? start + 1 : start);
}

function outputLog(text: string) {
  const path = "/private/tmp/pi-codex-exec-" + randomUUID() + ".log";
  writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  return path;
}

// One capture per output interval. Spill slow-reader output before it grows in memory.
class Capture {
  private text = "";
  private path?: string;
  private length = 0;
  private bytes = 0;
  private error?: unknown;

  append(text: string) {
    if (!text || this.error) return;
    try {
      this.length += text.length;
      if (this.path) {
        appendFileSync(this.path, text);
        this.bytes += Buffer.byteLength(text);
      } else {
        this.text += text;
        if (this.length > MEMORY_LIMIT) {
          this.path = outputLog(this.text);
          this.bytes = Buffer.byteLength(this.text);
          this.text = "";
        }
      }
    } catch (error) {
      this.error = error;
    }
  }

  take(limit: number) {
    if (this.error) throw this.error;
    if (this.length <= limit) {
      const output = this.path ? readFileSync(this.path, "utf8") : this.text;
      this.discard();
      return { output, truncated: false };
    }

    const marker = limit > TRUNCATION_MARKER.length ? TRUNCATION_MARKER : "";
    const available = limit - marker.length;
    const first = Math.ceil(available / 2);
    const last = available - first;
    let start = this.text;
    let end = this.text;
    if (this.path) {
      const fd = openSync(this.path, "r");
      try {
        const read = (size: number, fromEnd: boolean) => {
          if (size === 0) return "";
          // A UTF-16 code unit occupies at most three UTF-8 bytes on average.
          const buffer = Buffer.alloc(Math.min(this.bytes, size * 3 + 4));
          const offset = fromEnd ? this.bytes - buffer.length : 0;
          let count = 0;
          while (count < buffer.length) {
            const n = readSync(fd, buffer, count, buffer.length - count, offset + count);
            if (!n) break;
            count += n;
          }
          let start = 0;
          if (fromEnd) while (start < count && (buffer[start] & 0xc0) === 0x80) start++;
          return buffer.toString("utf8", start, count);
        };
        start = read(first, false);
        end = read(last, true);
      } finally {
        closeSync(fd);
      }
    }
    const full_output_path = this.path ?? outputLog(this.text);
    this.path = undefined; // The caller now owns the returned log.
    return { output: head(start, first) + marker + tail(end, last), truncated: true, full_output_path };
  }

  discard() {
    if (!this.path) return;
    try { unlinkSync(this.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.path = undefined;
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals) {
  try { process.kill(pid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

interface ProcessInfo {
  pid: number;
  parent: number;
  group: number;
  state: string;
  started: string;
}

function processTable() {
  const output = execFileSync("/bin/ps", ["-ax", "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
    encoding: "utf8", timeout: 1_000,
  });
  return output.trim().split("\n").flatMap((row): ProcessInfo[] => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(row);
    if (!match) return [];
    const [, pid, parent, group, state, started] = match;
    return [{ pid: Number(pid), parent: Number(parent), group: Number(group), state, started }];
  });
}

class Session {
  pid?: number;
  exitCode?: number;
  spawnError?: Error;
  background = false;
  busy = false;
  killed = false;
  expiry?: NodeJS.Timeout;
  history = "";
  private capture = new Capture();
  private listeners = new Set<() => void>();
  private writeInput: (chars: string) => void = () => {};
  private closeIO: () => void = () => {};
  private terminating?: Promise<void>;
  private finishing?: Promise<void>;
  private reaping?: Promise<void>;
  private pipeDrain?: Promise<void>;
  private descendants = new Map<number, string>();

  readonly id: string;
  readonly tty: boolean;
  private onExit: () => void;

  constructor(id: string, tty: boolean, onExit: () => void) {
    this.id = id;
    this.tty = tty;
    this.onExit = onExit;
  }

  start(cmd: string, shell: string, login: boolean, cwd: string) {
    const args = login ? ["-l", "-c", cmd] : ["-c", cmd];
    const stdout = new TerminalText();
    const stderr = new TerminalText();
    const finish = (code: number) => {
      this.append(stdout.end());
      this.append(stderr.end());
      return this.finish(code);
    };
    if (this.tty) {
      if (!hasNative) throw new Error("Native zigpty bindings are required for tty:true.");
      const pty = spawnPty(shell, args, {
        cwd,
        encoding: null,
        name: "xterm-256color",
        onExit: (code, signal) => finish(signal ? 128 + signal : code),
      });
      this.pid = pty.pid;
      pty.onData((bytes) => this.append(stdout.write(bytes as Buffer)));
      this.writeInput = (chars) => pty.write(chars);
      this.closeIO = () => pty.close();
      return;
    }

    const child = spawn(shell, args, { cwd, detached: true, stdio: "pipe" });
    this.pid = child.pid;
    child.stdout.on("data", (bytes: Buffer) => this.append(stdout.write(bytes)));
    child.stderr.on("data", (bytes: Buffer) => this.append(stderr.write(bytes)));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") this.spawnError = error;
    });
    child.once("error", (error) => {
      this.spawnError = error;
      this.closeIO();
      void finish(1);
    });
    child.once("exit", (code, signal) => {
      // Let ready output drain, but a descendant may leave these descriptors open indefinitely.
      this.pipeDrain = new Promise((resolve) => {
        const drain = () => {
          clearTimeout(timer);
          child.off("close", drain);
          this.closeIO();
          resolve(finish(code ?? (signal ? 128 + constants.signals[signal] : 1)));
        };
        const timer = setTimeout(drain, PIPE_DRAIN_MS);
        child.once("close", drain);
      });
    });
    this.writeInput = (chars) => {
      for (const part of chars.split(/([\x03\x04])/)) {
        if (part === "\x03" && child.pid) sendSignal(-child.pid, "SIGINT");
        else if (part === "\x04") child.stdin.end();
        else if (part && child.stdin.writable) child.stdin.write(part);
      }
    };
    this.closeIO = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
  }

  private append(text: string) {
    this.capture.append(text);
    this.history = tail(this.history + text, TAIL_LENGTH);
  }

  private finish(code: number) {
    this.finishing ??= this.completeExit(code);
    return this.finishing;
  }

  private async completeExit(code: number) {
    if (this.pid) {
      try { await this.reap(this.pid, false); } catch (error) { this.spawnError ??= error as Error; }
    }
    this.exitCode = code;
    for (const listener of this.listeners) listener();
    this.onExit();
  }

  wait(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.exitCode !== undefined) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(complete);
        signal?.removeEventListener("abort", abort);
      };
      const complete = () => { cleanup(); resolve(this.pipeDrain); };
      const abort = () => { cleanup(); reject(signal?.reason); };
      const timer = setTimeout(complete, ms);
      this.listeners.add(complete);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  write(chars: string) {
    if (chars && this.exitCode === undefined) this.writeInput(chars);
  }

  stop() {
    if (!this.pid) return Promise.resolve();
    if (!this.finishing) this.killed = true;
    this.terminating ??= this.terminate(this.pid).catch((error: unknown) => {
      this.terminating = undefined;
      throw error;
    });
    return this.terminating;
  }

  sampleDescendants(rows: ProcessInfo[]) {
    const pid = this.pid;
    if (!pid) return;
    const children = new Map<number, ProcessInfo[]>();
    const owned = new Map<number, ProcessInfo>();
    for (const row of rows) {
      if (row.pid === pid) continue;
      const siblings = children.get(row.parent);
      if (siblings) siblings.push(row);
      else children.set(row.parent, [row]);
      // Keep observed descendants after a change of parent or process group.
      if (row.group === pid || this.descendants.get(row.pid) === row.started) owned.set(row.pid, row);
    }
    const parents = [pid, ...owned.keys()];
    for (const parent of parents) {
      for (const child of children.get(parent) ?? []) {
        if (owned.has(child.pid)) continue;
        owned.set(child.pid, child);
        parents.push(child.pid);
      }
    }
    for (const row of owned.values()) this.descendants.set(row.pid, row.started);
  }

  private async terminate(pid: number) {
    try {
      await this.reap(pid, !this.finishing);
    } finally {
      await this.wait(2_000);
      if (this.exitCode === undefined) {
        this.closeIO();
        await this.finish(137);
      }
    }
  }

  private reap(pid: number, includeLeader: boolean) {
    this.reaping ??= this.reapProcesses(pid, includeLeader).catch((error: unknown) => {
      this.reaping = undefined;
      throw error;
    });
    return this.reaping;
  }

  private async reapProcesses(pid: number, includeLeader: boolean) {
    const snapshot = () => {
      try { return processTable(); } catch (error) {
        // Both launch paths create a process group. Use it even when ps fails.
        sendSignal(-pid, "SIGKILL");
        if (includeLeader && !this.finishing) sendSignal(pid, "SIGKILL");
        throw error;
      }
    };
    let rows = snapshot();
    const leader = includeLeader ? rows.find((row) => row.pid === pid) : undefined;
    const remainingProcesses = () => {
      this.sampleDescendants(rows);
      return rows.filter((row) => !row.state.startsWith("Z") && (
        (row.pid === pid && row.started === leader?.started) || this.descendants.get(row.pid) === row.started
      ));
    };
    let remaining = remainingProcesses();
    if (!remaining.length) return;
    for (const row of remaining) sendSignal(row.pid, "SIGTERM");

    const killAt = performance.now() + PROCESS_TERM_MS;
    const deadline = killAt + PROCESS_REAP_MS;
    do {
      await delay(25);
      rows = snapshot();
      remaining = remainingProcesses();
      if (!remaining.length) return;
      const now = performance.now();
      if (now >= deadline) {
        throw new Error("Could not terminate processes for session " + this.id + ": " + remaining.map((row) => row.pid).join(", "));
      }
      if (now >= killAt) for (const row of remaining) sendSignal(row.pid, "SIGKILL");
    } while (true);
  }

  take(limit: number) {
    if (this.spawnError) throw this.spawnError;
    const result = this.capture.take(limit);
    this.capture = new Capture();
    return result;
  }

  discard() { this.capture.discard(); }
}

function outputLimit(tokens = DEFAULT_TOKENS) {
  if (!Number.isFinite(tokens) || tokens < 0) throw new Error("max_output_tokens must be a finite nonnegative number.");
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(tokens * 4));
}

function yieldWindow(ms: number) {
  return Math.min(120_000, Math.max(100, ms));
}

function toolResult(result: {
  status: "running" | "exited" | "killed";
  session_id?: string;
  exit_code?: number;
  wall_time_ms: number;
  output: string;
  truncated: boolean;
  full_output_path?: string;
}) {
  const lines = [
    result.status + (result.session_id ? " (session " + result.session_id + ")" : "")
      + (result.exit_code === undefined ? "" : ", exit code " + result.exit_code)
      + " after " + result.wall_time_ms + " ms",
    result.output,
  ];
  if (result.full_output_path) lines.push("Full output: " + result.full_output_path);
  return { structuredContent: result, content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] };
}

type ExecutionContext = Pick<ExtensionContext, "cwd" | "ui">;

export function createExecution() {
  const sessions = new Map<string, Session>();
  let nextId = 0;
  let shuttingDown = false;
  let ui: ExtensionContext["ui"] | undefined;
  let processSampler: NodeJS.Timeout | undefined;

  function sampleProcesses() {
    const live = [...sessions.values()].filter((session) => session.pid && session.exitCode === undefined);
    if (!live.length) {
      clearInterval(processSampler);
      processSampler = undefined;
      return;
    }
    try {
      const rows = processTable();
      for (const session of live) session.sampleDescendants(rows);
    } catch {
      // Polling is opportunistic. Termination still tries the group and reports errors.
    }
  }

  function active() {
    return [...sessions.values()].filter((session) => session.background && session.exitCode === undefined);
  }

  function updateStatus() {
    const count = active().filter((session) => session.tty).length;
    ui?.setStatus?.("pi-codex-exec", count ? count + " PTY • /pty" : undefined);
  }

  function forget(session: Session) {
    sessions.delete(session.id);
    if (sessions.size === 0) {
      clearInterval(processSampler);
      processSampler = undefined;
    }
    clearTimeout(session.expiry);
    session.discard();
    updateStatus();
  }

  async function stopAndForget(session: Session) {
    await session.stop();
    forget(session);
  }

  const execTool = {
    name: "exec_command",
    label: "Exec Command",
    description: "Run a shell command. Returns output and an exit code, or a session ID to continue with write_stdin.",
    parameters: objectSchema({
      cmd: { ...string, description: "Shell command to execute." },
      workdir: { ...string, description: "Working directory, relative to the Pi session cwd when applicable." },
      tty: { ...boolean, default: true, description: "Allocate a native PTY. Set false for pipes." },
      shell: { ...string, default: "/bin/zsh", description: "Shell executable." },
      login: { ...boolean, default: false, description: "Start a login shell." },
      ...options,
      yield_time_ms: { ...options.yield_time_ms, default: 10_000 },
    }, ["cmd"]),
    outputSchema: execOutputSchema,
    async execute(_id: string, { cmd, workdir, yield_time_ms = 10_000, max_output_tokens, tty = true, shell = "/bin/zsh", login = false }: ExecOptions, signal?: AbortSignal, _update?: unknown, ctx?: ExecutionContext) {
      signal?.throwIfAborted();
      if (shuttingDown) throw new Error("The execution session is shutting down.");
      const limit = outputLimit(max_output_tokens);
      const started = performance.now();
      ui = ctx?.ui ?? ui;
      const id = "p" + (++nextId).toString(36);
      const session = new Session(id, tty, () => {
        if (session.background && sessions.has(id)) {
          if (!session.spawnError) session.expiry = setTimeout(() => forget(session), EXIT_RETENTION_MS).unref();
          updateStatus();
        }
      });
      sessions.set(id, session);
      try {
        session.start(cmd, shell, login, resolve(ctx?.cwd ?? process.cwd(), workdir ?? "."));
        processSampler ??= setInterval(sampleProcesses, PROCESS_SAMPLE_MS).unref();
        await session.wait(yieldWindow(yield_time_ms), signal);
        signal?.throwIfAborted();
        const output = { ...session.take(limit), wall_time_ms: Math.round(performance.now() - started) };
        if (session.exitCode !== undefined) {
          forget(session);
          return toolResult({ ...output, status: "exited", exit_code: session.exitCode });
        }
        session.background = true;
        updateStatus();
        return toolResult({ ...output, status: "running", session_id: id });
      } catch (error) {
        await stopAndForget(session);
        throw error;
      }
    },
  };

  const writeTool = {
    name: "write_stdin",
    label: "Write Stdin",
    description: "Send input to a session or poll for new output. Use kill to terminate its process tree.",
    parameters: objectSchema({
      session_id: { ...string, description: "ID returned by exec_command." },
      chars: { ...string, default: "", description: "Input text. Use newline to submit a line, Ctrl+C to interrupt, or Ctrl+D for EOF." },
      kill: { ...boolean, default: false, description: "Terminate the session's process tree." },
      ...options,
      yield_time_ms: { ...options.yield_time_ms, default: 5_000 },
    }, ["session_id"]),
    outputSchema: writeOutputSchema,
    async execute(_id: string, { session_id, chars = "", yield_time_ms = 5_000, max_output_tokens, kill = false }: WriteOptions, signal?: AbortSignal, _update?: unknown, ctx?: ExecutionContext) {
      signal?.throwIfAborted();
      const session = sessions.get(session_id);
      if (!session?.background) throw new Error("Unknown session_id: " + session_id);
      if (session.busy) throw new Error("Session " + session_id + " already has a write_stdin call in progress.");
      const limit = outputLimit(max_output_tokens);
      const started = performance.now();
      ui = ctx?.ui ?? ui;
      session.busy = true;
      try {
        if (kill) await session.stop();
        else {
          session.write(chars);
          await session.wait(yieldWindow(yield_time_ms), signal);
        }
        signal?.throwIfAborted();
        const output = { ...session.take(limit), session_id, wall_time_ms: Math.round(performance.now() - started) };
        if (session.exitCode === undefined) return toolResult({ ...output, status: "running" });
        forget(session);
        return toolResult({ ...output, status: session.killed ? "killed" : "exited", exit_code: session.exitCode });
      } catch (error) {
        await stopAndForget(session);
        throw error;
      } finally {
        session.busy = false;
      }
    },
  };

  const ptyCommand = {
    description: "List execution sessions, show /pty tail <id>, or /pty kill <id|all>.",
    async handler(args: string, ctx?: ExecutionContext) {
      ui = ctx?.ui;
      const notify = (text: string) => ui?.notify?.(text, "info");
      const [action = "list", id, extra] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "list" && !id) {
        notify(active().map((session) => session.id + " " + (session.tty ? "PTY" : "pipes")).join("\n") || "No active execution sessions.");
        return;
      }
      if (!id || extra || (action !== "tail" && action !== "kill")) {
        notify("Usage: /pty [list | tail <id> | kill <id|all>]");
        return;
      }
      if (action === "kill" && id === "all") {
        const targets = [...sessions.values()].filter((session) => session.background);
        await Promise.all(targets.map(stopAndForget));
        notify("Cleared " + targets.length + " execution session(s).");
        return;
      }
      const session = sessions.get(id);
      if (!session?.background) {
        notify("Unknown session_id: " + id);
      } else if (action === "tail") {
        notify(session.history || "No output from session " + id + ".");
      } else {
        await stopAndForget(session);
        notify("Cleared execution session " + id + ".");
      }
    },
  };

  async function shutdown() {
    shuttingDown = true;
    try {
      const results = await Promise.allSettled([...sessions.values()].map(stopAndForget));
      const errors = results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
      if (errors.length) throw new Error(errors.join("\n"));
    } finally {
      shuttingDown = false;
    }
  }

  return { execTool, writeTool, ptyCommand, shutdown };
}

export default function register(pi: ExtensionAPI) {
  const { execTool, writeTool, ptyCommand, shutdown } = createExecution();
  pi.registerTool(execTool as unknown as ToolDefinition);
  pi.registerTool(writeTool as unknown as ToolDefinition);
  pi.registerCommand("pty", ptyCommand);
  pi.on("session_shutdown", shutdown);
}
