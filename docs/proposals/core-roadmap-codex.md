# Kross Core 后续发展建议（Codex 草案）

> 状态：模型建议草案，不代表项目正式路线图。
> 作者：Codex
> 日期：2026-07-24
> 用途：与其他模型或贡献者的独立建议进行比较，最终融合成一份经过确认的开发路线图。

## 一、总体判断

Kross 已经度过“验证 Coding Agent 能否实现”的阶段。当前 TUI、Cloud、Agent
Runtime、工具循环、上下文、会话恢复、审批、验证和子代理已经形成完整闭环。

下一阶段不应继续以功能数量为主要目标，而应集中在：

1. **可靠性**：任务完成、失败和恢复行为可预测。
2. **可评测**：Prompt、模型和 Runtime 改动能够量化比较。
3. **可扩展**：社区可以在不侵入内部实现的情况下增加工具、模型、存储和客户端。

建议将 Kross 的长期定位收敛为：

> 一个本地优先、可自托管、可审计、可恢复的 Coding Agent Runtime，同时提供成熟
> 的 TUI 和 Cloud 参考实现。

Kross 的差异化不应是界面最多或内置工具最多，而应是 Agent 执行质量、用户控制、
失败恢复和扩展边界。

## 二、Core 当前阶段

Core 当前约有 2.6 万行业务代码，覆盖：

- Agent Runtime 与模式流程；
- 模型 Provider 和流式工具调用；
- Context、压缩和预算治理；
- Tool Gateway、风险分类和审批；
- 会话、Checkpoint 与安全恢复；
- mutation journal 与冲突保护撤销；
- Harness 完成门与 Verification Report；
- 子代理与 Conductor 编排；
- Skills、MCP、Todo、Trace 和后台进程。

这个规模还不需要为了形式整齐拆成大量 package，但已经需要主动管理公共 API、
依赖方向和内部模块边界。继续无节制横向增加能力，会让 Core 逐渐成为难以维护的
大而全框架。

## 三、建议优先发展的能力

### 1. 建立 Agent Harness Eval

这是优先级最高的建议。

当前自动化测试主要验证确定性代码，但还不能回答：

- 不同模型完成同一任务的成功率；
- Prompt 修改后质量是否提升；
- 上下文压缩是否丢失关键信息；
- 工具重试是否真正提高成功率；
- Conductor 是否优于单 Agent；
- 不同 Provider 的工具调用兼容性；
- 完成质量、Token、时间和费用之间的关系。

建议建立临时 Git 仓库驱动的评测集：

```text
evals/
├── fix-typescript-error
├── add-api-endpoint
├── repair-failing-test
├── multi-file-refactor
├── recover-after-tool-failure
└── resume-pending-approval
```

每个 Eval Case 应定义：

- 初始仓库状态；
- 用户请求；
- 允许的工具和最大运行轮数；
- 必须或禁止修改的文件；
- 验收命令；
- 确定性评分规则；
- 模型、Prompt 和 Runtime 版本；
- Token、费用、耗时和工具轮数。

第一阶段不必追求大型公开 Benchmark。先建立 10–20 个能够稳定复现项目关键能力
的小型任务，并让 CI 使用 Mock/Fixture 验证 Eval Harness 本身；真实模型评测可以
按需或定期执行。

### 2. 收窄并稳定 Core 公共 API

当前 `packages/core/src/index.ts` 导出了大量内部模块。如果未来发布
`@kross/core`，这些导出会变成兼容性负担。

建议将接口分为三层：

```text
Public API
├── createAgentHost
├── AgentRuntime
├── ToolDefinition
├── LlmClient
├── RuntimeEvent
└── RuntimeResult

Extension Contracts
├── SessionStore
├── TraceStore
├── ApprovalPolicy
├── ContextSource
├── SandboxProvider
└── SubagentRunner

Internal
├── ModeFlows
├── ModelSession
├── SessionServices
├── ToolLoop internals
└── Checkpoint implementation
```

顶层 package 只导出承诺兼容的入口。必要的实验性能力可以通过明确标记的
`@kross/core/experimental` 暴露；内部实现不应因为暂时被其他包引用，就自动成为
稳定 SDK。

在正式发布公共 Core API 前，应完成：

- API inventory；
- 公共类型命名和文档；
- 最小嵌入示例；
- SemVer 与弃用策略；
- API surface 测试；
- 防止意外新增导出的检查。

### 3. 用适配器扩展，而不是继续堆固定实现

建议逐步形成以下窄接口：

- `SessionStore`
- `TraceStore`
- `MutationStore`
- `CheckpointStore`
- `SecretsProvider`
- `SandboxProvider`
- `ContextRetriever`
- `ApprovalPolicy`
- `LlmClient`

Core 提供本地 JSONL、SQLite、文件系统和本机进程默认实现。社区或未来 SaaS 可以
实现 PostgreSQL、对象存储、远程执行、专用密钥服务或其他 Adapter，而不重写 Agent
行为。

抽象必须由真实的第二种实现推动。不要只为“以后可能需要”提前制造大量接口。

### 4. 完善 MCP，而不是持续增加内置工具

普通第三方工具继续内置到 Core 的边际价值已经降低。更适合通过 MCP 交给生态扩展。

建议补齐：

- HTTP transport；
- resources；
- prompts；
- 运行时刷新连接；
- capability 检查；
- OAuth 或外部凭证引用；
- 连接超时、断线和重连；
- 更细粒度的风险覆盖。

所有 MCP 调用仍必须经过 Tool Gateway 的 schema、风险、审批、Trace、取消和重试，
不能形成绕过现有安全边界的第二条执行通道。

### 5. 建立可替换的 Sandbox 层

当前本地 `Bash` 和后台进程没有 OS 级沙箱，这是明确的安全边界。

可以定义类似以下接口：

```ts
interface ExecutionSandbox {
  run(command: CommandInput): Promise<CommandResult>;
  startProcess(input: ProcessInput): Promise<ProcessHandle>;
  dispose(): Promise<void>;
}
```

可能的实现包括：

- `HostSandbox`：保持当前行为；
- `DockerSandbox`；
- Linux namespace/bubblewrap；
- macOS 可用的受限执行方案；
- 远程 Worker sandbox。

Core 不必独自实现所有平台隔离，但 Bash、Process 和验证命令不应永远绑定宿主机
执行方式。

### 6. 增强持久化兼容性与恢复诊断

当前只恢复证据完整且尚未执行的审批调用，这种 fail-closed 策略应继续保留。

后续可增强：

- 存储格式版本和迁移；
- Checkpoint 完整性检查；
- 会话导入和导出；
- 崩溃后的诊断报告；
- 长任务阶段性保存；
- Trace replay 调试工具；
- 备份和恢复验证。

不建议追求“任意执行点无缝继续”。LLM 请求和外部命令没有天然的 exactly-once
语义，恢复设计仍应以不重复副作用为第一原则。

### 7. 优先做项目知识检索，谨慎做自动长期记忆

相比自动记录所有跨会话内容，更建议先做可解释的项目知识检索：

- 文件和符号索引；
- README、架构和决策文档索引；
- Git 历史检索；
- 来源引用；
- 用户明确控制写入、查看和删除；
- `/memory` 或等价的可检查入口。

不建议默认把所有对话写入向量库。错误、过期或不可解释的记忆可能比没有记忆更
危险。

### 8. 统一模型能力、兼容性与成本信息

Provider Adapter 可以继续完善：

- 工具调用能力检测；
- thinking/reasoning 统一表示；
- Prompt caching；
- Structured output；
- 多模态输入；
- Token 与费用统计；
- 限流和重试信息；
- 上下文窗口可信来源；
- Provider 兼容性矩阵。

模型差异应封装在 Provider Adapter 内，避免在 Runtime 主流程中持续增加模型专用
分支。

## 四、Core 结构建议

现阶段不建议立即拆成多个独立 npm package。可以先在 `packages/core` 内强化模块
边界：

```text
core/
├── contracts       稳定接口和领域类型
├── host            默认组合根
├── runtime         执行生命周期
├── context         上下文治理
├── tools           工具契约和默认实现
├── session         会话与恢复
├── providers       模型适配
├── observability   Trace、指标与统计
└── adapters        本地存储、进程与文件系统实现
```

只有一个模块同时满足以下条件时，才考虑独立 package：

1. 存在独立使用者；
2. 能够独立发布；
3. 有清晰稳定接口；
4. 不依赖 Core 内部状态；
5. 拆分能真正减少依赖，而不只是移动文件。

## 五、建议路线

### v0.1：正式开源发布

目标是让陌生用户稳定安装和使用，而不是增加新功能：

- 发布 npm CLI；
- 发布版本化 Docker 镜像；
- 创建 GitHub Release；
- 完成安装、升级、卸载和故障恢复说明；
- 保持 TUI 与 Cloud 最小 Smoke Test；
- 明确支持的 Node、Docker 和操作系统版本；
- 建立 Issue、PR 和安全反馈闭环。

### v0.2：扩展平台

- 收敛 Core 公共 API；
- 完善 Skills 与 MCP；
- 提供 Tool、Provider、Store 示例；
- 导出语言无关的 Protocol schema；
- 建立配置和持久化迁移机制。

### v0.3：质量与评测

- Harness Eval；
- Provider 兼容性矩阵；
- Trace replay；
- Prompt、模型和 Runtime 版本对比；
- 成功率、成本和耗时报告。

### v0.4：隔离与可移植性

- Sandbox Adapter；
- 远程执行接口；
- 更完整的恢复和备份；
- 为分布式调度或独立 SaaS 控制面提供稳定协议。

版本顺序可以根据真实社区反馈调整，阶段名称不应被理解为固定发布日期承诺。

## 六、近期不建议做的事情

- 再维护一个独立 GUI 客户端；
- 把大量第三方能力继续做成内置工具；
- 过早构建任意规模的多 Agent swarm；
- 默认记录所有跨会话内容；
- 在当前开源仓库加入用户、计费和多租户 SaaS 逻辑；
- 因为未来可能做 SaaS 而提前重写语言；
- 为了目录整齐把 Core 拆成大量 package；
- 在没有第二种实现前抽象所有内部服务。

## 七、建议的优先级

| 优先级 | 方向 | 主要收益 |
|---|---|---|
| P0 | 发布 v0.1 与最小真实验收 | 建立可使用、可反馈的开源基线 |
| P0 | Harness Eval | 让后续优化有客观标准 |
| P1 | Core 公共 API 收敛 | 降低兼容成本，支持社区扩展 |
| P1 | MCP 完善 | 扩展生态，减少内置工具膨胀 |
| P1 | Provider 兼容性与成本统计 | 提高多模型可用性 |
| P2 | 持久化迁移与 Trace replay | 提升长期维护和诊断能力 |
| P2 | Sandbox Adapter | 改善本地执行安全与可移植性 |
| P2 | 可解释项目知识检索 | 提升大型仓库任务质量 |

## 八、需要其他模型独立回答的问题

为便于后续融合，建议其他模型不要只评价本文，而是独立回答：

1. Kross 最有差异化价值的三项能力是什么？
2. Core 当前最可能失控的模块或依赖是什么？
3. v0.1 发布前必须完成哪些事项？
4. Harness Eval 应如何设计，才能避免为特定模型过拟合？
5. 哪些接口值得成为稳定公共 API，哪些必须保持内部实现？
6. MCP、Skills、原生 Tool SDK 三种扩展方式应如何分工？
7. 是否需要 Sandbox Adapter，优先支持哪些平台？
8. 跨会话记忆是否值得做，如何避免错误记忆与隐私风险？
9. 哪些方向应明确列为非目标？
10. 如果只能选择三项工作作为下一阶段，应选择什么，为什么？

## 九、融合建议

收集多份模型建议后，建议按以下步骤融合：

1. 提取所有建议中的共同结论；
2. 单独列出互相冲突的判断；
3. 用当前代码、用户反馈和维护成本验证冲突；
4. 把建议分为“现在做、验证后做、明确不做”；
5. 为每一项写清目标、非目标、验收标准和停止条件；
6. 最终路线图只保留已经由项目维护者确认的内容。

本文件在融合完成后可以保留为决策输入，也可以由最终路线图替代。
