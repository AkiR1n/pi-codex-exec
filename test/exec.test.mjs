import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import register, { buildSeatbeltProfile, createExecution, expandSandboxPath, pruneStaleLogs, resolveProtectedWritePaths, resolveSandboxConfig } from "../index.ts";

function harness(t, ctx = { cwd: process.cwd() }, sandboxOverride = { mode: "off" }) {
  const { execTool, ptyTool, writeTool, ptyCommand, sandboxCommand, onSessionStart, shutdown } = createExecution(sandboxOverride);
  const seenLogs = new Set();
  async function call(tool, input, signal) {
    assert.ok(tool.outputSchema);
    const result = await tool.execute("test", input, signal, undefined, ctx);
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.startsWith(result.structuredContent.status));
    const logPath = result.structuredContent.full_output_path;
    if (logPath && !seenLogs.has(logPath)) {
      seenLogs.add(logPath);
      t.after(() => unlink(logPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      }));
    }
    return result.structuredContent;
  }
  t.after(shutdown);
  return {
    exec: (params, signal) => call(execTool, params, signal),
    ptySession: (session_id, params, signal) => call(ptyTool, { session_id, ...params }, signal),
    write: (session_id, params, signal) => call(writeTool, { session_id, ...params }, signal),
    pty: (args, overrideCtx = ctx) => ptyCommand.handler(args, overrideCtx),
    sandbox: (args, overrideCtx = ctx) => sandboxCommand.handler(args, overrideCtx),
    sessionStart: (overrideCtx = ctx) => onSessionStart(overrideCtx),
    shutdown,
  };
}

async function assertGone(pid) {
  assert.ok(Number.isInteger(pid) && pid > 1);
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch (error) {
      assert.equal(error.code, "ESRCH");
      return;
    }
    await delay(20);
  }
  assert.fail("Process " + pid + " is still present");
}

function cleanupPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(pid, "SIGKILL"); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function trackLog(t, path) {
  assert.match(path, /^\/private\/tmp\/pi-codex-exec-.+\.log$/);
  t.after(() => unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  }));
  return path;
}

test("native PTY returns short output, recognizes a TTY, and preserves text", { timeout: 5_000 }, async (t) => {
  const { exec } = harness(t);
  const { wall_time_ms, ...result } = await exec({ cmd: "test -t 0 && printf '\\033[32mhi 世界 ☀️ [ok]\\033[0m\\n'" });
  assert.deepEqual(result, { status: "exited", exit_code: 0, output: "hi 世界 ☀️ [ok]\n", truncated: false });
  assert.ok(wall_time_ms >= 0 && wall_time_ms < 5_000);
});

test("pipes use session cwd, deliver stdout and stderr, and return nonzero exit status", { timeout: 5_000 }, async (t) => {
  const { exec } = harness(t);
  const result = await exec({ tty: false, shell: "/bin/sh", workdir: "test", cmd: 'printf "%s\\n" "$(basename "$PWD")"; echo err >&2; exit 17' });
  assert.equal(result.status, "exited");
  assert.equal(result.exit_code, 17);
  assert.deepEqual(result.output.trim().split("\n").sort(), ["err", "test"]);
});

test("pipes return the shell exit status while a background job still holds stdout and stderr", { timeout: 5_000 }, async (t) => {
  const { exec } = harness(t);
  const result = await exec({ tty: false, shell: "/bin/sh", cmd: "sleep 30 & echo $!; echo err >&2; exit 17", yield_time_ms: 1_000 });
  const pid = Number(result.output.match(/^\d+$/m)?.[0]);
  t.after(() => cleanupPid(pid));
  assert.equal(result.status, "exited");
  assert.equal(result.exit_code, 17);
  assert.match(result.output, /^err$/m);
  await assertGone(pid);
});

test("real PTY yields, accepts input, and returns output only once", { timeout: 5_000 }, async (t) => {
  const { exec, write } = harness(t);
  const start = await exec({ cmd: "echo ready; sh -c 'read x; echo got:$x'", yield_time_ms: 1 });
  assert.equal(start.status, "running");
  assert.match(start.session_id, /^[a-z0-9]+$/);
  assert.equal(start.output, "ready\n");
  assert.ok(start.wall_time_ms >= 90);
  const result = await write(start.session_id, { chars: "hello\n" });
  assert.equal(result.status, "exited");
  assert.equal(result.exit_code, 0);
  assert.equal(result.output, "hello\ngot:hello\n");
  await assert.rejects(write(start.session_id), /Unknown session_id/);
});

test("PTY interprets Ctrl+C and Ctrl+D", { timeout: 5_000 }, async (t) => {
  const { exec, write } = harness(t);
  const running = await exec({ cmd: "echo ready; exec sleep 30", yield_time_ms: 100 });
  const interrupted = await write(running.session_id, { chars: "\x03", yield_time_ms: 1_000 });
  assert.equal(interrupted.status, "exited");
  assert.equal(interrupted.exit_code, 130);
  const reader = await exec({ cmd: "stty -echo; read x || echo saw-eof", yield_time_ms: 100 });
  const eof = await write(reader.session_id, { chars: "\x04", yield_time_ms: 1_000 });
  assert.equal(eof.status, "exited");
  assert.equal(eof.output, "saw-eof\n");
});

test("pipe Ctrl+D closes stdin after preceding input", { timeout: 5_000 }, async (t) => {
  const { exec, write } = harness(t);
  const start = await exec({ cmd: "cat; echo saw-eof", tty: false, yield_time_ms: 100 });
  const result = await write(start.session_id, { chars: "hello\n\x04", yield_time_ms: 1_000 });
  assert.equal(result.status, "exited");
  assert.equal(result.output, "hello\nsaw-eof\n");
});

test("kill:true terminates a PTY process tree including a child in another group", { timeout: 5_000 }, async (t) => {
  const { exec, write } = harness(t);
  const start = await exec({ cmd: 'echo shell:$$; /usr/bin/perl -e \'setpgrp(0,0) or die $!; $|=1; print "child:$$\\n"; sleep 30\' & wait', yield_time_ms: 250 });
  const root = Number(start.output.match(/shell:(\d+)/)?.[1]);
  const child = Number(start.output.match(/child:(\d+)/)?.[1]);
  assert.equal(start.status, "running");
  const result = await write(start.session_id, { kill: true });
  assert.equal(result.status, "killed");
  await Promise.all([assertGone(root), assertGone(child)]);
  await assert.rejects(write(start.session_id), /Unknown session_id/);
});

test("output normalizer keeps control-sequence state across polls", { timeout: 5_000 }, async (t) => {
  const { exec, write } = harness(t);
  const start = await exec({ tty: false, cmd: "printf 'before\\033[31'; read x; printf 'mafter\\033[0m\\033]0;hidden\\007\\r\\nlast\\tline\\n'", yield_time_ms: 100 });
  assert.equal(start.output, "before");
  const idle = await write(start.session_id, { yield_time_ms: 100 });
  assert.equal(idle.status, "running");
  assert.equal(idle.output, "");
  const result = await write(start.session_id, { chars: "go\n" });
  assert.equal(result.status, "exited");
  assert.equal(result.output, "after\nlast\tline\n");
});

test("large PTY output is previewed within budget and spilled in full", { timeout: 5_000 }, async (t) => {
  const { exec } = harness(t);
  const middle = "界😺".repeat(30_000);
  const result = await exec({ cmd: "printf 'HEAD'; /usr/bin/yes '界😺' | head -n 30000 | tr -d '\\n'; printf 'TAIL\\n'", max_output_tokens: 22 });
  const path = trackLog(t, result.full_output_path);
  assert.equal(result.status, "exited");
  assert.equal(result.exit_code, 0);
  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= 22 * 4);
  assert.match(result.output, /^HEAD/);
  assert.match(result.output, /TAIL\n$/);
  assert.doesNotMatch(result.output, /\ufffd|[\ud800-\udfff]/u);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, "utf8"), "HEAD" + middle + "TAIL\n");
});

test("write_stdin applies its own output budget below the spill threshold", { timeout: 5_000 }, async (t) => {
  const { exec, write } = harness(t);
  const start = await exec({ tty: false, cmd: "read x; printf '%s' abcdefghijuvwxyz", yield_time_ms: 100 });
  const result = await write(start.session_id, { chars: "go\n", max_output_tokens: 1 });
  const path = trackLog(t, result.full_output_path);
  assert.equal(result.output, "abyz");
  assert.equal(result.truncated, true);
  assert.equal(await readFile(path, "utf8"), "abcdefghijuvwxyz");
});

test("invalid session IDs raise an error", async (t) => {
  const { write } = harness(t);
  await assert.rejects(write("missing"), /Unknown session_id: missing/);
});

test("/pty lists, shows buffered tail, and kills single and all sessions; UI status clears", { timeout: 5_000 }, async (t) => {
  const notices = [];
  const statuses = [];
  const { exec, write, pty } = harness(t, { ui: {
    notify: (text) => notices.push(text),
    setStatus: (key, status) => statuses.push({ key, status }),
  } });
  const first = await exec({ cmd: "echo first; exec sleep 30", yield_time_ms: 100 });
  const second = await exec({ cmd: "echo second; exec sleep 30", yield_time_ms: 100 });
  assert.equal(statuses.at(-1).status, "2 PTY • /pty");
  await pty("");
  assert.equal(notices.at(-1), first.session_id + " PTY [off]\n" + second.session_id + " PTY [off]");
  await pty("tail " + first.session_id);
  assert.equal(notices.at(-1), "first\n");
  await pty("kill " + first.session_id);
  await assert.rejects(write(first.session_id), /Unknown session_id/);
  assert.equal(statuses.at(-1).status, "1 PTY • /pty");
  await pty("kill all");
  await assert.rejects(write(second.session_id), /Unknown session_id/);
  assert.equal(statuses.at(-1).status, undefined);
});

test("short-lived shells clean up jobs left in their process group", { timeout: 5_000 }, async (t) => {
  const { exec } = harness(t);
  for (const tty of [true, false]) {
    const result = await exec({ tty, cmd: "sleep 30 </dev/null >/dev/null 2>&1 & echo $!; exit" });
    const pid = Number(result.output.trim());
    assert.equal(result.status, "exited");
    try {
      await assertGone(pid);
    } finally {
      if (pid > 1) {
        try { process.kill(pid, "SIGKILL"); } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
  }
});

test("registered session_shutdown clears live PTY and pipe sessions and reaps the processes", { timeout: 5_000 }, async (t) => {
  const tools = new Map();
  const commands = new Set();
  const handlers = new Map();
  register({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name) => commands.add(name),
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  assert.deepEqual([...commands].sort(), ["pty", "sandbox"]);
  assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "session_start"]);
  assert.equal(typeof handlers.get("session_start"), "function");
  const shutdown = handlers.get("session_shutdown");
  assert.equal(typeof shutdown, "function");
  t.after(shutdown);
  const exec = tools.get("exec_command").execute;
  const ptySession = tools.get("pty_session").execute;
  const write = tools.get("write_stdin").execute;
  assert.ok(ptySession);
  const logPaths = [];
  try {
    const runs = await Promise.all([true, false].map(async (tty) => {
      const result = await exec("test", { cmd: "echo $$; exec sleep 30", tty, yield_time_ms: 100 });
      if (result.structuredContent.full_output_path) logPaths.push(result.structuredContent.full_output_path);
      return result;
    }));
    await shutdown();
    for (const { structuredContent: run } of runs) {
      await assertGone(Number(run.output.trim()));
      await assert.rejects(write("test", { session_id: run.session_id }), /Unknown session_id/);
    }
  } finally {
    await shutdown();
    await Promise.all(logPaths.map((p) => unlink(p).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    })));
  }
});

test("shutdown reaps an observed descendant after it changes session and is reparented", { timeout: 5_000 }, async (t) => {
  const { exec, write, shutdown } = harness(t);
  const start = await exec({
    tty: false,
    shell: "/bin/sh",
    cmd: "echo shell:$$; /usr/bin/perl -MPOSIX -e '" +
      "if (my $child = fork()) { sleep 30; exit; } " +
      "POSIX::setsid() != -1 or die $!; $|=1; print qq(child:$$ parent:), getppid(), qq(\\n); sleep 30' & " +
      "read parent; kill -KILL \"$parent\"; wait \"$parent\" 2>/dev/null; echo reparented; read x",
    yield_time_ms: 1_000,
  });
  const root = Number(start.output.match(/shell:(\d+)/)?.[1]);
  const child = Number(start.output.match(/child:(\d+)/)?.[1]);
  const parent = Number(start.output.match(/parent:(\d+)/)?.[1]);
  t.after(() => cleanupPid(child));
  assert.equal(start.status, "running");
  assert.ok(child > 1 && parent > 1);
  const reparented = await write(start.session_id, { chars: parent + "\n", yield_time_ms: 100 });
  assert.equal(reparented.status, "running");
  assert.match(reparented.output, /reparented/);
  const row = execFileSync("/bin/ps", ["-o", "ppid=,pgid=", "-p", String(child)], { encoding: "utf8" });
  const [newParent, group] = row.trim().split(/\s+/).map(Number);
  assert.notEqual(newParent, parent);
  assert.equal(group, child);
  await shutdown();
  await Promise.all([assertGone(root), assertGone(child)]);
});

test("shutdown reaps a sampled group member that calls setsid before the shell exits", { timeout: 5_000 }, async (t) => {
  const { exec, shutdown } = harness(t);
  const result = await exec({
    tty: false,
    shell: "/bin/sh",
    cmd: "trap 'exit 17' USR1; echo shell:$$; /usr/bin/perl -MPOSIX -MTime::HiRes -e '" +
      "$SIG{TERM}=q(IGNORE); $|=1; my $parent=getppid(); print qq(child:$$ group:), getpgrp(), qq(\n); " +
      "Time::HiRes::sleep(0.85); POSIX::setsid() != -1 or die $!; print qq(detached:), getpgrp(), qq(\n); " +
      "kill q(USR1), $parent or die $!; sleep 30' & wait",
    yield_time_ms: 3_000,
  });
  const root = Number(result.output.match(/shell:(\d+)/)?.[1]);
  const child = Number(result.output.match(/child:(\d+)/)?.[1]);
  t.after(() => cleanupPid(child));
  assert.equal(result.status, "exited");
  assert.equal(result.exit_code, 17);
  assert.match(result.output, new RegExp("^child:" + child + " group:" + root + "$", "m"));
  assert.match(result.output, new RegExp("^detached:" + child + "$", "m"));

  await shutdown();
  try {
    await assertGone(child);
  } catch (error) {
    t.diagnostic(execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,stat=", "-p", String(child)], { encoding: "utf8" }).trim());
    throw error;
  }
});

test("AbortSignal reaps an initial exec_command wait, preserves background sessions/output across poll aborts, and still honors pre-aborted kill", { timeout: 5_000 }, async (t) => {
  const { exec, ptySession, write } = harness(t);
  const pidFile = `/private/tmp/pi-codex-exec-abort-pid-${randomUUID()}.txt`;
  t.after(() => unlink(pidFile).catch(() => {}));

  const controller = new AbortController();
  const waiting = exec({ tty: false, cmd: `echo $$ > '${pidFile}'; exec sleep 30`, yield_time_ms: 120_000 }, controller.signal);
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(waiting, { name: "AbortError" });
  const initialPid = Number((await readFile(pidFile, "utf8")).trim());
  t.after(() => cleanupPid(initialPid));
  await assertGone(initialPid);

  const releaseFile = `/private/tmp/pi-codex-exec-abort-release-${randomUUID()}.txt`;
  t.after(() => unlink(releaseFile).catch(() => {}));
  const run = await exec({
    tty: false,
    shell: "/bin/sh",
    cmd: `echo $$; while [ ! -f '${releaseFile}' ]; do sleep 0.02; done; printf 'BUFFERED\\n'; exec sleep 30`,
    yield_time_ms: 100,
  });
  const pid = Number(run.output.trim());
  t.after(() => cleanupPid(pid));
  assert.equal(run.status, "running");

  // Release output after the initial read and confirm it reached the log without polling.
  await writeFile(releaseFile, "");
  await delay(300);
  assert.match(await readFile(run.full_output_path, "utf8"), /^BUFFERED$/m);

  const pollController = new AbortController();
  const polling = ptySession(run.session_id, { yield_time_ms: 120_000 }, pollController.signal);
  setTimeout(() => pollController.abort(), 50);
  await assert.rejects(polling, { name: "AbortError" });

  // Background process stays alive, unlocked, and retains unread output across poll/write wait aborts.
  const writeController = new AbortController();
  const writeWait = write(run.session_id, { yield_time_ms: 120_000 }, writeController.signal);
  setTimeout(() => writeController.abort(), 50);
  await assert.rejects(writeWait, { name: "AbortError" });

  const stillAlive = await ptySession(run.session_id, { yield_time_ms: 400 });
  assert.equal(stillAlive.status, "running");
  assert.match(stillAlive.output, /^BUFFERED$/m);

  // Explicit kill:true must still terminate the session even when the caller's signal is already aborted.
  const preAborted = new AbortController();
  preAborted.abort();
  const killed = await ptySession(run.session_id, { kill: true }, preAborted.signal);
  assert.equal(killed.status, "killed");
  await assertGone(pid);
  await assert.rejects(ptySession(run.session_id), /Unknown session_id/);
});

test("pty_session polls incremental output, terminates sessions, and rejects stdin chars or unknown parameters without writing to stdin", { timeout: 5_000 }, async (t) => {
  const { exec, ptySession, write } = harness(t);
  // 1. Live stdin reader proves rejected chars never reach the child's stdin.
  const reader = await exec({
    tty: false,
    shell: "/bin/sh",
    cmd: "printf 'READY\\n'; bytes=$(wc -c); printf 'BYTES:%d\\n' \"$bytes\"",
    yield_time_ms: 100,
  });
  assert.equal(reader.status, "running");
  assert.equal(reader.output, "READY\n");

  await assert.rejects(
    ptySession(reader.session_id, { chars: "injected" }),
    /pty_session does not accept parameter "chars"/,
  );
  await assert.rejects(
    ptySession(reader.session_id, { chars: "" }),
    /pty_session does not accept parameter "chars"/,
  );
  await assert.rejects(
    ptySession(reader.session_id, { extra: true }),
    /pty_session does not accept parameter "extra"/,
  );

  const second = "second\n";
  const written = await write(reader.session_id, { chars: second, yield_time_ms: 100 });
  assert.equal(written.status, "running");
  assert.equal(written.output, "");

  const eof = await write(reader.session_id, { chars: "\x04", yield_time_ms: 1_000 });
  assert.equal(eof.status, "exited");
  assert.equal(eof.exit_code, 0);
  assert.equal(eof.output, `BYTES:${Buffer.byteLength(second)}\n`);
  await assert.rejects(ptySession(reader.session_id), /Unknown session_id/);

  // 2. Normal incremental polling until natural exit.
  const start = await exec({
    tty: false,
    cmd: "printf 'STEP1\\n'; sleep 0.2; printf 'STEP2\\n'",
    yield_time_ms: 100,
  });
  assert.equal(start.status, "running");
  assert.equal(start.output, "STEP1\n");

  const done = await ptySession(start.session_id, { yield_time_ms: 2_000 });
  assert.equal(done.status, "exited");
  assert.equal(done.exit_code, 0);
  assert.equal(done.output, "STEP2\n");
  await assert.rejects(ptySession(start.session_id), /Unknown session_id/);
});

test("background session mirrors unbroken transcript across turns in real time", { timeout: 5_000 }, async (t) => {
  const { exec, write } = harness(t);
  const start = await exec({
    tty: false,
    cmd: "printf 'TURN1\\n'; read x; printf 'TURN2_START_%s_END\\n' '0123456789abcdefghijklmnopqrstuvwxyz'",
    yield_time_ms: 100,
  });
  assert.equal(start.status, "running");
  assert.equal(start.output, "TURN1\n");
  assert.equal(start.truncated, false);
  const logPath = trackLog(t, start.full_output_path);
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(logPath, "utf8"), "TURN1\n");

  const done = await write(start.session_id, { chars: "go\n", max_output_tokens: 6 });
  assert.equal(done.status, "exited");
  assert.equal(done.exit_code, 0);
  assert.equal(done.truncated, true);
  assert.equal(done.full_output_path, logPath);
  assert.ok(done.output.length <= 24);
  assert.doesNotMatch(done.output, /TURN1/);
  assert.equal(await readFile(logPath, "utf8"), "TURN1\nTURN2_START_0123456789abcdefghijklmnopqrstuvwxyz_END\n");
});

test("recreating a deleted live mirrored log file preserves 0600 permissions", { timeout: 5_000 }, async (t) => {
  const { exec, write } = harness(t);
  const start = await exec({
    tty: false,
    cmd: "printf 'BEFORE\\n'; read x; printf 'AFTER\\n'",
    yield_time_ms: 100,
  });
  assert.equal(start.status, "running");
  const logPath = trackLog(t, start.full_output_path);
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);

  await unlink(logPath);
  await assert.rejects(stat(logPath), { code: "ENOENT" });

  const done = await write(start.session_id, { chars: "go\n" });
  assert.equal(done.status, "exited");
  assert.equal(done.exit_code, 0);
  assert.equal(done.full_output_path, logPath);
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(logPath, "utf8"), "AFTER\n");
});

test("pruneStaleLogs deletes only stale generated logs, preserves unrelated filenames and live session logs", { timeout: 5_000 }, async (t) => {
  const staleGenerated = `/private/tmp/pi-codex-exec-p1z-${randomUUID()}.log`;
  const freshGenerated = `/private/tmp/pi-codex-exec-p2z-${randomUUID()}.log`;
  const staleUnrelated = "/private/tmp/pi-codex-exec-test-stale.log";
  const staleUppercase = `/private/tmp/PI-CODEX-EXEC-P1-${randomUUID().toUpperCase()}.log`;
  const staleP0 = `/private/tmp/pi-codex-exec-p0-${randomUUID()}.log`;
  const staleNonV4 = "/private/tmp/pi-codex-exec-p1-11111111-1111-1111-1111-111111111111.log";
  const allTemp = [staleGenerated, freshGenerated, staleUnrelated, staleUppercase, staleP0, staleNonV4];
  await Promise.all(allTemp.map((p) => writeFile(p, p, { mode: 0o600 })));
  t.after(() => Promise.all(allTemp.map((p) => unlink(p).catch(() => {}))));

  const { exec } = harness(t);
  const live = await exec({ tty: false, cmd: "echo live; sleep 30", yield_time_ms: 100 });
  assert.equal(live.status, "running");
  const liveLog = trackLog(t, live.full_output_path);

  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await Promise.all([staleGenerated, staleUnrelated, staleUppercase, staleP0, staleNonV4, liveLog].map((p) => utimes(p, oldDate, oldDate)));

  pruneStaleLogs(24 * 60 * 60 * 1000);
  await assert.rejects(stat(staleGenerated), { code: "ENOENT" });
  assert.equal(await readFile(freshGenerated, "utf8"), freshGenerated);
  assert.equal(await readFile(staleUnrelated, "utf8"), staleUnrelated);
  assert.equal(await readFile(staleUppercase, "utf8"), staleUppercase);
  assert.equal(await readFile(staleP0, "utf8"), staleP0);
  assert.equal(await readFile(staleNonV4, "utf8"), staleNonV4);
  assert.equal(await readFile(liveLog, "utf8"), "live\n");
});

test("buildSeatbeltProfile is undefined when off and covers sensitive defaults when enabled", () => {
  assert.equal(buildSeatbeltProfile({ mode: "off" }), undefined);
  const sb = buildSeatbeltProfile({ mode: "protect-sensitive", denyWritePaths: ["/private/tmp/custom-deny"] });
  assert.ok(sb);
  assert.match(sb, /\(version 1\)/);
  assert.match(sb, /\.pi\/agent\/sessions/);
  assert.match(sb, /pi-permission-system/);
  assert.match(sb, /\.ssh/);
  assert.match(sb, /\/private\/tmp\/custom-deny/);
});

test("protect-sensitive Seatbelt sandbox blocks direct and indirect writes in PTY and pipe modes while allowing reads and workspace writes", { timeout: 10_000, skip: process.platform !== "darwin" }, async (t) => {
  const root = await mkdtemp("/private/tmp/pi-codex-exec-sb-");
  const protectedDir = root + "/protected";
  const workDir = root + "/work";
  await mkdir(protectedDir);
  await mkdir(workDir);
  await writeFile(protectedDir + "/secret.txt", "readable-secret\n");
  t.after(() => rm(root, { recursive: true, force: true }));

  const { exec } = harness(t, { cwd: workDir }, { mode: "protect-sensitive", denyWritePaths: [protectedDir] });
  for (const tty of [true, false]) {
    const okWrite = await exec({ tty, cmd: `printf 'ok-%s' '${tty}' > '${workDir}/ok-${tty}.txt' && cat '${protectedDir}/secret.txt'` });
    assert.equal(okWrite.status, "exited");
    assert.equal(okWrite.exit_code, 0);
    assert.match(okWrite.output, /readable-secret/);
    assert.equal(await readFile(`${workDir}/ok-${tty}.txt`, "utf8"), `ok-${tty}`);

    const blocked = await exec({ tty, cmd: `/usr/bin/python3 -c "open('${protectedDir}/pwn-${tty}.txt', 'w').write('nope')"` });
    assert.equal(blocked.status, "exited");
    assert.notEqual(blocked.exit_code, 0);
    assert.match(blocked.output, /Operation not permitted|PermissionError/i);
    await assert.rejects(stat(`${protectedDir}/pwn-${tty}.txt`), { code: "ENOENT" });
  }
});

test("expandSandboxPath expands ~/, rejects relative paths, and buildSeatbeltProfile resolves symlinked ancestors for nonexistent targets", () => {
  assert.equal(expandSandboxPath("~/Dev/agents/pi-memory-data", "/Users/tester"), "/Users/tester/Dev/agents/pi-memory-data");
  assert.equal(expandSandboxPath("~", "/Users/tester"), "/Users/tester");
  assert.throws(() => expandSandboxPath("relative/path", "/Users/tester"), /must be absolute or start with ~\//);
  assert.throws(() => expandSandboxPath("", "/Users/tester"), /Invalid sandbox denyWritePath/);

  const sb = buildSeatbeltProfile({
    mode: "protect-sensitive",
    denyWritePaths: ["~/custom-data", "/tmp/nonexistent-ancestor-probe-42/nested"],
  }, "/Users/tester");
  assert.ok(sb);
  assert.match(sb, /\(subpath "\/Users\/tester\/custom-data"\)/);
  assert.doesNotMatch(sb, /~\/custom-data/);
  if (process.platform === "darwin") {
    assert.match(sb, /\(subpath "\/private\/tmp\/nonexistent-ancestor-probe-42\/nested"\)/);
  }
});

test("resolveSandboxConfig reports malformed config, invalid entries, and env override precedence", async (t) => {
  const dir = await mkdtemp("/private/tmp/pi-codex-exec-cfg-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const badJson = dir + "/bad.json";
  await writeFile(badJson, "{not-json");
  const bad = resolveSandboxConfig(undefined, { configPath: badJson, env: {}, home: "/Users/tester" });
  assert.equal(bad.mode, "off");
  assert.equal(bad.source, "default");
  assert.ok(bad.warnings.some((w) => /Failed to parse sandbox config/.test(w)));

  const goodJson = dir + "/good.json";
  await writeFile(goodJson, JSON.stringify({
    sandbox: "protect-sensitive",
    denyWritePaths: ["~/protected", "relative/bad"],
  }));
  const loaded = resolveSandboxConfig(undefined, { configPath: goodJson, env: {}, home: "/Users/tester" });
  assert.equal(loaded.mode, "protect-sensitive");
  assert.equal(loaded.source, "config");
  assert.deepEqual(loaded.denyWritePaths, ["/Users/tester/protected"]);
  assert.ok(loaded.warnings.some((w) => /must be absolute/.test(w)));

  const typoJson = dir + "/typo.json";
  await writeFile(typoJson, JSON.stringify({ sandBox: "protect-sensitive", denyWritePath: ["~/x"] }));
  const typo = resolveSandboxConfig(undefined, { configPath: typoJson, env: {}, home: "/Users/tester" });
  assert.equal(typo.mode, "off");
  assert.equal(typo.source, "default");
  assert.ok(typo.warnings.some((w) => /Unknown sandbox config key.*"sandBox"/.test(w)));
  assert.ok(typo.warnings.some((w) => /Unknown sandbox config key.*"denyWritePath"/.test(w)));

  const envOver = resolveSandboxConfig(undefined, {
    configPath: goodJson,
    env: { PI_CODEX_EXEC_SANDBOX: "off" },
    home: "/Users/tester",
  });
  assert.equal(envOver.mode, "off");
  assert.equal(envOver.source, "env");
});

const printCtx = {
  cwd: process.cwd(),
  hasUI: false,
  mode: "print",
  ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
};

function capturePrintOutput(t) {
  const output = { stdout: "", stderr: "" };
  t.mock.method(process.stderr, "write", (chunk) => {
    output.stderr += chunk;
    return true;
  });
  // Model Pi's stdout guard and capture writes to the underlying stdout stream.
  t.mock.method(process.stdout, "write", (chunk) => process.stderr.write(chunk));
  const write = Writable.prototype.write;
  t.mock.method(Writable.prototype, "write", function (chunk, ...args) {
    if (this !== process.stdout) return write.call(this, chunk, ...args);
    output.stdout += chunk;
    return true;
  });
  return output;
}

test("print emits session_start sandbox config warnings to stderr", (t) => {
  const output = capturePrintOutput(t);
  const { sessionStart } = harness(t, printCtx, { mode: "off", denyWritePaths: ["relative/path"] });
  sessionStart();
  assert.match(output.stderr, /pi-codex-exec sandbox config warning/);
  assert.match(output.stderr, /must be absolute or start with ~\//);
  assert.equal(output.stdout, "");
});

test("print emits the /sandbox off refusal to stderr", async (t) => {
  const output = capturePrintOutput(t);
  const { sandbox } = harness(t, printCtx, { mode: "protect-sensitive" });
  await sandbox("off");
  assert.match(output.stderr, /Refused: \/sandbox off requires an interactive TUI session/);
  assert.equal(output.stdout, "");
});

test("print emits the /sandbox status report with all effective protected paths to stdout", async (t) => {
  const output = capturePrintOutput(t);
  const customPath = "/tmp/pi-codex-exec-status-protected";
  const { sandbox, sessionStart } = harness(t, printCtx, {
    mode: "protect-sensitive",
    denyWritePaths: [customPath, "relative/path"],
  });
  sessionStart();
  const startupWarnings = output.stderr;
  await sandbox("status");
  const effectivePaths = resolveProtectedWritePaths([customPath]);
  assert.match(output.stdout, /mode: protect-sensitive/);
  assert.match(output.stdout, /source: override/);
  const lines = output.stdout.split("\n");
  assert.ok(lines.includes(`  effective protected paths (${effectivePaths.length}):`));
  assert.deepEqual(lines.filter((line) => line.startsWith("    - ")), effectivePaths.map((path) => `    - ${path}`));
  assert.equal(output.stderr, startupWarnings);
});

test("/sandbox hot-toggles subsequent exec_command calls, rejects headless and RPC off, clips widget width, and tracks per-PTY status accurately", { timeout: 10_000, skip: process.platform !== "darwin" }, async (t) => {
  const root = await mkdtemp("/private/tmp/pi-codex-exec-toggle-");
  const protectedDir = root + "/protected";
  await mkdir(protectedDir);
  t.after(() => rm(root, { recursive: true, force: true }));

  const statuses = [];
  const widgets = [];
  const notes = [];
  const ui = {
    setStatus: (key, status) => statuses.push({ key, status }),
    setWidget: (key, content, opts) => {
      const component = typeof content === "function" ? content({}, { fg: (_r, text) => text }) : undefined;
      widgets.push({ key, component, lines: component ? component.render(120) : content, opts });
    },
    notify: (text, level) => notes.push({ text, level }),
  };
  const interactiveCtx = { cwd: root, hasUI: true, mode: "tui", ui };
  const rpcCtx = { cwd: root, hasUI: true, mode: "rpc", ui };
  const headlessCtx = { cwd: root, hasUI: false, mode: "print", ui };

  const { exec, ptySession, sandbox, sessionStart } = harness(
    t,
    interactiveCtx,
    { mode: "protect-sensitive", denyWritePaths: [protectedDir] },
  );

  sessionStart();
  assert.equal(statuses.at(-1)?.status, "SB • /pty");
  assert.equal(widgets.at(-1)?.opts?.placement, "belowEditor");
  assert.match(widgets.at(-1)?.lines?.[0] ?? "", /SB on \(protect-sensitive\)/);
  assert.ok((widgets.at(-1)?.component.render(20)[0] ?? "").length <= 20);
  assert.equal(widgets.at(-1)?.component.render(0)[0], "");

  // Headless (print) and RPC (hasUI:true, mode:"rpc") callers cannot disable sandbox.
  const stderrWrite = t.mock.method(process.stderr, "write", () => true);
  try {
    await sandbox("off", headlessCtx);
    await sandbox("off", rpcCtx);
  } finally {
    stderrWrite.mock.restore();
  }
  assert.equal(stderrWrite.mock.callCount(), 2);
  for (const { arguments: [message] } of stderrWrite.mock.calls) {
    assert.match(message, /interactive TUI/i);
  }
  assert.deepEqual(notes, []);
  assert.equal(statuses.at(-1)?.status, "SB • /pty");

  await sandbox("status", rpcCtx);
  assert.match(notes.at(-1)?.text ?? "", /mode: protect-sensitive/);
  assert.equal(notes.at(-1)?.level, "info");

  // Start a sandboxed background PTY while sandbox is ON.
  const bg = await exec({ tty: true, cmd: "echo ready; sleep 30", yield_time_ms: 150 });
  assert.equal(bg.status, "running");
  assert.equal(statuses.at(-1)?.status, "1 PTY [SB] • /pty");

  // Interactive TUI operator turns sandbox OFF: status must reflect mixed state (old PTY still SB, next is off).
  await sandbox("off", interactiveCtx);
  assert.match(statuses.at(-1)?.status ?? "", /1 PTY \(1\/1 SB\) • next:off • \/pty/);
  assert.match(widgets.at(-1)?.lines?.[0] ?? "", /SB off \(runtime\).*1 PTY \(1\/1 SB\)/);
  assert.ok((widgets.at(-1)?.component.render(30)[0] ?? "").length <= 30);

  // New command now writes to protectedDir freely.
  const allowed = await exec({ tty: false, cmd: `printf 'ok' > '${protectedDir}/after-off.txt'` });
  assert.equal(allowed.status, "exited");
  assert.equal(allowed.exit_code, 0);
  assert.equal(await readFile(`${protectedDir}/after-off.txt`, "utf8"), "ok");

  // Turn sandbox back ON: next command is blocked by kernel again.
  await sandbox("on", interactiveCtx);
  assert.equal(statuses.at(-1)?.status, "1 PTY [SB] • /pty");
  const blocked = await exec({ tty: false, cmd: `printf 'no' > '${protectedDir}/after-on.txt'` });
  assert.equal(blocked.status, "exited");
  assert.notEqual(blocked.exit_code, 0);
  assert.match(blocked.output, /Operation not permitted/i);
  await assert.rejects(stat(`${protectedDir}/after-on.txt`), { code: "ENOENT" });

  await sandbox("status", interactiveCtx);
  assert.match(notes.at(-1)?.text ?? "", /mode: protect-sensitive/);
  assert.match(notes.at(-1)?.text ?? "", /source: runtime/);
  assert.match(notes.at(-1)?.text ?? "", /effective protected paths/);
  assert.match(notes.at(-1)?.text ?? "", /\.ssh/);
  assert.match(notes.at(-1)?.text ?? "", new RegExp(protectedDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await ptySession(bg.session_id, { kill: true });
  assert.equal(statuses.at(-1)?.status, "SB • /pty");
});

test("widget reports actual non-runtime source when mode is off and a background PTY is running", { timeout: 5_000 }, async (t) => {
  const widgets = [];
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      setStatus: () => {},
      setWidget: (key, content, opts) => {
        const component = typeof content === "function" ? content({}, { fg: (role, text) => `${role}:${text}` }) : undefined;
        widgets.push({ key, lines: component ? component.render(120) : content, opts });
      },
      notify: () => {},
    },
  };
  const { exec, ptySession } = harness(t, ctx, { mode: "off" });
  const bg = await exec({ tty: true, cmd: "echo hi; sleep 30", yield_time_ms: 150 });
  assert.equal(bg.status, "running");
  assert.match(widgets.at(-1)?.lines?.[0] ?? "", /^dim:  SB off \(override\)/);
  assert.doesNotMatch(widgets.at(-1)?.lines?.[0] ?? "", /runtime/);
  await ptySession(bg.session_id, { kill: true });
  assert.equal(widgets.at(-1)?.lines, undefined);
});
