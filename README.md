# pi-codex-exec

- `exec_command` runs `cmd` in a native PTY by default. Set `tty: false` for pipes. It waits up to `yield_time_ms` (default 10 s), then returns an exit code or a session ID.
- `write_stdin` sends `chars` to a session and reads new output, or polls with empty input (default wait 5 s). Use `\n` to submit a line, `\x03` for Ctrl+C, `\x04` for Ctrl+D, or `kill: true` to terminate the tree.
- Both tools return structured results and readable text. Waits clamp to 100–120,000 ms. Large output includes a head and tail preview and a complete normalized log for that call under `/private/tmp`.
- Use `/pty` or `/pty list`, `/pty tail <id>`, `/pty kill <id>`, and `/pty kill all`. Shutdown and cancellation terminate the affected sessions. Exit clears jobs left in the shell’s process group. Exited background sessions can be collected for five minutes.

## Known limitations

The permission plugin supports tool-level `ask` for these two tools, with command globs available on its built-in `bash` surface. PTY output is a text transcript. Processes that already reparented and escaped the group can outlive the session. Returned logs persist on disk.
