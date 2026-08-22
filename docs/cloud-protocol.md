# Cloud Protocol

浏览器只和 Java 后端说话：上行 HTTP，下行 SSE。Worker 只在容器运行时用
WebSocket 连控制面。线协议的事实源是 `backend` 里的 Java DTO，不再使用独立的
npm Protocol 包。

## 浏览器

- 发消息：`POST /api/v2/agent/conversations/{id}/messages`
- 直播：`GET /api/v2/agent/conversations/{id}/events`（SSE，`event: channel`）
- 历史：`GET /api/v2/agent/conversations/{id}/messages`
- 可用模型：`GET /api/v2/agent/models`
- 对话模式/模型：`PATCH /api/v2/agent/conversations/{id}`（`mode`、`modelId`）

SSE 体是通用消息事件，包含文本、思考和工具 `parts`。不要把每个 token 写入数据库；
回合结束再写完整快照。

## Worker

路径：`ws://<backend>/internal/v2/agents/ws`

握手使用 `Sec-WebSocket-Protocol: kross.bearer.<token>`，也可带
`Authorization: Bearer <token>`。不要把 token 放进 URL query。

该路径不经过公网 Nginx。Worker 应连控制面（Compose 别名 `kross-server` 或集群
内部口），不要连浏览器入口 `:8787`。

握手后控制面推送 `agent.job`（含对话 `mode` 与可选 `modelId`）。Worker 可带
`modelId` 再要一次 `agent.model_environment`。生成过程立即推 `agent.events`，
结束时用 `agent.message` 提交完整 `parts`。另有心跳和休眠帧。

工作区浏览走同一条 WebSocket：控制面下发 `agent.command`（`workspace.list` /
`git.status` / `git.clone`），Worker 用 `agent.command_result` 回答。浏览器 HTTP：

- 文件列表：`GET /api/v2/agent/workspace/files?path=`
- Git 状态：`GET /api/v2/agent/workspace/git?path=`
- 克隆：`POST /api/v2/agent/workspace/git/clone`
- Skills：`GET/PUT/DELETE /api/v2/agent/skills`
- MCP：`GET/PUT /api/v2/agent/mcp`（持久化到 `/work/.kross/mcp.json`）

## 集群节点

路径：`ws://<control-plane>/internal/v2/nodes/ws?nodeId=<KROSS_NODE_ID>`，
`Authorization: Bearer` 必须是该 `nodeId` 绑定的令牌。`KROSS_NODE_TOKEN` 只认证
`KROSS_NODE_ID`；额外节点把 `id:token` 写入控制面 `KROSS_NODE_TOKENS`。hello 不得
改写握手中的节点 ID。

同 Compose 用 `http://kross-server:8787`；跨机用内部口（默认 `:8788`），不要走
公网 Nginx。

节点上报 `node.hello` / `node.heartbeat`；控制面下发 `node.start` / `node.stop` /
`node.inspect`，节点用 `node.result` 回答。单机 Compose 不使用该通道。

版本、字段和错误语义以 `backend/src/main/java/com/kross` 下的协议类型为准。
破坏性变更必须提升协议版本并写入 `CHANGELOG.md`。
