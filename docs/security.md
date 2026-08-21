# 安全模型

Kross 是自托管 Cloud 开发 Agent。它通过 workspace 边界、工具风险分类、显式审批、可审计 trace 和冲突安全撤销降低风险，并用每用户独立的 Docker Worker 作为执行边界。

## 信任边界

Kross 会把以下内容提供给模型，应该视为受信任的本地输入：

- 用户消息和恢复后的会话上下文。
- 已授权 workspace 中的代码与文件。
- 根目录的 `CLAUDE.md`、`AGENTS.md`、`KROSS.md`。
- 个人和项目 Skill metadata，以及经 `ReadSkill` 读取的正文。
- 工具结果、MCP 返回内容和上下文摘要。

仓库规则、Skills、MCP server 和工具输出都可能影响模型决策。只加载你信任的内容。

## 平台身份

控制面用 HttpOnly `KROSS_SESSION` Cookie 维持登录，不把用户身份交给浏览器伪造。
默认是平台账号密码；企业 SSO 由超级管理员在管理中心接入 OIDC，Kross 只验证企业
IdP 签发的 `id_token`，不充当身份提供商。

- 启用 SSO 后，普通用户只能走企业账号；超级管理员保留密码作为应急入口。
- JIT 创建的账号不会自动加入组织，也不能被提成超管。
- SSO Client Secret 与模型 API Key 一样，用 `KROSS_CREDENTIAL_MASTER_KEY` 加密存储。
- `KROSS_DEV_IDENTITY` 允许用请求头冒充用户，只用于本机冒烟，生产必须关闭。

角色隔离是行级逻辑隔离：超管管平台，组织管理员管本组织，普通成员只用工作台。
详细接入步骤见 [Cloud Agent 部署与运维](cloud-agent-deployment.md#身份与-sso)。

## 权限模式

| 模式 | 行为 | 建议 |
|---|---|---|
| `default` | 当前 workspace 内的 read 自动允许；write、execute、network 请求人工确认 | 谨慎操作或初次接触项目 |
| `classifier` | workspace 内 read/write 自动允许；已知危险 shell 拒绝；其他执行和网络请求确认 | 可信项目的日常开发 |
| `auto` | 所有工具自动允许；文件、搜索、Git 和 Shell cwd 可访问当前用户有权限访问的任意系统路径 | 等同“完全访问”，仅在明确可信的环境使用 |

权限模式可通过 `/perm` 或 `Shift+Tab` 切换，并随 Session Work State 持久化。
`events.jsonl` 的后续 `work-state.updated` 会包含 `permissionMode`。

规则分类器只识别一组已知危险命令模式，不能替代人工判断。

## 文件边界

- 内置文件工具默认限制在主 workspace 和通过 `/add-dir` 授权的 roots。
- 路径使用 canonical realpath 校验，阻止通过 `..` 或 symlink 逃逸。
- Git 只读工具也会检查仓库根目录是否位于授权 workspace。
- Project Instructions 和项目 Skills 拒绝指向 root 外部的 symlink。

这些限制不适用于已批准的任意 shell 命令。Cloud Worker 中的 shell 拥有容器内
`node` 用户的权限。

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

- Cloud Worker 中，`Bash` 和 `ProcessStart` 运行在每用户独立的 Docker 容器内。
  cwd/workspace 只约束默认工作目录，不限制获准命令访问该容器内用户有权访问的
  其他路径。`auto` 还会明确解除内建文件、搜索和 Git 工具的 workspace 路径边界。
- Worker 使用非 root 用户、独立 volume 和网络，并丢弃 Linux capabilities、启用
  `no-new-privileges` 及 CPU、内存和 PID 限制。
- Worker 内的命令仍可修改该工作区数据、读取注入该 Worker 的配置并访问外网。
- managed process 按 Kross 会话隔离控制权限，但不会在同一运行环境内增加第二层
  隔离。
- Kross 正常退出时会尝试终止其管理的活跃进程；进程异常脱离管理时仍可能需要人工处理。
- Windows 使用 `taskkill /T /F` 尝试清理整个进程树。

Kross 当前没有规划额外的命令级 Sandbox。日常安全边界是 Cloud Worker 容器；
`auto` 是完全访问，只应用于可信环境或可丢弃的工作区。

## MCP

- stdio MCP server 是由 Kross 启动的外部本地进程，应只配置可信程序。
- Streamable HTTP endpoint 是远程信任边界；除 localhost 外强制 HTTPS，并默认
  将所有工具按 `network` 风险处理。
- server 的 `env` 可能包含密钥。远程 Bearer token 只允许通过环境变量名引用，
  不允许写入静态 header，且不会进入 Trace 或 Session。
- 不要把其他服务签发的 token 透传给 MCP server；预先取得的 token 必须绑定到
  目标 MCP resource。
- MCP Tool 返回内容以及显式附加的 Resource 都应视为潜在的不可信指令或数据。
- Resource 不会自动加载；`/mcp resource` 只接受文本，并以外部、不可信来源加入
  当前会话上下文。Prompt 通过 `/mcp prompt` 只做预览，不会自动执行或覆盖
  system prompt。

## Secrets 与本地数据

`~/.kross/config.json` 可能保存明文 API key 或 auth token。建议：

- 优先使用环境变量或受保护的本机配置。
- 不要提交 `~/.kross` 内容到 Git。
- 分享 trace、会话或故障信息前先检查路径、源码和业务数据。
- 不要在 prompt、Skill 或仓库规则中硬编码长期密钥。

ProcessStart 的 trace 使用受限 command-shape preview，ProcessWrite 只记录字节数；但其他工具 trace 仍可能包含路径、代码片段或工具输出。Trace 不是公开日志。

## Experimental Lifecycle Hooks

- Hook 只接收从 Trace 派生的脱敏元数据，不包含工具输入、输出、预览或摘要。
- Hook 代码与 Kross 运行在同一 Node.js 进程，拥有宿主进程权限；只能安装可信
  代码，事件脱敏不能把恶意 Hook 变成沙箱。
- 超时会取消 Hook 的 `AbortSignal` 并停止等待，但无法强制终止忽略取消的代码。
- Hook 抛错、超时或被限流不会改变 Agent 结果。需要副作用的扩展必须走正常
  Tool Gateway/Process 权限边界。

## 当前已知限制

- Cloud Worker 中获批的 shell 命令使用容器内 `node` 用户权限。
- Cloud Worker 可以访问外网，并可读写自己的持久化工作区。
- MCP 没有交互式 OAuth 客户端。
- Project Instructions 当前只扫描 root 顶层。
- 权限 classifier 是启发式规则，不是安全证明。
- API key 存储尚未接入系统钥匙串。
