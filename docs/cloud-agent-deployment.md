# Kross Cloud Agent 部署与运维

## 组件边界

- `packages/protocol`：只包含浏览器安全的 Zod 线协议，不依赖 `core`。
- `packages/worker`：运行在工作区容器内，每个会话拥有独立 `AgentRuntime`。
- `packages/server`：认证、工作区注册、Docker 编排、SSE/HTTP 网关、Web Push。
- `packages/web`：由网关直接托管的响应式 PWA。

会话消息、上下文 checkpoint 与审批 checkpoint 存在工作区卷的
`/workspace/.kross`。恢复以 session snapshot 为权威；Worker 只把审批、
会话更新、Git 结果等低频领域事件写入分段 JSONL，并用独立的 recent-request
索引保证命令幂等。每次 snapshot 成功持久化后会截断更早的日志段，高频
token delta 不落盘。序号通过预留区间保持进程崩溃后的单调性。

## 本地启动

需要 Node.js 22.19+、Docker Engine 和 Docker Compose。

推荐直接使用一键脚本。首次运行会根据 `.env.example` 创建 `.env`、自动生成访问
令牌、构建 Gateway 与 Worker 镜像并在后台启动：

```bash
./scripts/start-cloud.sh
```

后续可用 `./scripts/start-cloud.sh --no-build` 跳过镜像构建，
`./scripts/start-cloud.sh --logs` 查看日志，使用
`./scripts/start-cloud.sh --stop` 停止服务并保留数据卷。

也可以按以下步骤手动启动：

```bash
npm ci
npm run build
cp .env.example .env
export KROSS_ACCESS_TOKEN="$(openssl rand -base64 32)"
docker compose --profile build build
docker compose up gateway
```

Gateway 与 Worker 均使用多阶段镜像：构建阶段安装完整依赖并生成单文件运行时，
最终镜像只保留生产依赖、静态资源和必要命令行工具，不包含 TypeScript 源码与
开发工具。

访问 `http://localhost:8787`，输入上述访问令牌。公网部署必须在网关前配置
TLS 反向代理，浏览器端应使用 `https://`。

首次登录后打开顶部“环境”面板。面板会检查 Docker、worker 镜像、模型
Provider、GitHub、Web Push 与安全传输状态。Provider API Key 可以通过该面板
写入 Gateway 数据卷中的私有配置文件，接口只返回是否已配置，不会回显密钥。
勾选“重建现有 Worker”时会保留仓库和会话卷，但会中断正在运行的任务。

生产构建会注册 Service Worker。支持的浏览器会显示“安装”入口；发现新版本时
界面会提示用户更新并重新载入。网络中断期间，Web 客户端会保留最多 100 个
带原始 `requestId` 的操作，重连并恢复活动会话后按顺序发送。超过上限会明确
提示用户等待网络恢复，避免无限占用内存。

Web 客户端通过 `POST /api/commands` 上行命令，通过 `GET /api/events` 的
SSE 流接收实时事件，全部使用标准 Bearer Token。反向代理需要对
`/api/events` 关闭响应缓冲；Nginx 应配置 `proxy_buffering off`，Gateway
同时发送 `X-Accel-Buffering: no`。公网客户端路径不再需要配置 WebSocket
Upgrade；Gateway 与 Worker 的内部链路仍使用 WebSocket。

## 必需与可选配置

| 变量 | 用途 |
|---|---|
| `KROSS_ACCESS_TOKEN` | 网关访问令牌，生产环境必须固定配置 |
| `KROSS_WORKER_IMAGE` | worker 镜像，默认 `kross-worker:local` |
| `KROSS_IDLE_TIMEOUT_MS` | 工作区空闲回收时间，默认 30 分钟 |
| `KROSS_WORKSPACE_MEMORY` | 每个容器的内存上限（字节），默认 2 GiB |
| `KROSS_WORKSPACE_NANO_CPUS` | 每个容器的 CPU 上限，默认 `1000000000`（1 核） |
| `KROSS_WORKSPACE_PIDS` | 每个容器的进程数上限，默认 256 |
| `KROSS_WORKSPACE_DISK_BYTES` | 每个工作区的应用层磁盘软限额，默认 10 GiB |
| `KROSS_STOP_WORKERS_ON_SHUTDOWN` | Gateway 退出时移除 worker 容器并保留工作区卷，默认 `true` |
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

每个工作区使用独立的 `kross-workspace-net-*` bridge 网络。Gateway 会动态接入
对应网络，Worker 之间不共享二层网络，无法直接访问其他工作区的 8788 端口。
共享的 `kross-cloud` 网络只用于 Gateway 的 Compose 接入与一次性克隆 helper。

Docker Desktop 的命名卷没有可移植的逐卷硬配额，因此磁盘限制采用应用层软
限额：仓库首次克隆完成后立即检查，超限则回滚工作区创建；Worker 在后台统计
`/workspace` 与状态目录，新任务读取最近的缓存值，达到上限后拒绝并返回明确错误。
会话恢复、审批处理和清理操作仍可执行，便于用户释放空间。该机制不能阻止单个
已运行任务瞬间写满宿主机，生产部署仍应配置宿主机磁盘监控和告警。

Worker 每 60 秒在后台刷新磁盘用量，并在一次任务结束后主动刷新；新任务读取缓存，
避免对大型 `node_modules` 每次执行全量 `du`。Gateway 与 Worker 的内部 WS 双向
发送 ping/pong，断线后指数退避重连，并按已知会话序号补发 `session.resume`。

## 生命周期与恢复

Gateway 启动时会对账注册表与 Docker：

- 仍在运行的已登记 worker 会被接管。
- 已停止但容器缺失的工作区会从原命名卷重建 stopped worker。
- 未出现在注册表中的受管孤儿容器会被移除，工作区卷不会自动删除。

Worker 内部只常驻最近使用的 Runtime，默认最多 20 个，空闲 15 分钟且没有运行中
任务、待审批或待确认计划的 Runtime 可以安全淘汰，后续从 checkpoint 恢复。
空闲工作区回收前会查询 Worker 的活跃任务状态，无法确认或仍有运行时不会停止容器。

Gateway 正常退出时默认移除动态 worker 容器，使 Compose 网络能够完整清理，
但保留工作区命名卷和服务端注册表。下次启动会自动重建 stopped worker，访问
会话时再按需启动。只有显式执行“删除工作区并删除数据卷”才会永久删除仓库、
会话和审批 checkpoint。

## P0–P2 验收

1. 创建工作区，确认仓库只出现在对应命名卷中。
2. 创建会话并发送会触发写工具的任务，确认审批前工具没有执行。
3. 批准后确认流继续；断开网络，再连接并检查没有丢失或重复事件。
4. 重启 worker，恢复等待审批的会话并完成审批。
5. 在手机浏览器安装 PWA，验证响应式布局、Diff、Trace、Todo、子代理状态和
   上下文容量；执行 `/context` 与无可压缩历史的 `/compact`，确认结果会回写
   当前会话。
   Diff 应包含真实 Git patch，Trace 最近运行项应可进入详情；切换离线后发送
   操作，再恢复网络，确认操作只执行一次且界面没有重复事件。
6. 配置 VAPID 后订阅通知，锁屏时触发审批并确认收到 Push。
7. 验证分支 Push、PR 创建、空闲回收，以及默认 1 CPU、2 GiB 内存、256 PID
   和 10 GiB 磁盘软限额。

CI 的 `cloud-containers` 任务会解析 Compose 配置并分别构建 worker、gateway
镜像，防止 Dockerfile 与 workspace 依赖在后续变更中失效。
