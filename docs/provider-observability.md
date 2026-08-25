# Provider 调用观测

Kross 在 LLM Client 边界记录版本化 `LlmCallMetrics`。指标不保存 prompt、回复正文、API Key 或 Provider 错误响应 body。

## 指标

- Provider、模型、状态与耗时；
- input、output、total token；
- 可用时的 cache read/write 与 reasoning token；
- Provider usage 或模型目录可计算时的估算费用；
- 限流标记和稳定错误类别。

错误类别包括 authentication、permission、rate-limit、invalid-request、server、network、timeout、aborted 和 unknown。

指标附加到对应 LLM 生命周期事件，并汇总到控制面 usage。它们用于运维与容量分析，不在普通工作台显示模型、Token 环或底层错误 payload。Provider 账单仍是费用事实源。

估算费用只在 Provider usage 或当前模型目录提供费率时存在。未返回缓存 token 不等于零命中，未返回费用也不应按模型名称猜测。
