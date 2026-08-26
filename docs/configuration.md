# 配置参考

Kross 的用户配置由 Java 控制面管理；Worker 在每位成员的 `/work` 中保存文件与产物。普通用户工作台不提供模型、连接器或权限模式配置。

基础设施变量和完整 Compose 示例见[部署与运维](cloud-agent-deployment.md)。

## 平台模型

超级管理员在管理中心登记显示名、Provider、模型 ID、上下文长度、API Key 和可选 Base URL。密钥用 `KROSS_CREDENTIAL_MASTER_KEY` 加密，接口不回显明文。普通会话使用平台当前可用模型。

支持的 Provider 环境变量包括：

| Provider | 密钥 | 模型 | Base URL |
|---|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | `OPENAI_BASE_URL` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | `ANTHROPIC_BASE_URL` |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | `OPENROUTER_BASE_URL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `DEEPSEEK_BASE_URL` |
| xAI | `XAI_API_KEY` | `XAI_MODEL` | `XAI_BASE_URL` |

环境变量适合开发和首次引导；生产优先使用管理中心模型档案。

## Worker 行为

| 变量 | 作用 |
|---|---|
| `AGENT_THINKING_EFFORT` | `off\|minimal\|low\|medium\|high\|xhigh` |
| `AGENT_CONTEXT_WINDOW` | 覆盖平台模型上下文窗口 |
| `AGENT_MAX_TOOL_ITERATIONS` | 覆盖单轮工具循环上限 |

Kross 只有一套 SaaS Runtime 和固定工具策略，不存在运行模式或权限档位变量。

## 身份与组织

- 默认使用 HttpOnly `KROSS_SESSION` Cookie。
- 超级管理员可配置 OIDC Issuer、Client ID 和 Client Secret。
- `KROSS_DEV_IDENTITY=1` 只允许本机冒烟，生产必须关闭。
- 组织管理员管理本组织成员和已安装 Skill；平台模型由超级管理员维护。

## Skill

Skill 是平台发布的不可变版本包。管理员上传 ZIP、发布版本并安装到组织；普通成员只能选择已安装 Skill。会话保存 Skill ID，控制面在派发任务时下发对应版本内容。

Worker 不扫描 `/work` 或用户目录中的本地 Skill，也不提供本地 Skill 增删改接口。

## 记忆

个人记忆由控制面持久化，并在 Worker 启动时渲染到：

```text
/work/USER.md
/work/MEMORY.md
```

这两个文件是平台生成的长期上下文。其他工作区文件默认是用户资料，不会被自动提升为系统规则。

## 受管外部工具

外部工具配置属于平台基础设施，由控制面下发到 Worker。普通用户不能编辑 transport、命令、环境变量或认证信息。网络及外部副作用必须经过固定审批策略。

## 数据位置

| 数据 | 位置 |
|---|---|
| 账号、组织、模型、对话、记忆、Skill 元数据 | PostgreSQL |
| Skill ZIP 和其他对象产物 | MinIO / S3 |
| 成员文件与工作产物 | `/work`（volume 或 JuiceFS） |
| Runtime checkpoint、mutation journal、受管工具运行配置 | Worker 的受管目录 |
| 热点读缓存（身份/鉴权/目录） | Redis（可选） |

## 缓存层

控制面对高频、慢变的读路径使用 Redis 缓存（`spring-boot-starter-cache` + Redis），业务代码统一走 Spring Cache 抽象：

| Cache | 内容 | TTL | 失效方式 |
|---|---|---|---|
| `users` | 用户基础信息（不含密码哈希等敏感列） | 60s | TTL 到期回源 |
| `organizations` | 组织 active 状态 | 60s | TTL 到期回源 |
| `memberships` | (组织, 用户) 的有效成员角色 | 60s | TTL 到期回源 |
| `agentSessions` | Worker token 认证结果（key 为 SHA-256 哈希，原始 token 不入缓存） | 30s | TTL 到期回源 |
| `models` / `modelList` | 可用模型目录（不含凭据密文） | 5min | 管理端增删改时逐出 |
| `orgSkills` / `orgSkill` | 组织已安装 Skill 列表与详情 | 5min | 安装/卸载/发布时逐出 |

行为约定：

- **容错降级**：Redis 不可用时自动回源 PostgreSQL，请求不失败；恢复后自动重新启用。缓存是加速器，不是依赖项。
- **一致性边界**：TTL 即集群下的收敛上界——封禁用户、改角色、撤销 Worker token 最迟一个 TTL 生效（60s / 30s）。模型和 Skill 目录在管理端写路径主动逐出，跨节点即时生效。
- **安全边界**：密码哈希与凭据密文永不入缓存；Worker token 以哈希为 key。
- **开关**：`KROSS_CACHE_ENABLED=false` 完全关闭缓存层（直连 PostgreSQL）。单机部署默认开启；集群部署建议保持开启。
- 连接配置：`SPRING_DATA_REDIS_HOST` / `SPRING_DATA_REDIS_PORT` / `SPRING_DATA_REDIS_PASSWORD`；Compose 部署中 Redis 仅在内网 `kross-control` 网络内暴露，关闭持久化（纯缓存用途，重启后由控制面回源重建）。
