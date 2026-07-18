# 安全模型

Kross 是本地优先的开发 Agent，但当前不是完整沙箱。它通过 workspace 边界、工具风险分类、显式审批、可审计 trace 和冲突安全撤销降低风险。

## 信任边界

Kross 会把以下内容提供给模型，应该视为受信任的本地输入：

- 用户消息和恢复后的会话上下文。
- 已授权 workspace 中的代码与文件。
- 根目录的 `CLAUDE.md`、`AGENTS.md`、`KROSS.md`。
- 个人和项目 Skill metadata，以及经 `ReadSkill` 读取的正文。
- 工具结果、MCP 返回内容和上下文摘要。

仓库规则、Skills、MCP server 和工具输出都可能影响模型决策。只加载你信任的内容。

## 权限模式

| 模式 | 行为 | 建议 |
|---|---|---|
| `default` | read 自动允许；write、execute、network 请求确认 | 日常使用默认选择 |
| `classifier` | workspace 写入自动允许；已知危险 shell 拒绝；其他执行和网络请求确认 | 熟悉项目后使用 |
| `auto` | 所有工具调用自动允许 | 仅用于隔离环境或可丢弃 workspace |

权限模式可通过 `/perm` 或 `Shift+Tab` 切换，但不会跨重启恢复。

规则分类器只识别一组已知危险命令模式，不能替代 OS 沙箱或人工判断。

## 文件边界

- 内置文件工具默认限制在主 workspace 和通过 `/add-dir` 授权的 roots。
- 路径使用 canonical realpath 校验，阻止通过 `..` 或 symlink 逃逸。
- Git 只读工具也会检查仓库根目录是否位于授权 workspace。
- Project Instructions 和项目 Skills 拒绝指向 root 外部的 symlink。

这些限制不适用于已批准的任意 shell 命令；shell 仍拥有当前系统用户的权限。

## 文件修改与撤销

Write、Edit、Delete、Move 和 ApplyPatch 统一写入 mutation journal：

- 修改前后保存 snapshot 和 hash。
- `/undo` 只在当前内容仍等于记录的 postHash 时执行。
- 检测到用户或其他程序的后续修改时整次拒绝，避免静默覆盖。
- ApplyPatch 在提交前校验全部路径和 hunks，失败时不保留部分修改。

mutation blobs 位于 `~/.kross/mutations`，其中可能包含历史文件正文，不应公开分享。

## Checkpoint 与恢复

- 等待工具审批时，Kross 会持久化 open turn 和版本化 run checkpoint，其中可能包含模型生成的工具参数。
- 恢复前会核对 tool-call id、已有结果、当前工具定义、动态风险和审批策略；任一证据不一致都会拒绝恢复。
- 只有尚未执行的待审批调用可以继续。已完成的 write / execute 调用不会因为重启而自动重放。
- 普通运行在任意中间点异常退出时会作为 interrupted turn 收口，不会猜测上一次操作是否成功。

会话与 checkpoint 位于 `~/.kross/sessions`，可能包含源码片段、命令参数或业务数据，应按本地敏感数据保护。

## Bash 与后台进程

- `Bash` 和 `ProcessStart` 只有 cwd/workspace 约束，没有 OS 级文件、网络或进程沙箱。
- shell 命令可以访问 workspace 外的系统资源，只要当前用户有权限。
- managed process 按 Kross 会话隔离控制权限，但不是操作系统安全边界。
- Kross 正常退出时会尝试终止其管理的活跃进程；进程异常脱离管理时仍可能需要人工处理。
- Windows 使用 `taskkill /T /F` 尝试清理整个进程树；仍建议在隔离环境验证高风险任务。

## MCP

- MCP server 是由 Kross 启动的外部本地进程，应只配置可信程序。
- MCP tool 默认按 `network` 风险处理，除非 annotations 或配置提供其他风险级别。
- server 的 `env` 可能包含密钥，配置文件应受到保护。
- MCP 返回内容会进入 Agent 上下文，应视为潜在的不可信指令或数据。

## Secrets 与本地数据

`~/.kross/config.json` 可能保存明文 API key 或 auth token。建议：

- 优先使用环境变量或受保护的本机配置。
- 不要提交 `~/.kross` 内容到 Git。
- 分享 trace、会话或故障信息前先检查路径、源码和业务数据。
- 不要在 prompt、Skill 或仓库规则中硬编码长期密钥。

ProcessStart 的 trace 使用受限 command-shape preview，ProcessWrite 只记录字节数；但其他工具 trace 仍可能包含路径、代码片段或工具输出。Trace 不是公开日志。

## 当前已知限制

- 没有 OS 级 Bash/进程沙箱。
- 没有容器级网络或文件系统隔离。
- MCP 仅支持 stdio，且没有运行时热重载。
- Project Instructions 当前只扫描 root 顶层。
- 权限 classifier 是启发式规则，不是安全证明。
- API key 存储尚未接入系统钥匙串。
