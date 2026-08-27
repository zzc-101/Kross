# Cloud Agent 部署与运维

本文描述 SaaS Work Agent 的自托管部署。执行环境是每位成员一块持久 Worker。
本地终端产品仍在 `main`。

## 组件边界

| 组件 | 职责 |
|---|---|
| `web` | 同源 Nginx：工作台 `/`，管理中心 `/admin/`，`/api/` 反代控制面。不反代 `/internal/` |
| `server` | Java 控制面：账号 / SSO、平台模型、对话、Agent 生命周期 |
| `postgres` | 控制面权威数据（用户、组织、对话 `parts`、Agent 运行时状态）；集群另建 `kross_jfs` 给 JuiceFS 元数据 |
| `minio` | 对象存储：产物 bucket 默认 `kross`；集群 JuiceFS 底仓用 `kross-jfs` |
| `redis` | 控制面热点读缓存（可选）：关闭持久化，故障时自动回源 PostgreSQL |
| `worker` | 按人拉起的持久容器，在 `/work` 跑 Agent Runtime。单机是 Docker 容器，集群是 Kubernetes Pod |

浏览器只访问 Web。公网入口（Compose 的 Nginx 或 k3s Ingress）只反代 `/api/` 与静态页，不暴露 `/internal/`。
单机 Compose 把 Docker Socket 挂到控制面，由控制面本机起 Worker。集群由控制面调 Kubernetes API 起 Pod，不挂 Docker Socket。

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

单机默认 `KROSS_WORKER_RUNTIME=local`、`KROSS_WORKER_STORAGE=local`。多机见下文 k3s。

## 身份与 SSO

Kross 不做身份提供商。默认是平台账号密码；企业 SSO 由超级管理员在管理中心
接入 OIDC，Kross 只验证 IdP 签发的身份。

三种角色：

1. **超级管理员**（`users.platform_role = super_admin`）：管整站，包括注册开关、
   组织生命周期和平台 SSO。第一个注册的用户自动成为超管。默认不必是组织成员，
   也不能查看该组织对话。
2. **组织管理员**（`membership.role = admin`）：管理本组织成员与组织级策略，不管理平台模型档案。
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

回调地址固定由 `KROSS_EXTERNAL_BASE_URL` 生成，不采信请求 Host。工作台和管理中心
共用这一条回调；生产启用 SSO 前必须把该变量设为浏览器实际访问的 HTTPS 地址。

登录流：

1. 浏览器访问 `GET /api/v2/auth/sso/start`，控制面带 `state` / `nonce` / PKCE
   跳转到企业 IdP。
2. IdP 回到 `GET /api/v2/auth/sso/callback`。控制面换票并校验 `id_token`
   （签名、issuer、audience、nonce、过期）。
3. 用 `issuer + sub` 绑定已有用户；若有已验证 email 则按 email 绑定本地账号；
   否则按 `preferred_username` 或邮箱本地部分 JIT 创建平台用户（不会仅凭用户名
   接管已有账号，`platform_role=user`，不自动加入组织）。
4. 写入现有 `KROSS_SESSION` Cookie，后续与密码登录同一套会话。

启用 SSO 后，普通用户只能走企业账号；超级管理员仍可用密码应急，避免 IdP 故障
锁死整站。JIT 用户进入工作台前，仍需组织管理员用其用户名登记到本组织。Client
Secret 使用 `KROSS_CREDENTIAL_MASTER_KEY` 加密后存入 `platform_settings`，接口
不会回显明文。

## 配置

| 变量 | 用途 |
|---|---|
| `KROSS_PORT` | Web 对宿主机暴露的端口，默认 `8787`（仅 Compose 浏览器入口） |
| `KROSS_POSTGRES_PASSWORD` | 本地 PostgreSQL 密码；脚本可自动生成 |
| `KROSS_CREDENTIAL_MASTER_KEY` | 加密模型 API Key 与 SSO Client Secret，至少 32 字符 |
| `KROSS_PUBLIC_BASE_URL` | Worker 用来连控制面的地址。单机用 `http://kross-server:8787`；集群用 Service DNS，例如 `http://server:8787` |
| `KROSS_EXTERNAL_BASE_URL` | 浏览器访问控制面的公开地址，用于生成固定的 SSO 回调地址；生产环境应使用 HTTPS，例如 `https://kross.example.com` |
| `KROSS_DEV_IDENTITY` | `1` 跳过登录；默认 `0`，生产必须为 `0` |
| `KROSS_ORCHESTRATOR_MANAGER_ID` | Docker 资源归属标签，多实例必须唯一 |
| `KROSS_WORKER_IMAGE` | Worker 镜像，Compose 默认 `kross-worker:local` |
| `KROSS_WORKER_STORAGE` | `local`（默认，本机 Docker volume）或 `juicefs`（k3s 集群必填） |
| `KROSS_WORKER_RUNTIME` | `local`（默认，控制面本机 Docker）或 `kubernetes`（k3s 上起 Worker Pod） |
| `KROSS_KUBERNETES_NAMESPACE` | `kubernetes` 运行时创建 Pod/PVC 的命名空间；不设则读取 in-cluster ServiceAccount |
| `KROSS_KUBERNETES_STORAGE_CLASS` | JuiceFS StorageClass 名，默认 `kross-juicefs` |
| `KROSS_KUBERNETES_WORKSPACE_SIZE` | 每用户 PVC 申请值，默认 `10Gi`，local-path/CSI 不一定强制执行 |
| `KROSS_S3_*` | MinIO / S3：产物与（集群）JuiceFS 底仓 |
| `KROSS_CACHE_ENABLED` | 控制面 Redis 缓存开关，默认开启；设为 `false` 直连 PostgreSQL |
| `SPRING_DATA_REDIS_*` | 控制面连接 Redis 的地址 / 端口 / 密码（Compose 内默认 `redis:6379`） |
| `AGENT_LLM_PROVIDER` / `AGENT_LLM_MODEL` | 开发期注入 Worker 默认模型；生产请由超级管理员在管理中心登记平台模型 |

生产环境不要把 Provider 密钥写入 Run 事件、审计、容器标签或 URL。平台模型密钥
由控制面加密存储，Worker 领任务时再下发为进程环境变量。

## 工作区存储：单机与集群

默认 `KROSS_WORKER_STORAGE=local`：每人一块本机 Docker volume，挂到容器 `/work`。
单机 Compose 不需要 JuiceFS。

集群把 `/work` 放到 JuiceFS 上。对象数据在 MinIO bucket `kross-jfs`（与产物 bucket
`kross` 分开），元数据在 Postgres 库 `kross_jfs`。每个 Agent 使用子目录
`agents/{agentId}`。控制面通过 JuiceFS CSI 动态创建 RWX PVC，不再使用宿主机 FUSE
sidecar 或 `kross-node`。

每个 `agentId` 同时最多一个 Worker Pod。换节点前必须等到旧 Pod 消失，避免 RWX
双挂载。空闲休眠只删 Pod、保留 PVC。

### k3s 安装

需要一台 k3s server，以及按需增加的 agent 节点。先安装 JuiceFS CSI Driver，再
安装本仓库 chart。控制面、Postgres、MinIO 默认单副本。

```bash
helm repo add juicefs https://juicedata.github.io/charts/
helm upgrade --install juicefs-csi-driver juicefs/juicefs-csi-driver -n kube-system --create-namespace

# 每台节点都能 pull 这三个镜像，或使用 k3s ctr images import
helm upgrade --install kross deploy/cluster -n kross --create-namespace \
  --set secrets.postgresPassword='...' \
  --set secrets.credentialMasterKey='...' \
  --set secrets.s3SecretKey='...' \
  --set kross.externalBaseUrl=https://kross.example.com \
  --set ingress.host=kross.example.com
```

`KROSS_PUBLIC_BASE_URL` 在 chart 里默认是 `http://server:8787`，给 Worker Pod 走
集群 DNS。浏览器走 Ingress 到 `web`。不要把 `/internal/` 配进 Ingress。

开发导入镜像：

```bash
docker build -f deploy/local/docker/control-plane.Dockerfile -t kross-server:local .
docker build -f deploy/local/docker/web.Dockerfile -t kross-web:local .
docker build -f deploy/local/docker/worker.Dockerfile -t kross-worker:local .
docker save kross-server:local kross-web:local kross-worker:local | gzip > kross-images.tar.gz
# 各 k3s 节点：gunzip -c kross-images.tar.gz | k3s ctr images import -
```

工作台发一条消息后，`kubectl -n kross get pod,pvc` 应出现唯一的 `kross-agent-*`
Pod 和对应 PVC。

## Worker 隔离

每位成员一个常驻 Agent 容器（空闲后由控制面休眠；单机 volume / 集群 JuiceFS PVC 留下）：

- 非 root（容器内 `node` 用户）、丢弃多余 capability、`no-new-privileges`；
- CPU、内存、PID 限制；
- `/work` 为工作区（本机 volume 或 JuiceFS 子目录）；
- Worker 用内部令牌经 WebSocket 连 `/internal/v2/agents/ws`，浏览器不直连。

Docker Socket 等价于宿主机 root。单机只有控制面挂载它。集群控制面使用
ServiceAccount，不挂 Socket；公网入口不得暴露 Socket 或 `/internal/`。

## 数据与恢复

| 数据 | 位置 | 备份 |
|---|---|---|
| 账号、组织、对话、Agent 元数据 | PostgreSQL 库 `kross` | 必须 |
| JuiceFS 元数据 | PostgreSQL 库 `kross_jfs`（集群） | 必须，与底仓一起 |
| 工作区文件 | 本机 Docker volume，或 JuiceFS（`agents/{agentId}`） | 必须 |
| 产物对象 | MinIO bucket `kross` | 建议开版本 |
| JuiceFS 底仓 | MinIO bucket `kross-jfs`（集群） | 与元数据 Postgres 一起备份 |
| 模型密钥 / SSO Secret | PostgreSQL，由 `KROSS_CREDENTIAL_MASTER_KEY` 加密 | 备份库的同时保管主密钥 |
| Runtime 会话 / trace / 个人 Skills | Worker 容器 `$HOME/.kross` | 默认不随 `/work` 持久化 |

本地 `./scripts/start-cloud.sh --stop` 保留
`kross-postgres-v3` 与 `kross-minio-v2`。带 `-v` 删除这些卷属于破坏性操作。

## 发布门禁

```bash
cd frontend && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
cd ../worker && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
cd ../backend && ./mvnw -B -DskipTests compile
helm template kross deploy/cluster --namespace kross >/dev/null
node scripts/check-version-consistency.mjs
node scripts/check-doc-links.mjs
KROSS_POSTGRES_PASSWORD=test-password \
KROSS_CREDENTIAL_MASTER_KEY=abcdef0123456789abcdef0123456789 \
KROSS_S3_SECRET_KEY=test-s3-secret \
docker compose --project-directory . -f deploy/local/docker-compose.yml config --quiet
```

上线前还必须完成：生产身份与 CSRF、对象存储、限流/配额、备份恢复演练，以及从
工作台发消息到 Worker 执行的真实纵向验收。
