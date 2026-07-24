# Agent Harness

Kross 的 Harness 位于模型与本地开发环境之间。它不只负责转发提示词，还负责约束工具执行、判断任务是否具备完成条件，并保存可审计、可恢复的运行状态。

## 运行闭环

```mermaid
flowchart LR
    U["用户任务"] --> P["Prompt 与模式策略"]
    P --> L["主 Agent 工具循环"]
    L --> G["权限与工具调度"]
    G --> W["Workspace / Process / MCP"]
    W --> V["Mutation 与验证证据"]
    V --> C{"完成门"}
    C -->|"证据不足"| L
    C -->|"满足或如实降级"| R["结构化结果"]
```

一次正常运行会经历探索、计划、执行、验证、复核和完成等可观测阶段。阶段由真实工具与生命周期事件推导，不要求模型用固定格式自报；TUI 和 `/trace` 可以展示这些状态。

## Prompt 与模式

- 提示词使用中英文 JSON Catalog，并由 TypeScript 渲染层完成 schema 校验、locale fallback、变量插值和模式组合。
- `auto` 在授权范围内直接探索、实施和验证。
- `plan` 先生成计划，得到用户批准后进入同一主 Agent 工具循环。
- `conductor` 由高级模型拆分任务，worker 在隔离上下文执行，最后再由高级模型读取真实最终 diff 验收。
- 主 Agent、审批恢复、Context 预览和子代理使用同源的行为协议，减少提示词漂移。

Prompt 负责告诉模型如何工作，但关键安全与完成规则由 Harness 的确定性代码执行，不能只依赖模型遵守自然语言要求。

## 完成质量

### Stall Guard

主 Agent 和子代理会对连续工具批次及结果生成稳定指纹。相同调用与相同结果重复出现时，Harness 会先注入一次恢复提示；仍无进展则停止循环并明确报告任务未完成，避免无限空转。

### Verification Report

最终结果包含 `passed`、`failed`、`not-run` 或 `not-needed` 的结构化验证状态。证据来自真实 trace 和工具结果，而不是模型在最终回复中的自我声明。

Harness 能识别常见 test、typecheck、build 和 lint 命令，也能跟踪通过 `ProcessStart` / `ProcessPoll` 运行的后台验证。

### Mutation-aware Completion Gate

当运行产生代码修改时：

1. 只接受最后一次 mutation 之后启动并完成的验证。
2. 如果模型过早准备结束，Harness 最多注入一次确定性验证追问。
3. 修复发生后，旧验证自动失效。
4. 验证失败或无法执行时可以收口，但必须保留 `failed` / `not-run` 状态和风险，不能伪装成成功。

## Conductor 验收

- 任务计划支持 `dependsOn`，无依赖 worker 最多 3 个并发执行。
- worker 返回结构化验证证据与实际使用工具；修改代码但缺少验证会标记为 `needs-review`。
- worker 只有在能够证明没有产生修改时才允许有限重试；异常或不确定 mutation 状态会 fail-closed。
- 对缺少有效验证的变更，Conductor 可以派生只读上下文中的 validation worker，通过受限 `Verify` 工具执行单条可识别验证命令。
- 最终 reviewer 必须读取各 workspace root 的 Git status、暂存和未暂存 diff，并返回明确 verdict。任何 root 验收失败都会阻止成功收口。

## Checkpoint 与安全恢复

Session Work State 会持久化版本化 `runCheckpoint`，其中包含运行阶段、工具迭代、验证状态、已完成调用 id、待审批调用和后续调用队列。

- 等待工具审批时，open turn 与 checkpoint 会一起保存；重新打开会话后审批面板可以继续出现。
- 恢复前会核对 assistant tool call、已有 tool result、当前工具定义、动态风险和审批策略。
- 只有明确尚未执行的待审批调用可以恢复。已完成调用只作为证据存在，绝不会因恢复而重新执行。
- 如果证据损坏、工具消失或策略发生变化，恢复会 fail-closed，并把悬空轮次安全转为 interrupted。
- 任意 LLM 或工具执行中间点发生崩溃时不会猜测性续跑，尤其不会盲目重放 write / execute 操作。

## 工具调度与错误恢复

- 连续、独立、策略预检允许的 read 调用最多 4 个并发，并按模型原始 tool-call 顺序回填结果。
- write、execute、network、Process、MCP、动态升级风险或需要审批的调用保持串行屏障。
- `ProcessPoll` 根据输出与终态判断进展；连续无变化时从 250ms 指数退避到最多 4 秒。
- 模型、工具和 MCP 错误统一归类为 source、category、retryable 与 recovery。MCP `isError` 会作为失败而不是成功进入 trace 和工具 observation。

## 可观测性

- `/trace [runId]`：查看阶段迁移、工具调用、审批、验证、重试和失败。
- `/diff`：查看本轮涉及的文件和 Git diff 摘要。
- `/context`：查看 token 预算、上下文来源与治理记录。
- Verification Report：在最终消息中展示真实验证状态、命令和风险。

Trace、session checkpoint 和 mutation journal 都可能包含本地路径、源码片段或工具参数，分享前应检查敏感信息。

## 当前边界

- `Bash` 和后台进程没有 OS 级沙箱；审批与 workspace cwd 不能替代操作系统隔离。
- 尚未建立真实模型驱动的临时仓库 Harness Eval 集；当前 CI 主要验证确定性机制。
- 跨会话语义记忆、MCP HTTP transport、resources 和 prompts 尚未实现。
- 嵌套目录级 Project Instructions 尚未实现，目前按 workspace root 加载。
