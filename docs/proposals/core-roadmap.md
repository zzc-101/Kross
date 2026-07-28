# Kross 后续路线图（融合稿）

> 状态：实施基线草案；具体批次与验收标准见
> [implementation-roadmap.md](./implementation-roadmap.md)。
> 来源：[core-roadmap-codex.md](./core-roadmap-codex.md)（Codex 草案，2026-07-24）
> 与 Fable 架构评审建议（2026-07-24，原始评审未随仓库保存）。
> 融合方式：按草案第九节的方法执行——共识直接采纳，分歧注明理由，
> 双方盲区互相补齐。条目标注【共识】【草案】【补充】以保留融合痕迹。

## 一、融合说明

两份独立建议在以下判断上完全一致，可以视为高置信度结论：

- 项目已过"验证可行"阶段，下一阶段的主题是可靠性、可评测、可扩展，
  而不是功能数量；
- 定位收敛为 Agent Runtime（引擎），TUI 与 Cloud 是参考宿主；
- Core 公共 API 必须收敛后才能发布 SDK；
- MCP 补全优于继续增加内置工具；
- 需要 Eval 体系和清晰、可审计的执行边界；
- 不在本仓库做 SaaS，不为目录整齐拆包，不做无第二实现的提前抽象。

主要分歧与裁决：

| 分歧点 | 草案立场 | 评审立场 | 融合裁决 |
|---|---|---|---|
| Eval 优先级 | P0，先于扩展平台 | 第三优先 | v0.1 建立最小质量基线，v0.2 扩展骨架，v0.3 体系化跑分 |
| Sandbox 优先级 | P2 | 第二梯队偏高 | 维护者后续决定不纳入产品计划：本地依赖审批，Cloud 使用 Worker 容器边界 |
| headless / hooks | 未提及 | T1 | 纳入 v0.2。headless 是与竞品相比最明显的能力缺口，实现成本低（runStreaming 本就是纯事件流） |
| 发布节奏 | v0.1 先行、不加功能 | 未考虑发布 | 采纳草案：v0.1 只做"可被陌生人稳定安装"，并补入 License 决策 |

## 二、定位与差异化

【共识】长期定位：

> 一个本地优先、可自托管、可审计、可恢复的 Coding Agent Runtime，
> 同时提供成熟的 TUI 和 Cloud 参考实现。

【补充】以下三项是需要通过用户反馈、兼容性测试和竞品研究继续验证的
差异化假设，路线图应有意识地加固但不能直接当作市场事实：

1. **完整的自托管远程栈**：protocol/server/worker/web 全套，
   “手机 PWA 遥控自己 VPS 上的 Agent”是值得重点验证的使用场景；
2. **引擎级双语**：提示词目录 `zh-CN`/`en-US` 做在 core 里，配合
   DeepSeek 及 OpenAI/Anthropic 兼容端点，具备服务中文模型生态的潜力；
   Qwen、GLM、Kimi 等具体兼容性必须由 Provider Eval 证明；
3. **验证优先的 harness**：post-mutation verification、conductor 按最终
   diff 验收 worker、事务化变更与 undo，是执行质量的口碑基础。

差异化不是界面更多或工具更多，而是执行质量、用户控制、失败恢复与
扩展边界【草案】，加上以上三个生态位【补充】。

## 三、里程碑

阶段名称不构成日期承诺，顺序可按社区反馈调整【草案】。

### v0.1 正式开源发布（P0）

目标：陌生用户能稳定安装、使用、反馈。不加新功能【草案】。

- 发布 npm CLI 与版本化 Docker 镜像，创建 GitHub Release；
- 安装、升级、卸载与故障恢复文档；明确支持的 Node、Docker、OS 版本；
- TUI 与 Cloud 的最小 Smoke Test 进 CI；
- Issue、PR 与安全反馈闭环（SECURITY.md 已有，补响应时效承诺）；
- 【补充】License 决策：当前公开代码已经按 MIT 提供，既有授权不可追回；
  如要调整后续版本或分层授权，必须先确认贡献者授权与发布边界。v0.1 前由
  维护者明确保持 MIT 还是采用新的未来策略，路线图不预设 AGPL 为更优答案；
- 【补充】持久化目录写入格式版本标记（为 v0.2 的迁移机制预留锚点，
  成本极低，宜早不宜迟）。
- 【融合】建立 3–5 个不依赖真实模型的最小 Eval/Smoke Case，先保护运行、
  修改、验证和恢复契约；真实模型矩阵后续扩展。

### v0.2a 自动化入口与质量骨架（P0–P1）

- 【补充】headless 非交互模式：`kross exec "任务" --json`，流式 JSON
  输出、退出码语义、stdin 管道。解锁 CI、GitHub Action、pre-commit
  自动修复、批量脚本场景；
- 【共识】完成 Core API inventory、导出面测试与最小嵌入示例；先收敛边界，
  不在接口未经验证前承诺稳定发包；
- 【草案】Eval 骨架扩展到 10–20 个 Fixture Case，为 API、Prompt 和
  headless 改动提供回归保护；
- 【补充】导出语言无关的 Protocol schema，供未来非 TypeScript 控制面消费。

### v0.2b 扩展平台（P1）

- 【共识】在 v0.2a 的 API inventory 通过后，再评估发布
  `@kross/core`、`@kross/protocol`；
- 【共识】MCP 补全：HTTP/streamable transport、resources、prompts、
  配置热刷新、capability 检查、断线重连（详见第四节第 4 条）；
- 【草案】Tool、Provider、Store 扩展示例各一份；配置与持久化迁移机制；
- 【补充】hooks 先作为 experimental 事件通知能力验证：默认只读、有超时、
  输出受限、不能修改工具输入或结果。需要执行外部命令时必须经过现有审批与
  执行边界，不能形成第二条副作用通道。

### v0.3 质量与评测（P0 的兑现）

- 【草案】Harness Eval 体系化：10–20 个可稳定复现的小型任务起步
  （设计要点见第四节第 1 条）；
- 【草案】Provider 兼容性矩阵、成功率/成本/耗时报告、Trace replay、
  Prompt 与 Runtime 版本对比；
- 【补充】公开模型榜单："哪个模型在 Kross 上表现最好"，重点覆盖
  国产模型。既是回归基础设施，也是踩在双语定位上的社区磁铁。

### v0.4 可移植与生态（P2）

- 【草案】远程执行接口、更完整的恢复与备份、为独立 SaaS 控制面
  提供稳定协议；
- 【补充】Kross-as-MCP-server：把 Kross 暴露为 MCP server，让
  Claude Code / Cursor 等客户端可以调用 Kross，低成本接入大生态入口。

## 四、能力方向详述

### 1. Harness Eval【共识，草案方案为主】

临时 Git 仓库驱动的评测集，每个 case 定义：初始仓库状态、用户请求、
允许工具与最大轮数、必须/禁止修改的文件、验收命令、确定性评分规则、
模型/Prompt/Runtime 版本、Token/费用/耗时/工具轮数。

防过拟合原则【补充，回应草案十问之四】：

- 任务从真实仓库与 issue 派生并定期轮换，不手工雕琢"演示题"；
- 验收用行为断言（测试通过、diff 范围、验收命令退出码），
  不用输出文本匹配；
- 多模型矩阵跑分，防止 harness 向单一模型调优；
- 保留一个不进 CI 的 held-out 子集，仅在发布前人工触发；
- 报告区分"harness 改进带来的提升"与"模型升级带来的提升"。

第一阶段不追求大型公开 Benchmark；CI 只用 Mock 验证 Eval 框架本身，
真实模型评测按需或定期执行【草案】。

### 2. Core 公共 API 收敛【共识，草案方案】

三层结构：

- **Public API**：`createAgentHost`、`AgentRuntime`（run/resume/
  approve/abort/settings）、`ToolDefinition`、`LlmClient`、
  `RuntimeEvent`、`RuntimeResult`；
- **Extension Contracts**：`SessionStore`、`TraceStore`、
  `ApprovalPolicy`、`ContextSource`、`SubagentRunner`；
- **Internal**：mode flows、toolLoop 内部、checkpoint 实现、
  提示词目录结构、SessionServices。

发布前完成：API inventory、公共类型命名与文档、最小嵌入示例、
SemVer 与弃用策略、API surface 测试、防意外导出的检查。实验性能力
经 `@kross/core/experimental` 显式标记后暴露【草案】。

### 3. 扩展体系分工【融合，回应草案十问之六】

用户引导顺序：配置层优先，源码层兜底。

| 方式 | 适合 | 不适合 |
|---|---|---|
| Skills | 知识、流程、项目约定 | 需要副作用或新权限的能力 |
| MCP | 外部系统集成、第三方工具（进程隔离、生态复用） | 性能敏感或需 runtime 深度语义（mutation journal、审批细节）的工具 |
| hooks【补充】 | 生命周期通知、审计和外部观察 | 替代工具实现或绕过审批执行副作用 |
| 原生 Tool SDK | 需要深度集成审批/undo/trace 语义或性能敏感的核心工具 | 普通第三方集成（应走 MCP） |

MCP 与原生工具必须经过 Tool Gateway 的 schema、风险、审批、Trace、取消与
重试。hooks 只观察已经产生的生命周期事件；如需执行副作用，必须显式转入受控
工具/进程路径，不允许形成第二条绕过安全边界的执行通道【融合】。

### 4. MCP 补全【共识】

补齐：HTTP transport、resources、prompts、运行时刷新连接、capability
检查、OAuth/外部凭证引用、连接超时与断线重连、更细粒度风险覆盖【草案】。
反向输出（Kross-as-MCP-server）列入 v0.4【补充】。

普通第三方工具不再内置进 core，交给 MCP 生态【草案】。

### 5. Provider 能力与成本统一【草案】

工具调用能力检测、thinking 统一表示、prompt caching、structured
output、多模态输入、Token 与费用统计、限流重试信息、上下文窗口可信
来源、兼容性矩阵。模型差异封装在 Provider Adapter 内，Runtime 主流程
不再累积模型专用分支——这是 core 最可能失控的腐蚀点，需要 review 纪律
持续看守【融合，回应草案十问之二】。

### 6. 持久化兼容与恢复诊断【草案】

存储格式版本与迁移、checkpoint 完整性检查、会话导入导出、崩溃诊断
报告、长任务阶段性保存、Trace replay 调试工具、备份恢复验证。
恢复设计坚持 fail-closed 与"不重复副作用"第一原则，不追求任意执行点
无缝续跑【草案】。

### 8. 项目知识检索，谨慎自动记忆【共识】

先做可解释检索：文件与符号索引、架构/决策文档索引、Git 历史检索、
来源引用、用户可控的写入/查看/删除、`/memory` 检查入口【草案】。
跨会话记忆的形态是"用户与 agent 显式写入的项目备忘文件"
（如 `.agents/memory.md`），不默认将对话写入向量库——错误、过期、
不可解释的记忆比没有记忆更危险【融合，回应草案十问之八】。

## 五、Core 结构与工程治理【共识】

- 现阶段不拆独立 npm package；在 `packages/core` 内强化模块边界
  （contracts / host / runtime / context / tools / session / providers /
  observability / adapters）【草案】；
- 拆包需同时满足：独立使用者、可独立发布、接口清晰稳定、不依赖 core
  内部状态、拆分真正减少依赖【草案】；
- 抽象必须由真实的第二种实现推动，不为"以后可能需要"预制接口【草案】；
- 长期候选 Adapter 包括 Session、Trace、Mutation、Checkpoint、Secrets、
  Context Retrieval；进入公共 API 前必须有真实调用方或第二实现；
- "差异化逻辑下沉 core、宿主保持薄"作为 review 纪律明文化【补充】；
- SaaS 边界：未来 SaaS 控制面只消费语言无关的 Protocol 契约；SaaS Worker
  继续消费 Core + Protocol。控制面不依赖 Agent Runtime【融合】。

## 六、非目标【草案清单 + 补充】

- 再维护一个独立 GUI 客户端；
- 把大量第三方能力继续做成内置工具；
- 过早构建任意规模的多 Agent swarm；
- 默认记录所有跨会话内容；
- 在当前开源仓库加入用户、计费和多租户 SaaS 逻辑；
- 因为未来可能做 SaaS 而提前重写语言；
- 为了目录整齐把 Core 拆成大量 package；
- 在没有第二种实现前抽象所有内部服务；
- 【补充】不做通用 workflow 编排引擎（保持 coding agent 焦点）；
- 【补充】不追逐多模态生成能力（读图可以有，生成不做）。

## 七、优先级总表

| 优先级 | 方向 | 里程碑 | 来源 |
|---|---|---|---|
| P0 | v0.1 可安装发布 + License 决策 | v0.1 | 草案 + 补充 |
| P0 | 最小 Eval 基线 / 体系化 Eval | v0.1 / v0.2–v0.3 | 共识 |
| P1 | Core API inventory、收敛与发包评估 | v0.2a–v0.2b | 共识 |
| P1 | headless exec | v0.2a | 补充 |
| P1 | MCP 补全 / experimental hooks | v0.2b | 共识 + 补充 |
| P1 | Provider 兼容性与成本统计 | v0.3 | 草案 |
| P2 | 持久化迁移与 Trace replay | v0.3 | 草案 |
| P2 | 可解释项目知识检索 | v0.3+ | 共识 |
| P2 | 模型榜单、Kross-as-MCP-server | v0.3–v0.4 | 补充 |

## 八、待维护者决策的事项

1. License：core/protocol 与 server/worker 是否差异化授权（v0.1 前）；
2. Eval 的真实模型跑分预算与触发频率；
3. 模型榜单是否公开发布（涉及与 Provider 关系的权衡）；
4. `@kross/core` 是否单独发布，以及首个公开版本号策略；
5. hooks 是否有足够真实需求进入稳定扩展面。

## 附录：对草案第八节十个问题的回答

1. **最有差异化的三项能力**：自托管远程栈（协议到 PWA 全套）；
   引擎级双语与国产模型兼容；验证优先 harness（verification、
   conductor diff 验收、事务化 undo）。
2. **最可能失控的模块**：runtime 主流程（toolLoop）里累积的模型专用
   分支与重试策略；providers 差异渗入主流程；`core/src/index.ts`
   的无节制导出面。
3. **v0.1 前必须完成**：License 决策、npm/Docker 发布管道、安装升级
   文档与支持矩阵、安全反馈渠道时效承诺、TUI+Cloud smoke test、
   持久化格式版本标记。
4. **Eval 防过拟合**：见第四节第 1 条五原则。
5. **稳定 API 与内部实现的划分**：见第四节第 2 条三层结构。
6. **MCP / Skills / 原生 SDK 分工**：见第四节第 3 条，补充 hooks 为
   第四种配置层扩展。
7. **Sandbox**：维护者已决定暂不规划；本地依赖审批，Cloud 使用每工作区
   Worker 容器作为执行边界。
8. **跨会话记忆**：值得做，但形态是可解释检索加显式备忘文件，
   不做自动向量记忆。
9. **非目标**：采纳草案清单，另加"不做通用 workflow 引擎、
   不做多模态生成"。
10. **只选三项**：v0.1 发布（建立反馈回路）、Eval 骨架（建立质量
    标尺）、API 收敛 + headless（打开生态与 CI 场景）。三者互相独立、
    都为后续阶段铺路。
