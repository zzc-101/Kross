# 命令手册

在 TUI 输入 `/help` 可查看当前版本支持的命令。命令建议会根据输入和当前状态动态显示。

## 常用命令

| 命令 | 说明 |
|---|---|
| `/help` | 显示完整命令帮助 |
| `/settings` | 打开模型与思考强度面板 |
| `/model` | 打开模型与思考强度面板 |
| `/model <modelId>` | 切换当前 Provider 的模型 |
| `/mode auto|plan|conductor` | 切换工作模式 |
| `/status` | 显示当前模式、权限和模型 |
| `/lang zh|en` | 切换并保存界面语言 |

## Workspace

| 命令 | 说明 |
|---|---|
| `/add-dir <path>` | 添加一个授权 workspace root |
| `/dirs` | 列出所有 roots 及其 id |
| `/remove-dir <id|path>` | 移除非主 root |

添加或移除 root 后，Project Instructions 和 Skills 会刷新。主 root 不能通过该命令移除。

## 会话与执行

| 命令 | 说明 |
|---|---|
| `/resume` | 打开最近会话选择器 |
| `/resume <sessionId>` | 直接恢复指定会话 |
| `/approve` | 批准待执行的 plan/conductor 计划 |
| `/reject` | 取消待执行计划 |
| `/undo` | 撤销最近一个可逆文件事务 |
| `/undo <runId>` | 逆序撤销指定 run 的文件事务 |
| `/undo <transactionId>` | 撤销指定事务 |
| `/processes` | 列出当前会话可见的后台进程 |

工具审批由独立面板处理，不使用 `/approve`；面板中选择 Approve 或 Reject。

## 检查与诊断

| 命令 | 说明 |
|---|---|
| `/context` | 显示 token 预算、上下文 sections 和来源状态 |
| `/compact [要求]` | 手动压缩旧上下文，可附加保真要求 |
| `/instructions` | 刷新并显示 Project Instructions 来源与诊断 |
| `/skills` | 刷新并显示 Skill metadata 与诊断 |
| `/trace` | 列出最近运行 |
| `/trace <runId>` | 显示指定运行的 trace 摘要 |
| `/diff [runId]` | 显示文件触达和 Git diff 摘要 |
| `/expand` | 展开或折叠最近一条可折叠消息 |

## 权限与导入

| 命令 | 说明 |
|---|---|
| `/perm default` | 读操作自动允许，其他风险请求确认 |
| `/perm classifier` | 工作区写入自动允许；危险 shell 拒绝，其他执行/网络请求确认 |
| `/perm auto` | 所有工具调用自动允许 |
| `/import claude` | 导入检测到的 Claude Code 配置 |
| `/import codex` | 导入检测到的 Codex 配置 |
| `/import skip` | 关闭首次导入提示 |

权限模式不会跨重启恢复，重新启动后回到 `default`。`auto` 不等同于沙箱，使用前应阅读 [安全模型](security.md)。

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+P` | 打开或关闭模型设置 |
| `Shift+Tab` | 循环切换权限模式 |
| `Ctrl+O` | 展开或折叠最近一条 thinking |
| `Ctrl+E` | 展开或折叠最近工具组 |
| `Esc` | 中断当前运行，或取消待确认计划 |
| `Ctrl+C` | 中断当前运行并退出 |
| `PageUp` / `PageDown` | 滚动消息视口 |
| `Ctrl+↑` / `Ctrl+↓` | 滚动消息视口 |

审批面板中：

- `←` / `→` / `Tab`：切换 Approve 与 Reject。
- `Enter`：确认当前选择。
- `a`：批准。
- `r`：拒绝。
