# Cloud Protocol

浏览器只和 Java 后端说话：上行 HTTP，下行 SSE。Worker 只在容器运行时用
WebSocket 连控制面。线协议的事实源是 `backend` 里的 Java DTO，不再使用独立的
npm Protocol 包。

## 浏览器

- 发消息：`POST /api/v2/agent/conversations/{id}/messages`
- 直播：`GET /api/v2/agent/conversations/{id}/events`（SSE，`event: channel`）
- 历史：`GET /api/v2/agent/conversations/{id}/messages`

SSE 体是通用消息事件，包含文本、思考和工具 `parts`。不要把每个 token 写入数据库；
回合结束再写完整快照。

## Worker

路径：`ws://<backend>/internal/v2/agents/ws?token=...`

握手后控制面推送 `agent.job`。生成过程立即推 `agent.events`，结束时用
`agent.message` 提交完整 `parts`。另有心跳、模型环境和休眠帧。

版本、字段和错误语义以 `backend/src/main/java/com/kross` 下的协议类型为准。
破坏性变更必须提升协议版本并写入 `CHANGELOG.md`。
