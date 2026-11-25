# pi-codex-exec

- `exec_command` runs `cmd` in a native PTY by default. Set `tty: false` for pipes. It waits up to `yield_time_ms` (default 10 s), then returns an exit code or a session ID.
- `write_stdin` sends `chars` to a session and reads new output, or polls with empty input (default wait 5 s). Use `\n` to submit a line, `\x03` for Ctrl+C, `\x04` for Ctrl+D, or `kill: true` to terminate the tree.
- Both tools return structured results and readable text. Waits clamp to 100–120,000 ms. Background sessions and truncated outputs mirror the unbroken session transcript in real time to a `0600` log file under `/private/tmp` (`full_output_path`), and stale logs older than 24 h are pruned opportunistically on startup.
- Use `/pty` or `/pty list`, `/pty tail <id>`, `/pty kill <id>`, and `/pty kill all`. Shutdown and cancellation terminate the affected sessions. Exit clears jobs left in the shell’s process group. Exited background sessions can be collected for five minutes.

## Known limitations

With `@gotgenes/pi-permission-system` `shellTools` configured for `exec_command`, command globs apply on the `bash` surface while `write_stdin` stays tool-level `ask`. PTY output is a text transcript. Returned logs persist on disk for 24 h before opportunistic pruning.
