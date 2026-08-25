# 安全模型

Kross 是自托管 Cloud 开发 Agent。它通过每用户独立的 Docker Worker、工具风险分类、
显式审批和可审计运行记录降低风险。本分支没有本地 TUI；浏览器只和 Java 控制面
通信。

## 信任边界

Kross 会把以下内容提供给模型，应该视为受信任输入：

- 用户消息和恢复后的会话上下文。
- 该成员 `/work` 工作区中的代码与文件。
- 根目录的 `CLAUDE.md`、`AGENTS.md`、`KROSS.md`。
- 个人和项目 Skill metadata，以及经 `ReadSkill` 读取的正文。
- 工具结果、MCP 返回内容和上下文摘要。

仓库规则、Skills、MCP server 和工具输出都可能影响模型决策。只加载你信任的内容。

## 平台身份

控制面用 HttpOnly `KROSS_SESSION` Cookie 维持登录，不把用户身份交给浏览器伪造。
浏览器入口不反代 `/internal/`；Worker 与集群节点直连控制面（Compose 网络或内部口）。
默认是平台账号密码；企业 SSO 由超级管理员在管理中心接入 OIDC，Kross 只验证企业
IdP 签发的 `id_token`，不充当身份提供商。

- 启用 SSO 后，普通用户只能走企业账号；超级管理员保留密码作为应急入口。
- JIT 创建的账号不会自动加入组织，也不能被提成超管。
- SSO 只按已验证 email 绑定已有本地账号，不会仅凭用户名接管。
- SSO Client Secret 与模型 API Key 一样，用 `KROSS_CREDENTIAL_MASTER_KEY` 加密存储。
- `KROSS_DEV_IDENTITY` 允许用请求头冒充用户，只用于本机冒烟，生产必须关闭。

角色隔离是行级逻辑隔离：超管管平台，组织管理员管本组织，普通成员只用工作台。
详细接入步骤见 [Cloud Agent 部署与运维](cloud-agent-deployment.md#身份与-sso)。

## Cloud 工具策略

Cloud Worker 使用一套固定策略，不向普通用户暴露权限模式：工作区读写、构建、测试
和普通容器命令自动执行；Git push、MCP 与未知网络操作要求确认；已知会破坏工作区
或容器的 Shell 命令直接拒绝。文件访问始终限制在 workspace，不能切换为系统范围。

## 文件边界

- 内置文件工具默认限制在主工作区 `/work`。
- 路径使用 canonical realpath 校验，阻止通过 `..` 或 symlink 逃逸。
- Git 只读工具也会检查仓库根目录是否位于授权 workspace。
- Project Instructions 和项目 Skills 拒绝指向 root 外部的 symlink。

这些限制不适用于已批准的任意 shell 命令。Cloud Worker 中的 shell 拥有容器内
`node` 用户的权限。

## 文件修改与撤销

Write、Edit、Delete、Move 和 ApplyPatch 统一写入 mutation journal：

- 修改前后保存 snapshot 和 hash。
- 撤销只在当前内容仍等于记录的 postHash 时执行。
- 检测到用户或其他程序的后续修改时整次拒绝，避免静默覆盖。
- ApplyPatch 在提交前校验全部路径和 hunks，失败时不保留部分修改。

journal 位于 Worker 容器 `$HOME/.kross/mutations`，可能包含历史文件正文。该目录
默认不随 `/work` 卷备份，分享前仍应检查敏感内容。

## Checkpoint 与恢复

- 等待工具审批时，Runtime 会持久化 open turn 和版本化 run checkpoint。
- 恢复前会核对 tool-call id、已有结果、当前工具定义、动态风险和审批策略；任一
  证据不一致都会拒绝恢复。
- 只有尚未执行的待审批调用可以继续。已完成的 write / execute 不会因为重启而
  自动重放。
- 普通运行在任意中间点异常退出时会作为 interrupted turn 收口。

对话正文的权威副本在控制面 PostgreSQL。Worker 本地 checkpoint 在 `$HOME/.kross`，
容器被删后不能当作备份。

## Bash 与后台进程

- `Bash` 和 `ProcessStart` 运行在每用户独立的 Linux Docker 容器内。
  cwd/workspace 只约束默认工作目录，不限制获准命令访问该容器内用户有权访问的
  其他路径。
- Worker 使用非 root 用户、独立 volume（或 JuiceFS 子目录）和网络，并丢弃
  Linux capabilities、启用 `no-new-privileges` 及 CPU、内存和 PID 限制。
- Worker 内的命令仍可修改该工作区数据、读取注入该 Worker 的配置并访问外网。
- managed process 按 Runtime 会话隔离，容器休眠或重建后不会自动重连。
- 单机 Compose 把 Docker Socket 挂在控制面；集群应只给 `kross-node`。Socket
  权限近似宿主机 root，不能直接暴露到公网。

## MCP

- stdio MCP server 是 Worker 启动的外部进程，应只配置可信程序。
- Streamable HTTP endpoint 是远程信任边界；除 localhost 外强制 HTTPS，并默认
  将所有工具按 `network` 风险处理。
- 远程 Bearer token 只允许通过环境变量名引用，不允许写入静态 header，且不会
  进入 Trace 或 Session。
- MCP 返回内容以及显式附加的 Resource 都应视为潜在的不可信指令或数据。
- Cloud 上 MCP 配置默认在容器 `$HOME/.kross`，不随 `/work` 持久化。

## Secrets

- 平台模型 API Key 与 SSO Client Secret 由控制面加密存储，不要写入仓库或对话。
- 不要在 prompt、Skill 或仓库规则中硬编码长期密钥。
- 分享故障信息前先检查路径、源码、工具参数和业务数据。
- Trace 不是公开日志。

## Experimental Lifecycle Hooks

- Hook 只接收从 Trace 派生的脱敏元数据，不包含工具输入、输出、预览或摘要。
- Hook 代码与 Worker 运行在同一 Node.js 进程；只能安装可信代码。
- Hook 抛错、超时或被限流不会改变 Agent 结果。需要副作用的扩展必须走正常
  Tool Gateway 权限边界。

## 当前已知限制

- Cloud Worker 中的 shell 命令使用容器内 `node` 用户权限，并可访问外网。
- MCP 没有交互式 OAuth 客户端。
- Project Instructions 当前只扫描工作区根顶层。
- Shell 危险命令识别是纵深防御，不是完整的命令语义证明。
- `$HOME/.kross` 中的 journal / trace / 个人 Skills 默认不进工作区备份。
