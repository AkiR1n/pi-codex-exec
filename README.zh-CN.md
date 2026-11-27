# pi-codex-exec

[English](README.md) | 简体中文

面向 [Pi coding agent](https://pi.dev) 的轻量级、单轨 **PTY 统一命令执行**扩展（`exec_command` + `pty_session` + `write_stdin`）。

相比同时维护阻塞式内置 `bash` 与独立的交互终端插件，`pi-codex-exec` 用一组可组合原语——`exec_command`、只读轮询/终止工具 `pty_session` 与交互输入工具 `write_stdin`——统一承载短命令同步执行与长任务/交互式 PTY 会话。它在 TUI、无头 `pi -p` 和子代理下行为完全一致，内置会话级实时全量日志镜像、后代进程树回收，以及可选的 macOS Seatbelt（`sandbox-exec`）内核级敏感目录写保护。

## 核心特性

- **单轨统一模型 + 清晰权限分离**：短命令在 `yield_time_ms` 窗口内同步返回退出码和输出；长任务或交互程序（REPL、调试器、开发服务器、SSH）自动切后台并返回 `session_id`，由 `pty_session` 轮询或停止（物理上不能写 stdin），仅在需要交互输入时调用 `write_stdin`。
- **原生对接 `@gotgenes/pi-permission-system`**：标准的 `cmd` / `workdir` 参数可直接挂进 `shellTools`，安全命令 0 ms 快速放行，高危命令走完整 bash AST 细粒度拦截；`pty_session` 可静态配置为 `allow`，权限门禁 0 ms 放行，轮询仍等待设定的时间窗口或进程退出。`write_stdin` 维持 `"ask"`。
- **实时全量会话日志镜像（`full_output_path`）**：未截断的短命令纯内存处理、零临时文件垃圾；任何后台长会话或发生截断的输出，都会把从 byte 0 开始的完整转录实时镜像到 `/private/tmp` 下的 `0600` 日志文件，模型可直接 `read(full_output_path)` 回查完整内容而无需重跑命令。超过 24 小时的旧日志会在启动时自动机会性清理。
- **进程树回收**：在 250 ms 周期采样中按 PID + 启动时间追踪观察到的包含 `setsid()` 与重挂载的后代进程，在退出、`kill: true`、`exec_command` 初始等待被 `AbortSignal` 取消或 `session_shutdown` 时按 `SIGTERM` → `SIGKILL` 回收（后台轮询等待被取消仅结束本次等待，不会误杀正在运行的后台进程；若短命孤儿进程在两次 250 ms 采样间隙内脱离并重挂载且父进程随即退出，则无法保证捕获）。
- **可选 macOS Seatbelt 写保护**：通过环境变量 `PI_CODEX_EXEC_SANDBOX=protect-sensitive` 灰度开启，在保持工作区与 `/tmp` 正常读写的同时，由 macOS 内核硬拦截对敏感目录（`~/.ssh`、`~/.pi/agent/sessions`、`~/.pi/agent/auth.json`、权限配置等）的直接或间接写入。
- **极简依赖**：约 900 行 TypeScript，仅依赖单个原生 PTY 包 `zigpty`。

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
    "pty_session": "allow",
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

### 3. macOS Seatbelt 写保护（`protect-sensitive`，暂仅支持 macOS）

> **平台说明**：内核级写保护基于 macOS `/usr/bin/sandbox-exec`（Seatbelt）实现，**目前仅支持 macOS**。Linux / Windows 环境下请保持默认 `off`。

- **通过环境变量控制**（优先级高于配置文件）：
  ```sh
  PI_CODEX_EXEC_SANDBOX=protect-sensitive \
  PI_CODEX_EXEC_SANDBOX_DENY_WRITE="$HOME/my-private-data" \
  pi
  ```
- **通过可选配置文件持久开启**（`~/.pi/agent/extensions/pi-codex-exec.json`，支持 `~/` 家目录展开）：
  ```json
  {
    "sandbox": "protect-sensitive",
    "denyWritePaths": ["~/my-private-data"]
  }
  ```
- **运行中热切换（无需重启 Pi）**：
  - `/sandbox status`（或 `/sandbox`）：查看当前沙箱模式、来源（`config` / `env` / `runtime` / `default`）、生效保护路径、各后台 PTY 沙箱状态与配置告警；
  - `/sandbox on`：立即对后续新启动的 `exec_command` 开启 `protect-sensitive`；
  - `/sandbox off`：对后续新启动的 `exec_command` 临时关闭沙箱（仅限交互式 TUI 操作者，无头 / RPC 模式下拒绝关闭）；已运行的旧后台 PTY 保留其启动时的策略并在状态栏准确标注。

启用后，对 `~/.pi/agent/sessions`、`~/.pi/agent/auth.json`、`~/.pi/agent/extensions/pi-permission-system` 与 `~/.pi/agent/extensions/pi-permission-auto-review`、`~/.config/magpie`、`~/.ssh`、`~/.gnupg`、`~/.aws` 以及自定义 `denyWritePaths` 的任意写入都会被 macOS 内核拒绝（`Operation not permitted`），但仍保留正常只读访问（如 `ssh` 读取 `~/.ssh/config`）；状态栏会显示 `SB • /pty`（或 `N PTY [SB] • /pty`，热切混合状态时显示精确计数）便于区分。

## 工具与命令速查

| 入口 | 参数 / 用法 | 说明 |
| --- | --- | --- |
| `exec_command` | `cmd`, `workdir?`, `tty?` (`true`), `shell?` (`/bin/zsh`), `login?` (`false`), `yield_time_ms?` (`10000`, 范围 `100..120000`), `max_output_tokens?` (`10000`) | 返回 `{ status, output, wall_time_ms, truncated, exit_code? \| session_id?, full_output_path? }`；非零退出码不抛异常 |
| `pty_session` | `session_id`, `kill?` (`false`), `yield_time_ms?` (`5000`), `max_output_tokens?` (`10000`) | 只读轮询后台输出或终止进程树；Schema 与运行时严格拒绝 `chars` 和未知参数 |
| `write_stdin` | `session_id`, `chars?` (`""`), `kill?` (`false`), `yield_time_ms?` (`5000`), `max_output_tokens?` (`10000`) | 向交互会话发送 `\n`、`\x03`（Ctrl+C）、`\x04`（Ctrl+D）；始终返回完整会话 `full_output_path` |
| `/pty` | `/pty`, `/pty list`, `/pty tail <id>`, `/pty kill <id\|all>` | 在 Pi TUI 中查看（含各会话 `[SB]`/`[off]` 状态）与清理后台会话 |
| `/sandbox` | `/sandbox [status \| on \| off]` | 运行中查看或热切换 macOS Seatbelt 写保护（`off` 仅限交互式 TUI） |

## 运行测试

```sh
npm test
```

包含 27 条单元与集成测试，覆盖原生 PTY、管道、`pty_session` 轮询/终止/运行时拒写校验、Ctrl+C/Ctrl+D、跨轮 ANSI 转义归一化、UTF-8 安全截断、跨轮实时全量日志镜像、24 小时旧日志清理、`setsid` 后代回收、`AbortSignal`、`~/` 与符号链接祖先路径解析、配置告警（含未知键检测）、`/sandbox` 运行中热切换（含 RPC/无头拒绝与窄屏宽度安全截断）以及 macOS `sandbox-exec` 内核写拦截。

## 参考声明

- `exec_command` / `pty_session` / `write_stdin` 工具接口受 OpenAI Codex CLI 等现代终端编码 Agent 的统一 PTY 执行模型启发（并将轮询/终止拆出到 `pty_session` 以适配细粒度权限门禁），基于 [`zigpty`](https://www.npmjs.com/package/zigpty) 面向 [Pi](https://pi.dev) 独立实现。
- 本项目为独立社区扩展，与 OpenAI 或 Pi 官方无隶属或背书关系。

## 开源协议

[MIT](LICENSE)
