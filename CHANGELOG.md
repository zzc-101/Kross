# Changelog

本项目的重要变更记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 平台账号密码登录，以及平台级 OIDC SSO：Kross 只做验证方，超管在管理中心配置
  Issuer / Client 后即可接入企业 IdP。启用 SSO 后普通用户只能走企业账号，超管
  保留密码应急；验证通过按 `issuer + sub` 绑定或 JIT 建账号，不自动加入组织。
- 用户资料字段：昵称、头像、性别与手机号。
- 每人一块持久 Docker Worker：空闲休眠、磁盘留下；工作台围绕对话重建。
- Cloud 对话：Web 入站走 HTTP，出站走 SSE；消息以通用 `parts` 落库，直播文本、
  思考过程和工具调用经控制面内存扇出，回合结束再写完整快照。
- Worker 与控制面改为 WebSocket：容器运行期间保持长连接，任务由控制面推送。
- 工作区存储可切换：默认本机 Docker volume；集群可将 `/work` 挂到 JuiceFS
  （数据仍在 MinIO）。通过 `KROSS_WORKER_STORAGE` 与 `docker-compose.juicefs.yml`
  启用。
- 多机 Worker：独立 Go 服务 `kross-node`（`node/`）出站连控制面；
  `KROSS_WORKER_RUNTIME=cluster` 时控制面只调度。JuiceFS 工作区可漂。
- auto、plan、conductor 三种工作模式及子代理任务编排（由 Runtime 根据话术进入；
  工作台以 `auto` 开跑，高风险工具用界面确认）。
- 文件、搜索、Git、Shell、后台进程与 MCP 工具；workspace 边界、审批与
  mutation journal。
- Provider Capability 与调用指标：Runtime 只消费 Adapter 声明，记录不含正文的
  token、耗时、限流和稳定错误类别。
- MCP stdio 与 Streamable HTTP、Resources/Prompts、连接热重载。
- Core 顶层 API 收敛为 public / experimental barrel，`pnpm api:check` 阻止未分类导出。

### Changed

- 本分支改为 Cloud-only：仓库按 frontend / backend / worker / node 划分；根目录
  不再是 Node 项目；Core 并入 `worker/core`。
- 工作台与管理中心合并为同一 Nginx 入口：`/` 为用户工作台，`/admin/` 为管理中心。
  SSO 回调只需登记当前 Origin 的一条地址。
- 组织角色收拢为 admin / member。
- `frontend/` 与 `worker/` 从 npm 迁到 pnpm；两套独立 lockfile。
- 移除 Worker 内部 HTTP `/internal/v2/agents/*`；登记、心跳、领任务、直播和回写
  只走 `/internal/v2/agents/ws`。
- CI 与 Release Candidate 增加 `kross-node` 镜像构建。
- 缩小 `kross-worker` 镜像：Alpine、把 JS 打进单文件、系统 `rg`/`git`，不再拷整份
  `node_modules` 和 Debian 上的 GitHub CLI，方便拷到集群节点。
- 集群 JuiceFS 改用官方镜像 `juicedata/mount`，`docker-compose.cluster.yml` 会拉起
  本机 `kross-node`；额外 Worker 机用 `docker-compose.node.yml`。
- 集群节点令牌与 `nodeId` 绑定：`KROSS_NODE_TOKEN` 只认证 `KROSS_NODE_ID`；额外
  节点写入 `KROSS_NODE_TOKENS=id:token,...`。`node.hello` / `node.heartbeat` 不得
  改写握手中的节点 ID。
- Worker 控制面 WebSocket 握手改为 `Sec-WebSocket-Protocol: kross.bearer.<token>`
  （或 `Authorization: Bearer`），不再把 Agent Token 放进 URL query。
- 集群内部口 `8788` 默认绑定 `127.0.0.1`；跨机时设置 `KROSS_INTERNAL_BIND` 为内网
  地址，不要对公网发布。
- SSO 只按已验证 email 绑定已有账号，不再凭 `preferred_username` 自动接管。

### Removed

- Ink TUI、`kross` CLI、`kross exec` Headless Host、Harness Eval workspace，以及
  对应的 npm 打包和 Headless / TUI 文档。本地终端产品仍保留在 `main`。

### Fixed

- 新建工作区处于 `creating` 阶段时 Web 不再提前请求会话和模型，避免错误提示
  “工作区不存在”，并在工作区进入 `ready` 后自动加载。
- 节点握手不再接受共用令牌冒充任意 `nodeId`；中断后 `claimJob` 会把失败占位改回
  `processing`；reconcile 不再把仍在 `starting` 宽限内的 Agent 当成崩溃。
- 空库首次注册用事务 advisory lock 与唯一索引保证只有一个 `super_admin`。

[Unreleased]: https://github.com/zzc-101/Kross/commits/main
