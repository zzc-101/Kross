# Provider 能力与兼容边界

Kross 使用 Provider Adapter 声明当前模型的端到端能力。Runtime、TUI、Cloud
Worker 和 Web 只读取统一声明，不通过模型名称字符串猜测功能。

## Capability v1

| 字段 | 含义 |
|---|---|
| `toolCalling` | 当前 Adapter 能否发送并解析工具调用 |
| `thinking` | 当前 Adapter/模型能否产生 reasoning/thinking |
| `structuredOutput` | Kross 是否已经提供结构化响应请求契约 |
| `promptCaching` | 当前 Adapter 协议是否支持提示缓存 |
| `multimodalRead` | Kross 消息契约是否能向该模型发送图片等多模态输入 |

`source` 为 `model-catalog` 时，声明来自 pi-ai 的具体模型元数据；未知或私有模型
使用 `adapter-default`，只声明 Kross 协议 Adapter 能保守保证的能力。

能力表示 Kross **端到端已经接通**的功能，而不是厂商宣传的全部上游能力。例如，
模型目录可能声明图片输入，但当前 `LlmMessage` 仍是文本契约，因此
`multimodalRead` 保持 `false`；structured output 尚无公共请求契约，也保持
`false`。这可以避免 UI 或 Runtime 展示尚不可用的功能。

## 消费规则

- Runtime 在 `toolCalling: false` 时不会向模型发送工具定义。
- 非 `off` 的思考强度在 `thinking: false` 时会被拒绝。
- Cloud Session Snapshot 携带同一份 capability，Web 不展示不支持的思考档位。
- 切换 pi-ai 目录模型时 capability 随模型重新计算，不需要维护 Runtime 特判。
- 新增 Provider 或协议能力时，应先在 Adapter 添加测试，再由上层消费；禁止在
  Runtime、TUI 或 Web 中增加模型名称正则表达式。

`promptCaching: true` 只说明 Adapter 协议具备缓存能力，不承诺每次调用都会命中。
实际命中 token 和费用必须以 Provider 返回的 usage 为准。
