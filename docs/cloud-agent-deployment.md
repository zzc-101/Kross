# SaaS Work Agent 部署与运维

本文只描述 `codex/saas-work-agent` 分支的新架构。本分支不再包含本地 TUI。

## 组件边界

- `web`：同源 Nginx 入口，工作台在 `/`，管理中心在 `/admin/`，`/api/` 反代控制面。
- `server`：身份、RBAC、Project/Task/Run、事件、Source/Artifact 与 Worker 控制面。
- `postgres`：控制面权威数据、幂等记录、租约和事件游标。
- `orchestrator`：唯一能访问 Docker Socket 的内部服务，按 Run 创建短命 Worker。
- `worker`：在隔离容器中执行一个 Run；完成后可销毁，不保存控制面权威状态。

浏览器只访问 Web/Nginx。`/api/v2/*`、`/internal/v2/*` 和 `/health` 反向代理到
Server；Server 和 Orchestrator 不映射宿主机端口。Server 容器不得挂载 Docker
Socket。

## 本地启动

需要 Node.js 22.19+、Docker Engine 与 Docker Compose。

```bash
./scripts/start-cloud.sh
```

脚本首次运行会从 `.env.example` 创建 `.env`，生成 PostgreSQL 密码和内部
Orchestrator 服务令牌，构建镜像，执行 migration，并启动 Web、Server、
Orchestrator 与 PostgreSQL。用户端默认入口为 `http://localhost:8787`，管理端为
`http://localhost:8787/admin/`。

```bash
./scripts/start-cloud.sh --no-build
./scripts/start-cloud.sh --logs
./scripts/start-cloud.sh --migrate
./scripts/start-cloud.sh --stop
```

默认走账号密码登录（`KROSS_DEV_IDENTITY=0`）。`KROSS_DEV_IDENTITY=1` 仅用于本机
冒烟脚本跳过登录，任何共享或公网环境都必须保持关闭。

## 身份与 SSO

Kross 不做身份提供商。默认是平台账号密码；企业有自己的 SSO 时，由超级管理员在
管理中心接入 OIDC，Kross 只验证 IdP 签发的身份。

三种角色：

1. **超级管理员**（`users.platform_role = super_admin`）：管整站，包括注册开关、
   组织生命周期和平台 SSO。第一个注册的用户自动成为超管。默认不必是组织成员，
   也不能查看该组织对话。
2. **组织管理员**（`membership.role = admin`）：管本组织成员、模型和策略。
3. **普通用户**（`membership.role = member`）：只用工作台。

空实例第一次注册始终允许。之后是否开放自助注册由超管决定，默认关闭。

### 接入企业 OIDC

在管理中心「平台设置 → 企业 SSO」填写显示名称、Issuer URL、Client ID 和 Client
Secret。保存并启用时，控制面会请求
`{issuer}/.well-known/openid-configuration`，确认能发现授权和换票地址。把页面
展示的回调地址登记到 IdP，例如：

```text
https://你的域名/api/v2/auth/sso/callback
```

工作台和管理中心现在是同一 Origin，IdP 只需登记这一条回调。本机开发若分别
跑 Vite（工作台 `:4173`、管理端 `:4174`），才需要再各登记一条。

登录流：

1. 浏览器访问 `GET /api/v2/auth/sso/start`，控制面带 `state` / `nonce` / PKCE
   跳转到企业 IdP。
2. IdP 回到 `GET /api/v2/auth/sso/callback`。控制面换票并校验 `id_token`
   （签名、issuer、audience、nonce、过期）。
3. 用 `issuer + sub` 绑定已有用户；没有则按 `preferred_username` 或邮箱本地部分
   JIT 创建平台用户（`platform_role=user`，不自动加入组织）。
4. 写入现有 `KROSS_SESSION` Cookie，后续与密码登录同一套会话。

启用 SSO 后，普通用户只能走企业账号；超级管理员仍可用密码应急，避免 IdP 故障
锁死整站。JIT 用户进入工作台前，仍需组织管理员用其用户名登记到本组织。Client
Secret 使用 `KROSS_CREDENTIAL_MASTER_KEY` 加密后存入 `platform_settings`，接口
不会回显明文。

## 配置

| 变量 | 用途 |
|---|---|
| `KROSS_PORT` | Web 对宿主机暴露的端口，默认 `8787`（工作台 `/`，管理中心 `/admin/`） |
| `KROSS_POSTGRES_PASSWORD` | 本地 PostgreSQL 密码；脚本可自动生成 |
| `KROSS_CREDENTIAL_MASTER_KEY` | 加密模型 API Key 与 SSO Client Secret 的主密钥，至少 32 字符 |
| `KROSS_PUBLIC_BASE_URL` | Worker/浏览器可访问的签名 Blob URL 基地址 |
| `KROSS_DEV_IDENTITY` | `1` 启用开发身份跳过登录；默认 `0`，生产必须为 `0` |
| `KROSS_ORCHESTRATOR_MANAGER_ID` | Docker 资源归属标签，多实例必须唯一 |
| `KROSS_WORKER_IMAGE` | Worker 镜像，Compose 默认 `kross-worker:local` |
| `AGENT_LLM_PROVIDER` / `AGENT_LLM_MODEL` | Worker 默认模型配置 |

Provider 密钥不应进入 RunSpec、事件、审计、容器标签或 URL。生产实现应由短期
credential broker 或 connector proxy 按 Run 授权。

## Run 隔离与内部认证

Orchestrator 为每个 `runId + generation` 创建独立容器、内部网络和执行卷，并设置：

- 只读根文件系统、非 root 用户、全部 capability drop、`no-new-privileges`；
- CPU、内存、PID、磁盘和运行时间限制；
- 短期 Run Token、leaseId 与 generation fencing；
- `/work` 执行目录以及受限 `/tmp`、`/run` tmpfs。

Run Token 在 Server 只保存 SHA-256 摘要，并绑定 organization、run、generation、
lease、Worker session 与过期时间。Worker 的注册、事件、心跳、Artifact 提交和释放
都必须重新验证该绑定。Server 通过数据库 CAS 续租或释放，旧 generation 不得继续
写入。

Docker Socket 等价于宿主机 root 权限。只有 Orchestrator 可挂载它，且 Orchestrator
只暴露带 Bearer 服务认证的内部接口。公网入口、Web 与 Server 均不得接触 Socket。
更高隔离级别应把 `ContainerBackend` 替换为 Kubernetes、Firecracker 或远程沙箱后端。

## 数据与恢复

PostgreSQL 保存组织、成员、Project、Task、Run、事件、Approval、Source/Artifact
元数据、幂等键和租约。BlobStore 保存 Source 与 Artifact 的不可变内容。Checkpoint
必须携带 execution profile；Work Profile 不接受 Coding Profile 或无 profile 的旧
checkpoint。

备份至少包括：

1. PostgreSQL 数据库；
2. 生产 BlobStore bucket 及其版本/保留策略；
3. 部署配置与密钥管理系统中的引用，不包含明文密钥副本。

本地 `docker compose down` 保留 `kross-postgres-v2`。`docker compose down -v` 会
删除本地数据库卷，属于破坏性操作。

## 发布门禁

```bash
cd frontend && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
cd ../worker && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
cd ../backend && ./mvnw -B test
node scripts/check-version-consistency.mjs
node scripts/check-doc-links.mjs
KROSS_POSTGRES_PASSWORD=test-password \
KROSS_ORCHESTRATOR_SERVICE_TOKEN=0123456789abcdef0123456789abcdef \
docker compose config --quiet
```

上线前还必须完成：生产身份与 CSRF、对象存储、密钥 broker、限流/配额、审计导出、
备份恢复演练，以及从工作台发消息到 Worker 执行的真实纵向 E2E。
