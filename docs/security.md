# 安全模型

Kross 通过平台身份、每成员 Docker Worker、单工作区路径边界和结构化外部工具确认降低风险。容器是重要隔离层，但不是恶意代码的绝对沙箱。

## 信任边界

可信系统上下文仅包括：

- 当前用户消息；
- 控制面维护的个人记忆；
- 平台发布并安装的版本化 Skill；
- Runtime 固定策略和工具结果。

普通工作区文件和外部工具返回内容都可能包含提示注入，应当视为待处理数据。Kross 不会根据特殊文件名自动把工作区文件提升为系统规则。

## 身份与角色

- 登录使用 HttpOnly `APP_SESSION` Cookie。
- 企业 SSO 由控制面验证 OIDC IdP 的身份令牌。
- SSO Client Secret 与模型 API Key 使用 `APP_CREDENTIAL_MASTER_KEY` 加密。
- 超级管理员管理平台，组织管理员管理本组织，普通成员只使用工作台。
- `APP_DEV_IDENTITY` 仅限本机冒烟，生产必须关闭。

## 工作区文件

- 内置文件工具限制在成员主工作区 `/work`。
- 路径经过 canonical realpath 校验，阻止 `..` 和 symlink 逃逸。
- Write、Edit、Delete、Move 记录 mutation pre/post image。
- 撤销只在当前内容仍匹配 post hash 时执行，避免覆盖后续人工修改。
- 浏览器不直连 Worker。用户上传先预签名写入对象存储，控制面再让 Worker `workspace.pull` 同步到 `/work`。`pull` / `push` 只允许访问内部 S3 地址（部署时注入的 `APP_S3_ENDPOINT`；未设置时仅本机回环）。图片与下载走同源 `file/content`（登录 cookie + 组织 ID query），控制面鉴权后 302 到短时预签名 GET，同一路径约 2 分钟内复用。字节不落控制面磁盘或 PostgreSQL。
- 列表、文本预览、content 跳转需要 `agent.read`；申请/提交上传、删除、建目录需要 `agent.chat`。
- 文件面板预览 UTF-8 文本（256KB）以及 png / jpeg / gif / webp；其余类型只提供下载。删除仅允许文件或空目录，不做递归删除。
- 单文件上限 10MB。

## 自动任务

- 以创建者身份执行：配额、模型、Skill、工作区都是该成员的，不做团队服务账号。
- 只读写当前成员自己的 `agent_id`（与对话、记忆相同）；跨组织请求被 `OrganizationAccess` 拒绝。
- 组织停用、成员停用或 Agent 删除后不再 wake。
- 提示词当作普通用户消息，受现有 32KB 上限约束。
- 到期比较用 Postgres `now()`。每个控制面副本都 tick，用 `FOR UPDATE SKIP LOCKED` 认领，并在同一事务推进 `next_run_at`（一次性任务标 `done`）。调度行不绑 pod / owner，不使用 `APP_SCHEDULER_OWNER` 选主。
- 不在会休眠的 Worker 里跑 cron。投递复用 `appendMessage` → `WorkerOfferBus`（本机试一次，再经 Redis 叫醒持有该 Worker WebSocket 的副本）。
- 外部 MCP 仍走现有审批；对话停在「等待确认」不算调度失败，避免把任务打进 `error`。
- 上一轮消息仍为 `queued` / `processing` 时跳过本拍；连续投递失败 3 次后暂停为 `error`。

## 外部操作确认

普通用户不选择权限档位。固定策略是：

- 工作区 read/write 自动执行；
- 受管网络工具和未知外部副作用要求确认；
- 前端使用“访问或修改外部服务”的普通语言，不展示原始命令或 JSON；
- Skill 和模型不能绕过 Tool Gateway 的实时判断。

默认 Runtime 没有任意 Shell、Git 或后台进程工具，因此用户确认不是任意命令执行授权。

## 容器与基础设施

- 每位成员使用独立非 root Worker、独立工作区和资源限制。
- Worker 丢弃多余 Linux capabilities，并启用 `no-new-privileges`、CPU、内存和 PID 限额。
- Worker 仍可能访问外网；生产应按需要增加 egress 控制。
- 单机控制面需要 Docker Socket。该权限近似宿主机 root，必须与公网入口隔离。
- 集群控制面使用 Kubernetes ServiceAccount 起 Worker Pod，不挂 Docker Socket。
- 浏览器入口不代理 `/internal/` Worker 通道。

## Secrets 与日志

- 不要在对话、文件、Skill 或 Issue 中写入长期密钥。
- Provider 指标不保存 prompt、回复正文、API Key 或错误响应 body。
- Trace、checkpoint 和 mutation journal 可能包含路径和业务片段，分享前必须脱敏。
- PostgreSQL、对象存储和 `/work` 都需要独立备份与访问控制。

## 恢复安全

等待确认时会保存 checkpoint。恢复必须证明调用尚未执行，并重新核对定义和策略；证据不完整时 fail closed。控制面中的最终消息是用户可见历史事实源，Worker 本地状态不是备份。
