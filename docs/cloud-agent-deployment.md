# Cloud Agent 部署与运维

本文描述本分支的自托管部署。本分支没有本地 TUI / CLI；执行环境是每位成员
一块持久 Docker Worker。本地终端产品仍在 `main`。

## 组件边界

| 组件 | 职责 |
|---|---|
| `web` | 同源 Nginx：工作台 `/`，管理中心 `/admin/`，`/api/` 与 `/internal/` 反代控制面 |
| `server` | Java 控制面：账号 / SSO、组织模型、对话、Agent 生命周期 |
| `postgres` | 控制面权威数据（用户、组织、对话 `parts`、Agent 运行时状态） |
| `minio` | 对象存储：产物 bucket 默认 `kross`；集群 JuiceFS 底仓建议另用 `kross-jfs` |
| `worker` | 按人拉起的持久容器，在 `/work` 跑 Agent Runtime |
| `kross-node` | 仅集群：各 Worker 机上的 Go 进程，出站连控制面并在本机 Docker 起容器 |

浏览器只访问 Web。单机 Compose 把 Docker Socket 挂到控制面，由控制面本机起
Worker。集群模式下控制面只调度，Socket 应只给各机 `kross-node`。

## 本地启动

需要 Docker Engine 与 Docker Compose v2。从源码开发 Web / Worker 时才需要
Node.js `>= 22.19` 与 pnpm `10.14`；控制面需要 JDK 21（镜像内已包含）。

```bash
./scripts/start-cloud.sh
```

脚本首次运行会从 `.env.example` 创建 `.env`，生成 PostgreSQL 密码、对象存储
密钥和 `KROSS_CREDENTIAL_MASTER_KEY`，构建 Web、控制面、Worker 镜像并启动。
入口：

- 工作台：`http://localhost:8787`
- 管理中心：`http://localhost:8787/admin/`

```bash
./scripts/start-cloud.sh --no-build
./scripts/start-cloud.sh --logs
./scripts/start-cloud.sh --migrate
./scripts/start-cloud.sh --stop
```

默认走账号密码（`KROSS_DEV_IDENTITY=0`）。`KROSS_DEV_IDENTITY=1` 仅用于本机
冒烟跳过登录，任何共享或公网环境都必须关闭。

单机默认 `KROSS_WORKER_RUNTIME=local`、`KROSS_WORKER_STORAGE=local`，不要跑
`kross-node`。JuiceFS 与多机见下文。

## 身份与 SSO

Kross 不做身份提供商。默认是平台账号密码；企业 SSO 由超级管理员在管理中心
接入 OIDC，Kross 只验证 IdP 签发的身份。

三种角色：

1. **超级管理员**（`users.platform_role = super_admin`）：管整站，包括注册开关、
   组织生命周期和平台 SSO。第一个注册的用户自动成为超管。默认不必是组织成员，
   也不能查看该组织对话。
2. **组织管理员**（`membership.role = admin`）：管本组织成员和模型档案。
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

工作台和管理中心是同一 Origin，IdP 只需登记这一条回调。本机开发若分别跑 Vite
（工作台 `:4173`、管理端 `:4174`），才需要再各登记一条。

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
| `KROSS_PORT` | Web 对宿主机暴露的端口，默认 `8787` |
| `KROSS_POSTGRES_PASSWORD` | 本地 PostgreSQL 密码；脚本可自动生成 |
| `KROSS_CREDENTIAL_MASTER_KEY` | 加密模型 API Key 与 SSO Client Secret，至少 32 字符 |
| `KROSS_PUBLIC_BASE_URL` | Worker 与节点必须能访问的控制面地址；集群不要用 `http://kross-server:8787` |
| `KROSS_DEV_IDENTITY` | `1` 跳过登录；默认 `0`，生产必须为 `0` |
| `KROSS_ORCHESTRATOR_MANAGER_ID` | Docker 资源归属标签，多实例必须唯一 |
| `KROSS_WORKER_IMAGE` | Worker 镜像，Compose 默认 `kross-worker:local` |
| `KROSS_WORKER_STORAGE` | `local`（默认，本机 Docker volume）或 `juicefs` |
| `KROSS_JUICEFS_MOUNT` | `juicefs` 模式下宿主机挂载点，默认 `/var/lib/kross/jfs` |
| `KROSS_WORKER_RUNTIME` | `local`（默认，控制面本机 Docker）或 `cluster`（`kross-node` 跨机起容器） |
| `KROSS_NODE_TOKEN` | `cluster` 节点加入令牌，控制面与 `kross-node` 必须一致 |
| `KROSS_CONTROL_PLANE_URL` | 仅 `kross-node`：控制面可达地址，例如 `http://10.0.0.10:8787` |
| `KROSS_NODE_ID` | 仅 `kross-node`：节点稳定 ID，默认用容器 hostname |
| `KROSS_S3_*` | MinIO / S3：产物与（可选）JuiceFS 底仓 |
| `AGENT_LLM_PROVIDER` / `AGENT_LLM_MODEL` | 开发期注入 Worker 默认模型；生产请在管理中心登记组织模型 |

生产环境不要把 Provider 密钥写入 Run 事件、审计、容器标签或 URL。组织模型密钥
由控制面加密存储，Worker 领任务时再下发为进程环境变量。

## 工作区存储：单机与集群

默认 `KROSS_WORKER_STORAGE=local`：每人一块本机 Docker volume，挂到容器 `/work`。
单机 Compose 不需要 JuiceFS。

集群把 `/work` 放到 JuiceFS 上，对象数据仍在 MinIO（bucket `kross-jfs`，与产物
bucket `kross` 分开）。元数据用已有 Postgres。控制面只认宿主机挂载点
`KROSS_JUICEFS_MOUNT`（默认 `/var/lib/kross/jfs`），每个 Agent 使用其下
`agents/{agentId}`。不必在宿主机安装 `juicefs` 二进制，Compose 使用官方镜像
`juicedata/mount:ce-v1.4.1`（需要 `/dev/fuse`，请在 Linux 节点上跑）。

多机时控制面只调度；各机 `kross-node` 出站连
`KROSS_CONTROL_PLANE_URL/internal/v2/nodes/ws`，按心跳选负载低的节点。JuiceFS
可漂，不必粘滞，但会优先回到上次那台以利用缓存。

### 控制面 + 第一台节点

`.env` 里把 `KROSS_PUBLIC_BASE_URL` 改成**节点和 Worker 容器都能访问**的地址
（局域网 IP，不要用 `http://kross-server:8787`）。`./scripts/start-cloud.sh`
生成 `.env` 时会同时写入 `KROSS_NODE_TOKEN`，集群与额外节点共用这一份。

```bash
# 宿主机准备挂载点
sudo mkdir -p /var/lib/kross/jfs /var/cache/kross-jfs

# 控制面：Postgres、MinIO、Web、JuiceFS、调度，以及本机 kross-node（node-1）
export KROSS_PUBLIC_BASE_URL=http://控制面局域网IP:8787
docker compose -f docker-compose.yml -f docker-compose.juicefs.yml -f docker-compose.cluster.yml up -d
```

叠加文件会把 Postgres `5432` 映射到宿主机，供其他节点的 JuiceFS 写元数据，请只
在内网使用。未 close 的 JuiceFS 缓冲在节点故障时仍可能丢失。

### 额外 Worker 机

先在控制面仓库打镜像并拷过去：

```bash
docker build -f docker/node.Dockerfile -t kross-node:local .
docker build -f docker/worker.Dockerfile -t kross-worker:local .
docker save kross-node:local kross-worker:local | gzip > kross-node-worker.tar.gz
# 各节点：gunzip -c kross-node-worker.tar.gz | docker load
```

每台额外机器需要：Docker、FUSE、仓库里的 `docker-compose.node.yml` 与
`docker/juicefs-entrypoint.sh`、已 load 的两个镜像。然后：

```bash
sudo mkdir -p /var/lib/kross/jfs /var/cache/kross-jfs
export KROSS_CONTROL_PLANE_URL=http://控制面局域网IP:8787
export KROSS_JUICEFS_META_HOST=控制面局域网IP
export KROSS_NODE_ID=node-2
export KROSS_NODE_TOKEN=与控制面.env相同
export KROSS_POSTGRES_PASSWORD=与控制面相同
export KROSS_S3_SECRET_KEY=与控制面相同
docker compose -f docker-compose.node.yml up -d
```

`kross-node` 日志出现连上 `/internal/v2/nodes/ws` 后，在工作台发一条消息，Worker
应出现在该节点的 `docker ps`（名称 `kross-agent-...`），而不是控制面本机 Docker。
加入令牌目前走环境变量，超管 UI 尚未接入。

## Worker 隔离

每位成员一个常驻 Agent 容器（空闲后由控制面休眠，磁盘留下）：

- 非 root（容器内 `node` 用户）、丢弃多余 capability、`no-new-privileges`；
- CPU、内存、PID 限制；
- `/work` 为工作区（本机 volume 或 JuiceFS 子目录）；
- Worker 用内部令牌经 WebSocket 连 `/internal/v2/agents/ws`，浏览器不直连。

Docker Socket 等价于宿主机 root。单机只有控制面挂载它；集群应只给 `kross-node`。
公网入口不得直接暴露 Socket。更高隔离可把 `ContainerBackend` 换成 Kubernetes
或其他沙箱。

## 数据与恢复

| 数据 | 位置 | 备份 |
|---|---|---|
| 账号、组织、对话、Agent 元数据 | PostgreSQL | 必须 |
| 工作区文件 | 本机 Docker volume，或 JuiceFS（`agents/{agentId}`） | 必须 |
| 产物对象 | MinIO bucket `kross` | 建议开版本 |
| JuiceFS 底仓 | MinIO bucket `kross-jfs`（若启用） | 与元数据 Postgres 一起备份 |
| 模型密钥 / SSO Secret | PostgreSQL，由 `KROSS_CREDENTIAL_MASTER_KEY` 加密 | 备份库的同时保管主密钥 |
| Runtime 会话 / trace / 个人 Skills | Worker 容器 `$HOME/.kross` | 默认不随 `/work` 持久化 |

本地 `./scripts/start-cloud.sh --stop` 或 `docker compose down` 保留
`kross-postgres-v3` 与 `kross-minio-v2`。`docker compose down -v` 会删除这些卷，
属于破坏性操作。

## 发布门禁

```bash
cd frontend && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
cd ../worker && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
cd ../backend && ./mvnw -B -DskipTests compile
cd ../node && go build -o /tmp/kross-node .
node scripts/check-version-consistency.mjs
node scripts/check-doc-links.mjs
KROSS_POSTGRES_PASSWORD=test-password \
KROSS_CREDENTIAL_MASTER_KEY=abcdef0123456789abcdef0123456789 \
KROSS_S3_SECRET_KEY=test-s3-secret \
docker compose config --quiet
```

上线前还必须完成：生产身份与 CSRF、对象存储、限流/配额、备份恢复演练，以及从
工作台发消息到 Worker 执行的真实纵向验收。
