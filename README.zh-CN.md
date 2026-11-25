# pi-codex-exec

[English](README.md) | 简体中文

面向 [Pi coding agent](https://pi.dev) 的轻量级、单轨 **Codex 风格统一命令执行**扩展。

相比同时维护阻塞式内置 `bash` 与独立的交互终端插件，`pi-codex-exec` 用一对可组合原语——`exec_command` 与 `write_stdin`——统一承载短命令同步执行与长任务/交互式 PTY 会话。它在 TUI、无头 `pi -p` 和子代理下行为完全一致，内置会话级实时全量日志镜像、严格的后代进程树回收，以及可选的 macOS Seatbelt（`sandbox-exec`）内核级敏感目录写保护。

## 核心特性

- **单轨统一模型**：短命令在 `yield_time_ms` 窗口内同步返回退出码和输出；长任务或交互程序（REPL、调试器、开发服务器、SSH）自动切后台并返回 `session_id`，由 `write_stdin` 续读或输入。模型不再需要在 `bash` 和另一套交互终端工具之间纠结。
- **原生对接 `@gotgenes/pi-permission-system`**：标准的 `cmd` / `workdir` 参数可直接挂进 `shellTools`，安全命令 0 ms 快速放行，高危命令走完整 bash AST 细粒度拦截。
- **实时全量会话日志镜像（`full_output_path`）**：未截断的短命令纯内存处理、零临时文件垃圾；任何后台长会话或发生截断的输出，都会把从 byte 0 开始的完整转录实时镜像到 `/private/tmp` 下的 `0600` 日志文件，模型可直接 `read(full_output_path)` 回查完整内容而无需重跑命令。超过 24 小时的旧日志会在启动时自动机会性清理。
- **严格进程树回收**：按 PID + 启动时间追踪包含 `setsid()` 与重挂载的后代进程，在退出、`kill: true`、`AbortSignal` 或 `session_shutdown` 时按 `SIGTERM` → `SIGKILL` 彻底回收。
- **可选 macOS Seatbelt 写保护**：通过环境变量 `PI_CODEX_EXEC_SANDBOX=protect-sensitive` 灰度开启，在保持工作区与 `/tmp` 正常读写的同时，由 macOS 内核硬拦截对敏感目录（`~/.ssh`、`~/.pi/agent/sessions`、`~/.pi/agent/auth.json`、权限配置等）的直接或间接写入。
- **极简依赖**：约 800 行 TypeScript，仅依赖单个原生 PTY 包 `zigpty`。

## 安装与配置

### 1. 安装依赖并在 Pi 中启用

```sh
git clone https://github.com/AkiR1n/pi-codex-exec.git ~/.pi/vendor/pi-codex-exec
cd ~/.pi/vendor/pi-codex-exec
npm install
```

在 `~/.pi/agent/settings.json` 中禁用内置 `bash` 并注册本扩展：

```json
{
  "defaultTools": ["+codemode", "+grep", "+find", "-bash"],
  "packages": [
    "/absolute/path/to/pi-codex-exec"
  ]
}
```

### 2. 对接 `@gotgenes/pi-permission-system`（推荐）

在 `~/.pi/agent/extensions/pi-permission-system/config.json` 中通过 `shellTools` 映射 `exec_command`：

```json
{
  "permission": {
    "write_stdin": "ask"
  },
  "shellTools": {
    "exec_command": {
      "commandArgument": "cmd",
      "workdirArgument": "workdir"
    }
  }
}
```

### 3. 开启 macOS Seatbelt 灰度写保护（默认关闭）

- **通过环境变量灰度启动**（适合独立 shell 别名如 `pisb`，与日常 `pi` 并行灰度）：
  ```sh
  PI_CODEX_EXEC_SANDBOX=protect-sensitive \
  PI_CODEX_EXEC_SANDBOX_DENY_WRITE="$HOME/my-private-data" \
  pi
  ```
- **通过可选配置文件持久开启**（`~/.pi/agent/extensions/pi-codex-exec.json`）：
  ```json
  {
    "sandbox": "protect-sensitive",
    "denyWritePaths": ["/Users/you/path/to/protect"]
  }
  ```

启用后，对 `~/.pi/agent/sessions`、`~/.pi/agent/auth.json`、`~/.pi/agent/extensions/pi-permission-*`、`~/.config/magpie`、`~/.ssh`、`~/.gnupg`、`~/.aws` 以及自定义 `denyWritePaths` 的任意写入都会被 macOS 内核拒绝（`Operation not permitted`），但仍保留正常只读访问（如 `ssh` 读取 `~/.ssh/config`）；状态栏会显示 `SB • /pty`（或 `N PTY [SB] • /pty`）便于区分。

## 工具与命令速查

| 入口 | 参数 / 用法 | 说明 |
| --- | --- | --- |
| `exec_command` | `cmd`, `workdir?`, `tty?` (`true`), `shell?` (`/bin/zsh`), `login?` (`false`), `yield_time_ms?` (`10000`, 范围 `100..120000`), `max_output_tokens?` (`10000`) | 返回 `{ status, output, wall_time_ms, truncated, exit_code? \| session_id?, full_output_path? }`；非零退出码不抛异常 |
| `write_stdin` | `session_id`, `chars?` (`""`), `kill?` (`false`), `yield_time_ms?` (`5000`), `max_output_tokens?` (`10000`) | 支持 `\n`、`\x03`（Ctrl+C）、`\x04`（Ctrl+D）；空输入即轮询新输出；始终返回完整会话 `full_output_path` |
| `/pty` | `/pty`, `/pty list`, `/pty tail <id>`, `/pty kill <id\|all>` | 在 Pi TUI 中查看与清理后台会话 |

## 运行测试

```sh
npm test
```

包含 21 条单元与集成测试，覆盖原生 PTY、管道、Ctrl+C/Ctrl+D、跨轮 ANSI 转义归一化、UTF-8 安全截断、跨轮实时全量日志镜像、24 小时旧日志清理、`setsid` 后代回收、`AbortSignal` 以及 macOS `sandbox-exec` 内核写拦截。

## 开源协议

[MIT](LICENSE)
