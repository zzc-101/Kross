# Provider 调用观测

Kross 在 LLM Client 边界记录版本化的 `LlmCallMetrics`。指标只包含 Provider、
模型、状态、耗时、usage、是否限流和错误类别，不保存 prompt、回复正文、API Key
或 Provider 错误响应 body。

## 指标字段

每次 `complete` 或 `stream` 调用可提供：

- `durationMs`；
- input、output、total token；
- Provider 可用时的 cache read、cache write 和 reasoning token；
- Provider 响应或 pi-ai 模型目录可计算时的 `estimatedCostUsd`；
- `completed`、`failed` 或 `aborted`；
- `rateLimited` 和稳定错误类别。

| 错误类别 | 典型来源 |
|---|---|
| `authentication` | HTTP 401 |
| `permission` | HTTP 403 |
| `rate-limit` | HTTP 429 |
| `invalid-request` | 其他 HTTP 4xx |
| `server` | HTTP 5xx |
| `network` | Fetch/连接失败 |
| `timeout` | 请求或流空闲超时 |
| `aborted` | 用户取消或信号中止 |
| `unknown` | 无法安全归类的错误 |

最近一次调用指标会附加到对应 LLM 完成 Trace 事件中，供诊断和报告使用。它是
单次调用的短期观测，不是计费账本；Provider 账单仍是最终费用事实源。

## 费用边界

pi-ai 返回的 cost 来自当前模型目录费率和 Provider usage，Kross 将其标记为估算
费用。OpenAI-compatible Provider 如果在 usage 中返回 `cost`，也会被保留。
没有 Provider 数据或目录价格时，费用字段缺失；系统不会根据模型名称硬编码价格。

Prompt caching capability 只表示 Adapter 可以使用缓存。实际 cache read/write
token 必须以 usage 为准，未返回不等于零命中。

## 与 Eval 矩阵的关系

```bash
npm run eval -- --fixture --matrix
```

该命令生成按 Provider/模型聚合的兼容矩阵。当前 Fixture 数据用于验证报告算法和
Runtime 契约；真实模型结果必须显式运行真实 Provider Eval，并遵守预算和密钥
决策门。不得仅凭模型厂商说明或单次手工对话发布兼容榜单。
