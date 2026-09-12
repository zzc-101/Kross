# Cloud Protocol

浏览器只与 Java 控制面通信：上行 HTTP、下行 SSE。Worker 只在容器运行时通过内部 WebSocket 连接控制面。Java DTO 是线协议事实源。

## 浏览器 API

主要普通用户接口：

- `GET/POST /api/v2/agent/conversations`
- `PATCH /api/v2/agent/conversations/{id}`
- `GET/POST /api/v2/agent/conversations/{id}/messages`
- `GET /api/v2/agent/conversations/{id}/events`
- `POST /api/v2/agent/conversations/{id}/approvals/{approvalId}`
- `GET /api/v2/agent/workspace/files?path=`
- `GET /api/v2/agent/workspace/file?path=`（UTF-8 文本预览，Worker `workspace.read` 上限 256KB）
- `POST /api/v2/agent/workspace/file/upload`（申请预签名 PUT；`directory` + `name` + `mimeType` + `size`；单文件 10MB）
- `POST /api/v2/agent/workspace/file/commit`（确认对象已上传，控制面让 Worker `workspace.pull` 同步到 `/work`）
- `GET /api/v2/agent/workspace/file/url?path=`（JSON 预签名 GET；`inline=true` 用于图片预览）
- `GET /api/v2/agent/workspace/file/content?path=`（登录 cookie 鉴权后 302 到预签名 GET；组织 ID 可用请求头或 `organizationId` query，供 `<img>` / 下载；默认 `inline=true`）
- `DELETE /api/v2/agent/workspace/file?path=`（文件或空目录；同时删除对象）
- `POST /api/v2/agent/workspace/directory`（`{ path }`）
- `GET /api/v2/agent/skills`
- `GET/POST/PATCH/DELETE /api/v2/agent/memories...`

`POST /conversations/{id}/messages` 可带 `files: [{ path, mimeType, name }]`。控制面把附件写入已有 `parts` JSON，`content` 仍是用户原文；下发给 Worker 时再追加 `（附件：…）`。图片（png / jpeg / gif / webp）在 `agent.job` / history 里只传 `{ kind: "workspace", path, mimeType }`，由 Worker 读盘转 base64。

列表与文本预览需要 `agent.read`；申请上传、提交上传、删除、建目录、发带附件的消息需要 `agent.chat`。取下载/预览 URL 与 content 跳转需要 `agent.read`。

普通 Agent API 不暴露模型选择、连接配置、仓库状态或命令执行入口。用户上传先入对象存储，再同步到成员 `/work`。对话 `parts` 只存工作区路径；历史图片用同源 `file/content` 加载，控制面 302 到短时预签名。字节不落 PostgreSQL。Agent 产物首次下载时由 Worker `workspace.push` 写入对象存储。

SSE 发送通用 channel event。直播文本、思考和工具状态只做即时扇出；回合结束由 Worker 提交完整消息 `parts`。客户端合并 processing 快照时必须保留更丰富的已直播内容。

## Worker WebSocket

路径：`/internal/v2/agents/ws`。认证通过 `Sec-WebSocket-Protocol: app.bearer.<token>` 或 `Authorization: Bearer`，不要把 token 放进 URL query。

当前协议版本由控制面注册响应提供。主要帧：

- `agent.job`：任务、历史、租约、平台模型引用和可选活动 Skill；用户回合可带 `images`（工作区路径，不含文件字节）；
- `agent.events`：best-effort 流式事件；
- `agent.message` / `agent.message_ack`：最终快照和幂等交付确认；
- `agent.heartbeat`：续租、休眠与失效通知；
- `agent.approval`：外部工具确认结果；
- `agent.settings`：受管连接配置与个人记忆文件；
- `agent.command` / `agent.command_result`：受限工作区 `list` / `read` / `write`（内部 UTF-8）、`put` / `get`（base64 分片）、`pull` / `push`（预签名 HTTP 同步对象存储，单文件 10MB）、`delete` / `mkdir`，以及记忆提取。路径继续走 Worker realpath jail。

租约失效时 Worker 必须取消当前生成。最终消息重发复用同一 `deliveryId`。只有在线且持有有效租约的 Worker 可以接收确认结果。

破坏性协议变化必须提升协议版本、同步 Worker 与控制面，并写入 `CHANGELOG.md`。
