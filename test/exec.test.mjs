import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import register, { buildSeatbeltProfile, createExecution, pruneStaleLogs } from "../index.ts";

function harness(t, ctx = { cwd: process.cwd() }, sandboxOverride = { mode: "off" }) {
  const { execTool, writeTool, ptyCommand, shutdown } = createExecution(sandboxOverride);
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
    write: (session_id, params, signal) => call(writeTool, { session_id, ...params }, signal),
    pty: (args) => ptyCommand.handler(args, ctx),
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
  assert.equal(notices.at(-1), first.session_id + " PTY\n" + second.session_id + " PTY");
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
  let shutdown;
  register({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on(event, handler) {
      assert.equal(event, "session_shutdown");
      shutdown = handler;
    },
  });
  t.after(shutdown);
  const exec = tools.get("exec_command").execute;
  const write = tools.get("write_stdin").execute;
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

test("AbortSignal cancels an initial wait and a background poll", { timeout: 5_000 }, async (t) => {
  const { exec, write } = harness(t);
  const controller = new AbortController();
  const waiting = exec({ cmd: "exec sleep 30", yield_time_ms: 120_000 }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(waiting, { name: "AbortError" });
  const run = await exec({ cmd: "echo $$; exec sleep 30", yield_time_ms: 100 });
  const pollController = new AbortController();
  const polling = write(run.session_id, { yield_time_ms: 120_000 }, pollController.signal);
  pollController.abort();
  await assert.rejects(polling, { name: "AbortError" });
  await assertGone(Number(run.output.trim()));
  await assert.rejects(write(run.session_id), /Unknown session_id/);
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
