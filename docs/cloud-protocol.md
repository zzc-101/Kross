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
- `GET /api/v2/agent/workspace/file?path=`
- `GET /api/v2/agent/skills`
- `GET/POST/PATCH/DELETE /api/v2/agent/memories...`

普通 Agent API 不暴露模型选择、连接配置、仓库状态或命令执行入口。

SSE 发送通用 channel event。直播文本、思考和工具状态只做即时扇出；回合结束由 Worker 提交完整消息 `parts`。客户端合并 processing 快照时必须保留更丰富的已直播内容。

## Worker WebSocket

路径：`/internal/v2/agents/ws`。认证通过 `Sec-WebSocket-Protocol: app.bearer.<token>` 或 `Authorization: Bearer`，不要把 token 放进 URL query。

当前协议版本由控制面注册响应提供。主要帧：

- `agent.job`：任务、历史、租约、平台模型引用和可选活动 Skill；
- `agent.events`：best-effort 流式事件；
- `agent.message` / `agent.message_ack`：最终快照和幂等交付确认；
- `agent.heartbeat`：续租、休眠与失效通知；
- `agent.approval`：外部工具确认结果；
- `agent.settings`：受管连接配置与个人记忆文件；
- `agent.command` / `agent.command_result`：受限工作区 list/read/write 和记忆提取。

租约失效时 Worker 必须取消当前生成。最终消息重发复用同一 `deliveryId`。只有在线且持有有效租约的 Worker 可以接收确认结果。

破坏性协议变化必须提升协议版本、同步 Worker 与控制面，并写入 `CHANGELOG.md`。
