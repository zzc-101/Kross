# Cloud Protocol

Kross Cloud Protocol 是 Web、Gateway 与 Workspace Worker 之间的版本化线协议。
TypeScript 实现以 Zod schema 为事实源，同时提交 Draft-07 JSON Schema，供 Go、
Python、Java 或其他控制面直接验证消息。

## 语言无关产物

当前 `PROTOCOL_VERSION` 为 `1`：

| 产物 | 用途 |
|---|---|
| [Client Command v1](schemas/kross-client-command-v1.schema.json) | 验证客户端发出的命令 |
| [Server Event v1](schemas/kross-server-event-v1.schema.json) | 验证未封装的服务端事件 |
| [Event Envelope v1](schemas/kross-event-envelope-v1.schema.json) | 验证带工作区、序号和时间的回放事件 |

Schema 的 `$id` 指向仓库中的稳定路径，`x-kross-protocol-version` 与
`PROTOCOL_VERSION` 一致。应用版本、数据格式版本和协议版本彼此独立。

修改 `packages/protocol/src/schemas.ts` 后运行：

```bash
npm run protocol:update
npm run protocol:check
```

普通 CI 会执行 `protocol:check`，阻止 Zod 与已提交 JSON Schema 漂移。生成器允许
增加可选字段和新的命令/事件分支；移除字段或分支、改变 required 状态、移除 enum
值或收紧基本约束会被视为破坏性变更。此时必须提升 `PROTOCOL_VERSION`，生成新的
版本文件，并保留旧文件供已有客户端使用。

## 命令与结果关联

每条 Client Command 至少包含：

```json
{
  "protocolVersion": 1,
  "requestId": "client-generated-id",
  "type": "workspace.list"
}
```

- `requestId` 由客户端生成，用于幂等和结果关联；重试同一操作时复用原值。
- 服务端先返回 `request.accepted` 或 `request.error`。
- 后续 Event Envelope 使用 `correlationId` 指回触发它的 `requestId`。
- 会话命令同时携带 `workspaceId` 和 `sessionId`；工作区控制命令只携带所需范围。
- 未识别的 `protocolVersion` 必须明确失败，不能猜测性降级。

`request.error.code` 是供程序分支使用的稳定非空字符串，`message` 是面向用户的
说明。客户端不应解析自然语言 `message` 推断错误类型，也不应把 HTTP 成功状态
等同于 Agent 运行成功。

## 事件序号与回放

Event Envelope 的 `seq` 在工作区会话事件流中单调递增。客户端应：

1. 按 `seq` 去重并持久化最后成功应用的序号；
2. 重连时发送 `session.resume`，并把该序号放入 `lastSeq`；
3. 依次应用服务端重放事件；
4. 收到 `replay.complete` 后切换到实时事件；
5. 发现序号缺口或收到无法解析的版本时停止应用，重新请求快照。

回放只重放已记录的事件与派生状态，不重新执行工具、Git 或其他外部副作用。
`session.snapshot` 是恢复 UI 的权威状态，流式 delta 不能单独作为持久化事实源。

## Python 消费示例

[Python 示例](../examples/protocol/validate_event.py)不导入任何 Kross TypeScript
代码，直接用提交的 JSON Schema 验证 Event Envelope：

```bash
python3 -m pip install 'jsonschema>=4,<5'
python3 examples/protocol/validate_event.py
```

生产客户端还应对 `requestId`、`correlationId`、`seq` 和断线恢复建立本地状态，
而不是只做单条 JSON 校验。
