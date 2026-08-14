# SaaS Work Agent 部署与运维

本文只描述 `codex/saas-work-agent` 分支的新架构。本分支不再包含本地 TUI。

## 组件边界

- `web`：普通用户工作台和同源 Nginx 入口。
- `admin-web`：组织管理员控制台；与用户工作台分开部署并复用同一控制面。
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
Orchestrator 与 PostgreSQL。用户端默认入口为 `http://localhost:8787`，管理端默认
入口为 `http://localhost:8788`。

```bash
./scripts/start-cloud.sh --no-build
./scripts/start-cloud.sh --logs
./scripts/start-cloud.sh --migrate
./scripts/start-cloud.sh --stop
```

当前默认 `KROSS_DEV_IDENTITY=1` 仅用于本机开发。任何共享或公网环境都必须关闭，
并接入生产 OIDC/Session 身份实现。

## 配置

| 变量 | 用途 |
|---|---|
| `KROSS_PORT` | Web 对宿主机暴露的端口，默认 `8787` |
| `KROSS_ADMIN_PORT` | 管理端对宿主机暴露的端口，默认 `8788` |
| `KROSS_POSTGRES_PASSWORD` | 本地 PostgreSQL 密码；脚本可自动生成 |
| `KROSS_ORCHESTRATOR_SERVICE_TOKEN` | Server 与 Orchestrator 的内部服务令牌，至少 32 字节 |
| `KROSS_BLOB_SIGNING_SECRET` | Source/Artifact 短期 URL 的 HMAC 密钥，至少 32 字节 |
| `KROSS_BLOB_ROOT` | 本地 BlobStore 路径；生产应替换成对象存储 Adapter |
| `KROSS_PUBLIC_BASE_URL` | Worker/浏览器可访问的签名 Blob URL 基地址 |
| `KROSS_DEV_IDENTITY` | `1` 启用开发身份；生产必须为 `0` |
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
cd frontend && npm ci && npm run typecheck && npm test
cd ../worker && npm ci && npm run typecheck && npm test
cd ../backend && ./mvnw -B test
node scripts/check-version-consistency.mjs
node scripts/check-doc-links.mjs
KROSS_POSTGRES_PASSWORD=test-password \
KROSS_ORCHESTRATOR_SERVICE_TOKEN=0123456789abcdef0123456789abcdef \
docker compose config --quiet
```

上线前还必须完成：生产身份与 CSRF、对象存储、密钥 broker、限流/配额、审计导出、
备份恢复演练，以及从工作台发消息到 Worker 执行的真实纵向 E2E。
