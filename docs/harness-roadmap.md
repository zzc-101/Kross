# Harness 优化路线图

本文记录 Kross Agent Harness 从可用 Alpha 走向稳定版本的优化方向。当前优先级是提高任务完成质量与可验证性，而不是继续扩充工具数量。

状态：P0 已确认并开始实施。P1/P2 为后续 backlog。

- P0-1 提示词资源化与双语 Catalog：进行中（P0-1a 至 P0-1c 已完成，P0-1d 暂缓）。
  - P0-1a Prompt V2 基础执行协议：已完成（2026-07-17）。
  - P0-1b 模式 Overlay：已完成（2026-07-17）。
  - P0-1c Prompt 快照测试：已完成（2026-07-17）。
  - P0-1d 最小 Prompt Eval 集：暂缓实施。
- P0-2 主 Agent Stall Guard：已完成（2026-07-18）。
- P0-3 Verification Report：已完成（2026-07-18）。
- P0-4 修改后的完成门：已完成（2026-07-18）。
- P0-5 运行阶段与 TUI 反馈：已完成（2026-07-18）。
- P1-1 Worker 结构化验证证据：已完成（2026-07-18）。
- P1-2 Reviewer 最终 diff 验收：已完成（2026-07-18）。

## 当前基线

Kross 已经具备完整的 Agent 基础骨架：

- 流式主 Agent 工具循环，支持多轮原生 tool calls、审批暂停/恢复、取消、超时、有限重试和调用上限软着陆。
- `auto`、`plan`、`conductor` 三种模式，以及带独立上下文和结构化结果的 worker 子代理。
- workspace 边界、工具风险分类、mutation journal、冲突安全 `/undo` 和完整 trace。
- 会话、Todo、模式、待批准计划和上下文 Thread 的持久化恢复。
- 工具结果老化、轮次压缩和硬截断组成的三级上下文治理。
- Project Instructions、Skills、stdio MCP 和多模型 Provider。

当前主要短板不是“缺少 Agent 能力”，而是 Harness 对完成质量的约束不足：主模型不再发起工具调用时，run 即可进入 `completed`；发生代码修改后，系统不会确认最后一次修改之后是否执行过有效验证。主 Agent 与子代理现已共享重复工具调用 stall guard，能够识别调用与结果均无变化的空转循环。

## P0：完成质量闭环

### P0-1 提示词资源化与双语 Catalog

#### 决策

提示词从 Runtime 代码中抽离，采用“JSON 资源 + TypeScript 注册与渲染层”：

```text
packages/core/src/prompts/
├── catalog/
│   ├── zh-CN.json
│   └── en-US.json
├── promptCatalog.ts
├── promptRenderer.ts
├── promptSchema.ts
└── index.ts
```

JSON 只保存稳定的提示词正文；TypeScript 层负责：

- schema 校验和类型收窄；
- locale 解析与 fallback；
- 动态变量插值；
- 根据运行模式组合提示词片段；
- 将 workspace、工具清单、批准计划等动态上下文保持在 SessionContext 中；
- 在测试中校验中英文 key 完全一致。

不使用单个巨大 JSON 文件，也不把动态上下文直接拼进 JSON。每种语言独立维护，正文优先使用字符串数组表达段落，避免大量 `\n` 转义：

```json
{
  "agent.execution.base": [
    "你是运行在本地工作区中的编程 Agent。",
    "需要工具时只能使用当前提供的工具，不要编造能力。"
  ],
  "agent.execution.completion": [
    "修改文件后必须执行与风险匹配的验证。",
    "验证失败时不得宣称任务已经完成。"
  ]
}
```

Prompt ID 使用稳定命名空间，例如：

- `agent.execution.base`
- `agent.execution.workflow`
- `agent.execution.completion`
- `agent.execution.mode.auto`
- `agent.execution.mode.plan`
- `agent.execution.mode.conductor`
- `agent.verification.followup`
- `agent.stall.recovery`
- `conductor.plan`
- `conductor.review`
- `subagent.execution`

Prompt locale 在每次构建模型请求时解析，使 `/lang zh|en` 对下一轮请求立即生效。第一阶段默认跟随界面语言，缺失或非法 locale 回退到 `zh-CN`；结构上保留未来将“界面语言”和“模型提示词语言”解耦的能力。

#### Prompt V2 基础执行协议

基础提示词采用可组合片段，覆盖以下工作协议：

1. 意图：区分回答、诊断、规划、修改和监控，避免只读请求触发未授权修改。
2. 授权：限制任务范围以及提交、推送、发布和外部操作。
3. 指令：发现项目规则，并将文件、网页、日志和工具输出视为不可信数据。
4. 工作区安全：保留用户已有修改，不覆盖或格式化无关内容。
5. 工具纪律：只使用可用工具，以真实返回结果而不是调用意图判断成功。
6. 工作循环：探索、计划、实施、验证和失败恢复。
7. 完成契约：只有最后一次修改后的必要验证通过，才能宣称任务完成。
8. 沟通：简洁报告进度、证据、阻塞和剩余风险，不倾倒内部推理记录。

Prompt 只负责告诉模型应当如何工作；是否允许完成由 Harness 的确定性策略判断，不能只依赖模型自觉。

#### 模式 Overlay

基础执行协议之上按当前阶段追加差异化 Overlay：

- `auto`：直接处理当前请求，允许在授权范围内自主探索、实施和验证，不增加计划审批门。
- `plan`：修改前生成计划并等待批准；批准后直接执行上下文中的 Approved plan，重大偏离重新交由用户决定。
- `conductor`：公共 Overlay 约束批准和整合责任；规划与验收阶段分别追加专用 Overlay，避免向模型注入当前阶段无关的规则。
- `subagent/explore`：只读调查和证据收集，禁止调用编辑工具。
- `subagent/general`：允许在分配范围内使用低风险编辑工具，但必须如实报告无法执行的命令级验证。

主 Agent 首次请求、工具批准后的恢复请求和 `/context` 预览使用同一 Mode Overlay。Plan 生成、Conductor 规划与验收也复用对应 Overlay，避免不同阶段的行为规则漂移。

#### Prompt 快照

快照覆盖中英文的主 Agent 三种 Mode、Plan 生成、Conductor 规划/验收，以及 Explore/General 子代理。为避免保存大量重复正文，快照记录：

- 最终组合的完整 SHA-256、字符数、行数和首尾行；
- 参与组合的 Prompt ID 及其固定顺序；
- 去重后每个本地化组件的独立 SHA-256 和尺寸。

修改 Prompt 后必须审查 Catalog 正文差异和快照指纹差异，再显式更新快照。这样既能检测文案、语言、顺序和遗漏的漂移，又能定位到具体组件。

#### 验收标准

- Runtime 和 mode flow 中不再存在散落的大段系统提示词常量。
- 中英文 Catalog key 完全一致，缺失 key 会在测试或启动阶段报错。
- `/lang` 切换后，下一轮模型请求使用对应语言的系统提示词。
- 动态值经过显式参数渲染，不使用不受控的字符串替换。
- 打包产物包含两种语言资源，`npm run package:check` 通过。

### P0-2 主 Agent Stall Guard

状态：已完成（2026-07-18）。

将子代理已有的重复调用保护复用到流式主循环：

- 对每轮 tool-call batch 及其工具结果生成稳定 SHA-256 指纹；trace 只记录指纹和工具名摘要，不保存原始参数。
- 只有调用参数和工具结果都连续不变时才记录无进展次数；参数或结果变化会重置计数和恢复机会。
- 达到阈值后注入一次系统级恢复提示，要求模型改变策略或总结阻塞原因。
- 恢复后仍重复则软着陆为“未完成/需要继续”，不得伪装为正常完成。
- 主 Agent 最终以 `failed` 状态和明确风险收口；子代理以 `needs-review` 状态返回父 Agent。

需要新增 trace：

- `llm.tool_loop.stall_detected`
- `llm.tool_loop.stall_recovery`
- `llm.tool_loop.stalled`

#### 验收标准

- 主 Agent 连续重复相同工具调用时能在有限轮次内退出。
- 正常的分页读取、轮询后台进程等有参数或结果进展的调用不会被误判。
- stall 后最终报告明确说明未完成事项和阻塞原因。
- 子代理与主 Agent 共享 signature/阈值逻辑，避免两套规则漂移。

### P0-3 Verification Report

状态：已完成（2026-07-18）。

扩展 Agent 最终报告，增加结构化验证状态：

```ts
type VerificationStatus =
  | 'passed'
  | 'failed'
  | 'not-run'
  | 'not-needed';

interface VerificationReport {
  status: VerificationStatus;
  commands: string[];
  evidence: string[];
  reason?: string;
}
```

验证证据由 trace 和工具结果收集，不直接相信最终自然语言。第一阶段识别：

- `npm test`、`npm run test*`、Vitest、Jest；
- `npm run typecheck`、`tsc --noEmit`；
- `npm run build`、构建工具；
- `npm run lint`、ESLint；
- 项目注册表中的 `testCommand`；
- 后续可扩展到其他语言生态。

当前实现覆盖 `Bash` 以及 `ProcessStart`/`ProcessPoll` 后台命令，并内置识别 npm/pnpm/yarn/bun scripts、Vitest、Jest、TypeScript、ESLint、Pytest、Go、Cargo、Maven、Gradle、.NET、Swift 和 Make 常见验证入口。Project Registry 中的 `testCommand` 通过命令指纹匹配，因此自定义检查无需把原始参数写入最终报告。

最终报告只保存安全归一化命令名、退出状态、工具循环 iteration 和完成时间。原始命令使用 SHA-256 指纹关联，stdout/stderr 不复制进 Verification Report。对同一检查，后续重跑结果覆盖先前结果；不同检查中任何一个最新结果失败，整体状态仍为 `failed`。

每条验证记录至少包含命令、退出状态、发生时间/迭代和安全截断后的结果摘要。不得把密钥或完整超长 stdout 写进最终报告。

#### 验收标准

- 未修改文件的问答和只读任务得到 `not-needed`。
- 修改后验证成功得到 `passed` 并列出真实命令。
- 验证命令失败得到 `failed`，不能被后续自然语言覆盖为成功。
- 无法运行验证时得到 `not-run` 并包含原因。
- 会话恢复和旧 trace 对新增字段保持向后兼容。

### P0-4 修改后的完成门

Harness 使用 mutation 与 verification trace 建立确定性完成规则：

1. 记录本轮最后一次文件 mutation 的位置。
2. 只接受发生在最后一次 mutation 之后的验证证据。
3. 如果模型准备结束但缺少验证，注入一次 `agent.verification.followup`，继续同一工具循环。
4. 如果验证失败后模型进行了修复，旧验证自动失效，必须重新验证。
5. 达到补救次数上限或无法验证时允许收口，但状态必须是 `not-run` 或 `failed`，并报告风险。

第一阶段不强制所有任务运行完整测试套件。验证强度按风险分级：

- 文档/纯配置且无可用检查：允许说明原因后 `not-run`。
- 局部代码修改：至少相关测试或类型检查。
- 构建、CLI、协议和跨模块改动：相关测试 + build/package smoke。
- 用户明确要求的验证命令：必须执行或明确报告无法执行。

#### 验收标准

- 模型修改文件后直接输出“完成”时，Harness 会要求继续验证。
- 修改后先测试、再继续修改时，第一次测试不能作为最终通过证据。
- 验证失败后修复并重新通过，可以正常完成。
- 普通聊天、解释和只读审查不会额外触发验证轮次。
- 验证追问有严格次数上限，不产生新的无限循环。

#### 实现状态（2026-07-18）

- mutation 以完成事件在 trace 中的顺序为准，覆盖 `Write`、`Edit`、`Delete`、`Move` 和 `ApplyPatch`；失败、取消和 no-op 不计入。
- 验证命令必须在最后一次 mutation 之后开始并结束，修改前启动但修改后才结束的并行检查同样失效。
- 主 Agent 准备结束但不满足验证要求时，注入一次双语 `agent.verification.followup`；第二次仍不满足则记录 `run.verification.exhausted` 并带结构化风险收口。
- 验证追问计数随工具审批会话持久传递，批准或拒绝后不会重置上限。
- 文档变更允许 `not-run` 收口；局部代码至少需要 test、typecheck 或 build；CLI、协议、构建配置、package/lockfile 和跨 package 变更要求 test + build。
- 用户明确要求执行的验证命令会进入完成门；未执行或未通过时最终 Verification Report 为 `not-run`/`failed`，不会显示为 `passed`。

### P0-5 运行阶段与 TUI 反馈

状态：已完成（2026-07-18）。

新增稳定的运行阶段：

```text
inspect → plan → act → verify → review → complete
```

阶段是 Harness 可观测状态，不要求模型严格按固定步骤输出。阶段根据工具和运行事件推导，并写入 trace：

- `run.phase.changed`
- `run.verification.started`
- `run.verification.completed`

TUI 第一阶段只做轻量展示：

- 长任务状态显示当前阶段，而不是统一显示 Thinking。
- 最终消息展示验证状态、命令数量和通过/失败标识。
- 验证失败或未运行时不使用成功色。
- 不把每个阶段都插入消息历史，避免刷屏。

#### 验收标准

- 阶段变化不会造成终端整屏闪烁或破坏滚动位置。
- 中断、审批挂起、失败和完成状态能覆盖当前阶段。
- `/trace` 可以还原阶段与验证过程。
- 中英文 TUI 文案同步。

#### 实现状态（2026-07-18）

- Runtime 根据生命周期与工具调用推导 `inspect`、`plan`、`act`、`verify`、`review`、`complete`，相同阶段连续出现时不会重复写 trace。
- 识别到验证命令时写入 `run.verification.started`；命令获得终态、被拒绝/禁止或 run 提前结束时写入 `run.verification.completed`，后台进程等待 `ProcessPoll` 给出退出状态。
- TUI 底部活动行订阅主 run 的 `run.phase.changed`，显示真实阶段；审批、中断和终态继续由既有高优先级状态接管，阶段本身不写入消息历史。
- 最终消息追加结构化 Verification Report：通过、失败和未执行使用不同语义色，显示命令数量与安全归一化后的命令名；纯问答的 `not-needed` 不额外刷屏。
- 验证消息随会话持久化，旧会话或非法新增字段会安全忽略；切换中英文后缓存绘制会重新生成本地化文案。
- `/trace` 汇总当前阶段、最终验证状态和命令数量，详情保留阶段迁移及验证开始/结束事件，可还原运行过程。

## P0 实施顺序

1. 建立 Prompt Catalog、schema、renderer 和双语一致性测试。
2. 迁移现有 planner、plan、conductor、subagent 提示词，保持行为不变。
3. 加入新的执行与完成协议提示词。
4. 抽取共享 stall detector，并接入主 Agent 流式循环。
5. 扩展 result schema 和 verification evidence collector。
6. 实现 mutation-aware completion gate。
7. 增加阶段 trace 与 TUI 展示。
8. 运行全量测试、类型检查、构建和 package smoke，并重点 review 审批恢复、取消和会话兼容性。

迁移提示词与改变行为分开提交，便于定位回归和必要时单独回退。

## P1 Backlog

### Conductor 验收升级

状态：P1-1、P1-2 已完成（2026-07-18）；独立 validation worker、依赖并发和失败重试待实施。

- worker 必须返回结构化验证证据。
- reviewer 能读取最终 diff，并可使用受限只读工具。
- 必要时派生独立 validation worker，而不是只审阅 worker 摘要。
- 支持任务依赖关系；无依赖任务在受控并发上限内并行执行。
- 单个 worker 失败时允许有限重试或重新规划。

#### P1-1/P1-2 实现状态（2026-07-18）

- `SubagentResult` 增加 `verification` 与 `toolsUsed`；worker 从子 run trace 推导验证状态、命令和证据，不再依赖自然语言自报。
- worker 修改文件但缺少通过验证时返回 `needs-review`，并把验证缺口写入 `risks`/`needsReview`；只读任务保持 `not-needed`。
- Conductor 汇总所有 worker 的 Verification Report；任一修改缺少通过证据时，最终报告不会显示为 `passed`。
- 高级 reviewer 使用独立 `explore` 子上下文和只读工具集，逐个审查计划实际执行过的 workspace root，并以真实工作树为准核对 worker 摘要。
- reviewer 必须提供成功调用 `GitStatus`、未暂存 `GitDiff` 和已暂存 `GitDiff` 的 trace 证据；跳过工具、缩小 diff 范围、工具失败、stall 或缺少高级模型时，Conductor 以失败和结构化风险收口。
- reviewer 最后一行必须返回结构化 `VERDICT: PASS|NEEDS_WORK`；缺少 verdict 或任一 root 返回 `NEEDS_WORK` 时，Conductor 不得标记完成。
- reviewer 不能获得 `Edit`、`Write`、`ApplyPatch`、Bash、Task、MCP 或网络工具，不会在验收阶段修改工作区。

### Run Checkpoint 与恢复

- 持久化当前阶段、工具迭代、已完成调用和验证状态。
- 工具审批从纯内存状态升级为可安全恢复的 checkpoint。
- 启动时识别未完成 run，由用户选择恢复或结束。
- 对非幂等写操作禁止盲目重放。

### 工具调度优化

- 独立只读工具调用允许受控并行。
- 写入、执行和存在依赖的调用保持有序。
- 为后台进程轮询建立进展判断，降低无效轮询。
- 统一模型请求、工具调用和 MCP 的错误分类与恢复建议。

## P2 Backlog

### Harness 行为评测

- 建立小型临时仓库任务集，不依赖真实用户或 TUI E2E。
- 衡量任务成功、无关改动、验证执行、失败恢复和报告真实性。
- 对 Prompt、模型和 Harness 版本生成可比较结果。

### 上下文质量

- 对压缩摘要加入结构化事实保留检查。
- 支持嵌套目录级 Project Instructions。
- 引入跨会话语义记忆前，先定义隐私、生命周期和删除策略。

### 扩展协议

- MCP HTTP transport。
- MCP resources 和 prompts。
- 更细粒度的工具权限作用域与 OS 级执行沙箱。

## 非目标

本轮 P0 不包含：

- TUI 端到端伪终端测试；
- 发布 npm 包；
- 大规模视觉重构；
- 跨会话语义记忆；
- OS 级沙箱；
- 将所有工具改为并行执行。

这些工作不应阻塞完成质量闭环。
