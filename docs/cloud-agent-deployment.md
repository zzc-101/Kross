# Kross Cloud Agent 部署与运维

## 组件边界

- `packages/protocol`：只包含浏览器安全的 Zod 线协议，不依赖 `core`。
- `packages/worker`：运行在工作区容器内，每个会话拥有独立 `AgentRuntime`。
- `packages/server`：认证、工作区注册、Docker 编排、WS 中继、Web Push。
- `packages/web`：由网关直接托管的响应式 PWA。

会话消息、上下文 checkpoint 与审批 checkpoint 存在工作区卷的
`/workspace/.kross`。云端事件另存为带单调 `seq` 的 JSONL 日志，客户端用
`lastSeq` 增量恢复。

## 本地启动

需要 Node.js 22.19+、Docker Engine 和 Docker Compose。

```bash
npm ci
npm run build
cp .env.example .env
export KROSS_ACCESS_TOKEN="$(openssl rand -base64 32)"
docker compose --profile build build
docker compose up gateway
```

访问 `http://localhost:8787`，输入上述访问令牌。公网部署必须在网关前配置
TLS 反向代理，浏览器端应使用 `wss://`。

首次登录后打开顶部“环境”面板。面板会检查 Docker、worker 镜像、模型
Provider、GitHub、Web Push 与安全传输状态。Provider API Key 可以通过该面板
写入 Gateway 数据卷中的私有配置文件，接口只返回是否已配置，不会回显密钥。
勾选“重建现有 Worker”时会保留仓库和会话卷，但会中断正在运行的任务。

浏览器不能给 WebSocket 握手自定义 `Authorization`，因此 Web 客户端通过
`Sec-WebSocket-Protocol` 中的 `kross.token.*` 子协议传令牌；反向代理必须避免
记录该请求头。REST 仍使用标准 Bearer Token。

## 必需与可选配置

| 变量 | 用途 |
|---|---|
| `KROSS_ACCESS_TOKEN` | 网关访问令牌，生产环境必须固定配置 |
| `KROSS_WORKER_IMAGE` | worker 镜像，默认 `kross-worker:local` |
| `KROSS_IDLE_TIMEOUT_MS` | 工作区空闲回收时间，默认 30 分钟 |
| `KROSS_WORKSPACE_MEMORY` | 每个容器的内存上限 |
| `KROSS_WORKSPACE_NANO_CPUS` | 每个容器的 CPU 上限 |
| `KROSS_WORKSPACE_PIDS` | 每个容器的进程数上限 |
| `KROSS_STOP_WORKERS_ON_SHUTDOWN` | Gateway 退出时移除 worker 容器并保留工作区卷，默认 `true` |
| `KROSS_ALLOWED_ORIGINS` | 允许的额外 WebSocket Origin，逗号分隔；同源无需配置 |
| `KROSS_MANAGER_ID` | Docker 资源归属标识；同一 Engine 上多实例部署时必须唯一 |
| `KROSS_VAPID_PUBLIC_KEY` / `KROSS_VAPID_PRIVATE_KEY` | 启用 Web Push |
| `KROSS_VAPID_SUBJECT` | VAPID 联系主体，如 `mailto:admin@example.com` |

可用 `npx web-push generate-vapid-keys` 生成 VAPID 密钥。浏览器订阅按钮仅在网关
配置密钥且页面处于 HTTPS（localhost 除外）时可用。支持通知操作按钮的系统可在
锁屏通知上直接批准或拒绝；不支持操作按钮的系统会打开对应会话审批页。

LLM Provider 的环境变量由网关创建 worker 时按部署配置注入。不要在反向代理、
容器日志或监控标签中记录访问令牌、Git token、SSH 私钥和 Provider 密钥。
网关只会把内置白名单中的 `AGENT_*`、`OPENAI_*`、`ANTHROPIC_*`、
`OPENROUTER_*`、`DEEPSEEK_*` 和 `XAI_*` 配置传入 worker，不会透传整个网关环境。
用于创建 GitHub PR 的 `GH_TOKEN` 也在白名单内。

HTTPS Git Token 与 SSH 私钥只写入对应工作区卷的 `.kross` 目录，并以 `0600`
权限供后续 Push 使用。`gh pr create` 需要 HTTPS Token 或单独配置 `GH_TOKEN`；
SSH 私钥本身只能完成 Git 认证，不能替代 GitHub API Token。

## Docker Socket 风险

默认单机部署通过 `/var/run/docker.sock` 编排容器。Docker Socket 等价于宿主机
root 权限，因此网关只能运行受信代码，必须限制管理端口访问，并建议使用独立
主机。更高隔离要求下，应把 `ContainerOrchestrator` 替换成受限的远程调度服务，
而不是把 Socket 暴露给公网入口进程。

worker 默认丢弃 Linux capabilities、启用 `no-new-privileges`，并设置内存、CPU、
PID 限额。工作区容器仍允许访问外网，以便调用 LLM 和安装依赖；生产环境可按需
增加出口域名策略。

## 生命周期与恢复

Gateway 启动时会对账注册表与 Docker：

- 仍在运行的已登记 worker 会被接管。
- 已停止但容器缺失的工作区会从原命名卷重建 stopped worker。
- 未出现在注册表中的受管孤儿容器会被移除，工作区卷不会自动删除。

Gateway 正常退出时默认移除动态 worker 容器，使 Compose 网络能够完整清理，
但保留工作区命名卷和服务端注册表。下次启动会自动重建 stopped worker，访问
会话时再按需启动。只有显式执行“删除工作区并删除数据卷”才会永久删除仓库、
会话和审批 checkpoint。

## P0–P2 验收

1. 创建工作区，确认仓库只出现在对应命名卷中。
2. 创建会话并发送会触发写工具的任务，确认审批前工具没有执行。
3. 批准后确认流继续；断开网络，再连接并检查没有丢失或重复事件。
4. 重启 worker，恢复等待审批的会话并完成审批。
5. 在手机浏览器安装 PWA，验证响应式布局、Diff、Trace 和 Todo。
6. 配置 VAPID 后订阅通知，锁屏时触发审批并确认收到 Push。
7. 验证分支 Push、PR 创建、空闲回收以及资源上限。

CI 的 `cloud-containers` 任务会解析 Compose 配置并分别构建 worker、gateway
镜像，防止 Dockerfile 与 workspace 依赖在后续变更中失效。
