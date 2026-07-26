# Kross 分批实施路线

> 状态：实施基线草案
> 日期：2026-07-26
> 上位路线：[Kross 后续路线图（融合稿）](./core-roadmap.md)
> 原始输入：[Codex 草案](./core-roadmap-codex.md)

## 1. 目标与执行方式

本路线把融合稿拆成可以独立实现、验证、提交和回滚的小批次。排序遵循：

1. 先建立可发布基线和质量标尺；
2. 再开放自动化入口；
3. 然后收敛公共 API；
4. 最后扩展 MCP、持久化和 Provider；
5. Sandbox 后置，不阻塞近期发布。

每个批次必须满足：

- 只解决一个主问题；
- 开始前确认工作区没有不属于本批次的未提交改动；
- 新行为先定义契约，再实现和测试；
- 用户可见行为同步中英文 README 或对应指南；
- 至少运行针对性测试、`npm run typecheck` 和 `npm run docs:check`；
- 涉及公共入口、协议、持久化或发布时运行完整 `npm run check`；
- 验收通过后创建一个语义明确的提交；
- 不自动推送远端，除非维护者明确要求；
- 发现目标需要扩大时停止当前批次，先更新路线而不是夹带实现。

## 2. 当前基线

截至本路线建立时，已经具备：

- TUI、Cloud Web、Gateway、Worker 和 Protocol 的完整闭环；
- 859 项确定性测试；
- CLI bundle 与临时安装 Smoke Test；
- Web、Gateway、Worker 镜像构建；
- 双语 README、Issue/PR 模板与文档链接检查；
- `auto`、`plan`、`conductor`、工具审批、会话恢复、Context、Skills、
  stdio MCP、Todo、Trace、Diff 和 mutation-aware verification；
- Cloud SSE/HTTP 公网链路与内部 Worker WebSocket；
- 自托管 Docker 工作区隔离、资源限制和持久化。

尚未形成：

- 正式 npm/GitHub Release 与版本化容器发布；
- 可重复的 Agent Eval；
- headless `kross exec`；
- 收敛后的 Core 公共 API；
- 语言无关的 Protocol 发布物；
- MCP HTTP/resources/prompts；
- 系统化持久化迁移和 Trace replay；
- Provider 能力/成本矩阵。

## 3. 决策门

以下事项需要维护者决策，不能由实现者默认为某个答案。

### D1. License

- 当前已经公开的代码按 MIT 提供，既有授权不可追回。
- v0.1 前确认后续是否继续全仓 MIT。
- 如果考虑分层授权，必须先确认贡献者授权、package 边界和发布影响。
- 在决策前不得修改 `LICENSE` 或在 package 中加入不同许可证声明。

### D2. 发布权限

- 确认 npm scope `@zzc-101` 的发布权限。
- 确认 GitHub Container Registry 的目标组织、可见性和保留策略。
- Workflow 可以先实现 dry-run/build，真正 publish 必须由 tag 和受保护环境触发。

### D3. 真实模型 Eval 预算

- 确认允许测试的 Provider、模型和单次预算。
- CI 默认不使用真实密钥和付费模型。
- 真实跑分只允许手动或受保护的定期任务。

### D4. Core SDK 是否独立发布

- API inventory 完成后再决定是否发布 `@kross/core`。
- `@kross/protocol` 可以比 Core 更早稳定，但仍需确认 package 名称与版本策略。
- 决策前只收敛导出面，不承诺外部 SemVer。

## 4. 阶段 A：v0.1 发布基线

### A0. 路线文档基线

**范围**

- 修订融合稿中的事实、优先级和依赖关系；
- Sandbox 后置；
- 新增本实施路线；
- 保留各模型原始草案作为决策输入。

**验收**

```bash
npm run docs:check
git diff --check
```

**建议提交**

```text
docs: define the phased implementation roadmap
```

### A1. 发布资产与版本一致性审计

**目标**

让版本、包名、二进制、镜像和文档拥有单一发布口径。

**工作**

- 审计根 package、TUI bundle、Cloud 镜像和 Protocol 的版本来源；
- 明确 `0.1.0` 的版本读取和 tag 规则；
- 增加支持矩阵：Node、npm、Docker Engine、Compose、浏览器和操作系统；
- 检查 `CHANGELOG.md`、发布指南、安装和卸载说明；
- 输出发布前检查清单，不执行真实发布；
- 记录 D1、D2 的待确认项。

**非目标**

- 不修改 License；
- 不推送 npm 或镜像；
- 不调整 Core API。

**验收**

```bash
npm run package:check
npm run docs:check
```

**建议提交**

```text
docs: define the v0.1 release contract
```

### A2. 持久化格式版本审计与最小迁移锚点

**目标**

确保 v0.1 写出的长期数据能够被后续版本识别，而不是立即设计完整迁移框架。

**工作**

- 盘点 session JSONL、work state、checkpoint、trace、mutation、项目注册表和
  Cloud journal 的已有版本字段；
- 为缺少版本标记且需要长期兼容的根格式补充版本；
- 读取旧数据时保持兼容；
- 遇到未知新版本时 fail-closed，并给出可诊断错误；
- 为每种变更补充旧格式读取和新格式拒绝测试；
- 文档列出可备份数据和兼容承诺。

**非目标**

- 不统一重写所有存储；
- 不把 JSONL 迁移到数据库；
- 不做跨会话语义记忆。

**验收**

```bash
npm test -- --run packages/core/src/session packages/core/src/runtime
npm test -- --run packages/server packages/worker
npm run typecheck
npm run docs:check
```

涉及实际格式变更时额外运行：

```bash
npm run check
```

**建议提交**

```text
feat(storage): version durable kross data formats
```

### A3. TUI 与 Cloud 最小 Smoke Test

**目标**

用低成本自动化验证“能安装、能启动、能连接”，不依赖真实模型。

**工作**

- 保留现有 CLI tarball 安装、`--help`、`--version` Smoke Test；
- 增加 TUI 无模型配置时的非交互启动契约测试；
- 验证 Compose 配置、Web/Gateway/Worker 镜像构建；
- 为 Gateway health、Web 静态入口和 Worker 内部 health 增加 CI Smoke；
- 使用 Fixture/Mock 验证创建工作区后的最小命令与事件链路；
- 测试失败时输出相关容器日志。

**非目标**

- 不在普通 PR CI 中调用真实 LLM；
- 不验证所有手机和浏览器；
- 不把 Smoke Test 发展成完整 Eval。

**验收**

```bash
npm run check
docker compose config --quiet
```

CI 中确认三个镜像构建和最小健康检查通过。

**建议提交**

```text
test: add release smoke coverage for tui and cloud
```

### A4. 版本化发布 Workflow

**目标**

让 tag 对应可复现的 npm tarball、容器镜像和 GitHub Release 资产。

**工作**

- PR/branch 只执行 build、pack 和镜像构建；
- `v*` tag 触发受保护发布任务；
- npm 使用 provenance/受保护环境（在平台支持时）；
- Web、Gateway、Worker 镜像写入相同版本标签和 commit SHA；
- 生成 checksums、变更摘要和构建元数据；
- 发布任务验证 tag、package version 与 changelog 一致；
- 默认保留手动批准，避免误发。

**非目标**

- 未通过 D1、D2 前不执行真实 publish；
- 不引入自动版本机器人。

**验收**

- 在 Fork、dry-run 或本地 action runner 中验证条件分支；
- `npm pack --dry-run` 内容符合预期；
- 镜像标签计算有单元测试或脚本测试；
- `npm run check` 通过。

**建议提交**

```text
ci: add guarded versioned release workflows
```

### A5. v0.1 Release Candidate

**工作**

- 冻结功能变更；
- 完整运行本地与 CI 验证；
- 更新 `CHANGELOG.md`；
- 使用全新目录验证安装；
- 使用全新 Docker 数据验证 Cloud 一键启动；
- 记录已知限制；
- 由维护者确认 D1、D2 后创建 tag 和 Release。

**停止条件**

- 安装步骤依赖未记录的本机状态；
- 持久化格式仍无版本或未知版本会被静默读取；
- package/image/tag 版本不一致；
- 安全报告渠道不可用。

**建议提交**

```text
chore: prepare the v0.1.0 release candidate
```

## 5. 阶段 B：最小 Harness Eval

阶段 B 可以在 A3 后与 A4 并行准备，但必须在 Core API 大改和 headless 完成前落地。

### B1. Eval 契约与 Fixture Runner

**建议位置**

```text
packages/eval/
├── src/
├── cases/
└── package.json
```

Eval 是独立开发工具，有独立运行者和生命周期，因此满足新建 workspace 的条件；
它不进入 CLI 发布包。

**Case 契约**

- id、description、fixture；
- user prompt；
- allowed tools；
- max iterations、timeout；
- must-change / must-not-change；
- verification commands；
- deterministic assertions；
- tags 和所需能力。

**输出契约**

- schema version；
- Runtime/Prompt/Provider/model 版本；
- status 和 score；
- changed files；
- verification；
- tool iterations；
- duration、tokens、estimated cost；
- failure category。

**CI 模式**

- 使用 Fixture LLM；
- 不访问网络；
- 固定时钟和随机源；
- 输出稳定 JSON。

**验收**

```bash
npm run eval -- --fixture
npm run typecheck
npm test -- --run packages/eval
```

**建议提交**

```text
feat(eval): add the deterministic harness runner
```

### B2. 第一组最小 Case

至少包含：

1. 修复单文件 TypeScript 错误并验证；
2. 修改后测试失败，最终结果不得伪装成功；
3. 重复工具调用触发 Stall Guard；
4. 待审批 Checkpoint 恢复但不重放已完成写入；
5. Conductor 最终 diff 验收。

**验收**

- Case 可以单独运行；
- 初始仓库每次从干净 Fixture 创建；
- 失败时保留仓库和报告路径；
- 结果不依赖自然语言文本精确匹配。

**建议提交**

```text
test(eval): cover core completion and recovery contracts
```

### B3. 真实模型手动通道

**工作**

- 显式 `--provider`、`--model`、`--budget`；
- 默认拒绝在普通 CI 中运行；
- 输出脱敏报告；
- 支持多次运行和方差；
- held-out Case 不进入日常 Prompt 调优。

**决策依赖**

- 必须先完成 D3。

**建议提交**

```text
feat(eval): add opt-in provider benchmark runs
```

## 6. 阶段 C：v0.2a Headless

### C1. 命令与 NDJSON 契约

**目标接口**

```bash
kross exec "检查并修复当前测试" --json
printf '%s' "任务" | kross exec --stdin --json
```

**必须先定义**

- stdout 只输出版本化 NDJSON；
- 日志和诊断写 stderr；
- 每条事件包含 `schemaVersion`、`type`、时间、run/session 标识和 data；
- 退出码区分参数/配置错误、审批阻塞、运行失败、验证失败和中断；
- 默认权限不因非交互模式自动升级；
- 遇到需要审批的调用时明确退出或根据显式策略处理；
- SIGINT/SIGTERM 触发取消和资源清理。

**非目标**

- 第一批不支持交互式审批；
- 第一批不支持远程 Cloud；
- 不把 TUI 渲染组件复用到 headless。

**建议提交**

```text
feat(cli): define the headless execution contract
```

### C2. Headless Runtime Host

**工作**

- 从 TUI `main.tsx` 抽离共享 Runtime bootstrap；
- CLI dispatcher 区分 TUI、help/version 与 exec；
- 消费 `runStreaming()` 并序列化事件；
- 保持 Session、Trace、Todo、mutation 和进程清理；
- 配置缺失时快速失败，不进入 TUI onboarding；
- 添加 Fixture LLM 端到端测试。

**验收**

```bash
npm test -- --run packages/tui
npm run typecheck
npm run package:check
```

**建议提交**

```text
feat(cli): run kross tasks without the tui
```

### C3. Headless 文档与自动化示例

- Shell 管道示例；
- GitHub Action 示例；
- JSON schema 和退出码表；
- 权限与密钥安全说明；
- 一个不使用真实模型的 Smoke Test。

**建议提交**

```text
docs: document headless automation
```

## 7. 阶段 D：Core 与 Protocol 边界

### D1. API Inventory 与导出面保护

- 分类当前 `packages/core/src/index.ts` 导出；
- 标记 public、experimental、internal；
- 为允许的导出生成稳定快照；
- 禁止内部模块意外进入顶层；
- 不在本批次搬迁大量目录。

**建议提交**

```text
refactor(core): define and guard the public api surface
```

### D2. Host API 收敛

> 已完成：新增最小 `createAgentHost`，TUI、Headless 与 Worker 已迁移；Host
> 统一拥有 Tooling 资源并提供幂等关闭，前台取消仍由各宿主负责。

- 用真实 TUI、Worker、headless 三个宿主验证最小组合接口；
- 评估是否新增真正的 `createAgentHost`，而不是把文件名误当成现有函数；
- 收敛 Runtime lifecycle、close、resume、approval 和 abort；
- 所有资源必须有统一释放契约。

**建议提交**

```text
refactor(core): expose a minimal host lifecycle
```

### D3. Protocol 语言无关产物

> 已完成：从 Zod 事实源生成版本化 Client Command、Server Event 与 Event
> Envelope JSON Schema；CI 检查漂移和同版本破坏性变化，并提供 Python 示例。

- 从 Zod schema 导出 JSON Schema 或等价稳定描述；
- 版本、命令、事件、错误和重放语义进入产物；
- TypeScript 类型继续从 schema 推导；
- 增加 schema breaking-change 检查；
- 提供最小非 TypeScript 消费示例或生成验证。

**建议提交**

```text
feat(protocol): publish language-neutral wire schemas
```

### D4. SDK 发布决策

> 已完成：v0.1 只发布 CLI，Core/Protocol 继续保持 private；跨语言消费者使用
> 固定版本 JSON Schema，并为未来 Protocol/Core 独立发布定义产品信号和发布门。

完成 D1–D3 后评估 D4：

- 若只有仓库内部调用方，继续保持 private；
- 若已有外部嵌入需求，发布 `0.x` 并明确兼容策略；
- SaaS Control Plane 只消费 Protocol；
- Worker/自定义 Agent Host 才消费 Core。

## 8. 阶段 E：v0.2b MCP 与扩展

### E1. MCP Transport 抽象

> 已完成：协议客户端与 stdio Transport 已解耦，取消、超时、诊断和幂等关闭已
> 统一，并由 E2 的真实 Streamable HTTP Transport 验证。

- 在保留 stdio 行为的前提下定义 transport lifecycle；
- 连接、请求、取消、超时、关闭和诊断统一；
- 用第二种真实 transport 验证抽象；
- 不先重写 MCP Tool Gateway 集成。

### E2. Streamable HTTP

> 已完成：按 MCP 2025-11-25 实现 JSON/SSE、session、cursor 恢复、404
> 重新初始化、显式取消和 DELETE 关闭；支持 Bearer token 环境变量引用并默认按
> `network` 风险。交互式 OAuth/PKCE 客户端不在本批次。

- 以实施时最新的 MCP 官方规范为唯一协议依据；
- 支持认证引用、重连、capability 协商和明确错误；
- 远程 MCP 默认按 `network` 风险；
- 密钥不进入 Trace 或 Session。

### E3. Resources 与 Prompts

- Resources 作为可追踪 Context Source，而不是伪装成工具输出；
- Prompts 作为显式用户选择的模板，不静默覆盖系统行为；
- 明确大小、刷新、来源和可信边界；
- TUI 与 Cloud 提供一致的最小检查入口。

### E4. 配置刷新与 Experimental Hooks

- MCP 配置安全刷新，不中断正在执行的调用；
- hooks 第一版只接收脱敏生命周期事件；
- 默认通知型、超时、限流，不能修改工具输入或结果；
- 需要副作用的行为走 Tool Gateway/Process，不直接执行。

建议按 E1–E4 分别提交，避免一个超大 MCP 改动。

## 9. 阶段 F：质量、持久化与 Provider

### F1. Trace Replay

- 重放的是事件和状态派生，不重新执行外部副作用；
- 用于 UI、诊断和 Eval；
- 对缺失、乱序和未知事件明确失败。

### F2. 完整迁移框架

- 在 A2 的版本锚点基础上引入逐版本迁移；
- 迁移前备份、失败回滚和 dry-run；
- Core 本地数据与 Cloud 控制面数据分别处理。

### F3. Provider Capability

- 工具调用、thinking、structured output、prompt caching、多模态读取；
- 能力检测留在 Provider Adapter；
- Runtime 不增加模型名称判断。

### F4. 成本与兼容性报告

- Token、费用、延迟、限流和错误类别；
- 结合 Eval 输出 Provider 矩阵；
- 具体国产模型兼容结论必须由测试数据支撑；
- 公开榜单是可选展示层，不是 Core 完成条件。

## 10. 阶段 G：项目知识

优先实现可解释、可删除的项目记忆：

1. 显式 `.agents/memory.md` 或等价受控文件；
2. `/memory` 查看来源、更新时间和内容；
3. 用户或 Agent 通过显式工具写入并经过审批；
4. 文档、符号和 Git 历史检索必须返回来源；
5. 默认不把全部对话写入向量库。

只有真实仓库证明全文/符号检索不足时，才评估 embedding。

## 11. 阶段 H：Sandbox（后置）

Sandbox 不进入 v0.1、v0.2 的关键路径。

未来启动条件：

- 有明确用户需求或安全事件；
- 完成文件、网络、进程、系统调用和资源威胁模型；
- 至少找到一种可维护的真实平台实现；
- 不把 Cloud Worker 容器误认为已经实现 Runtime Sandbox Adapter；
- 有第二种实现需求后再稳定公共接口。

在此之前只要求：

- Bash、Process 和验证执行不要进一步耦合具体宿主；
- 文档持续明确“审批不等于沙箱”；
- Cloud 保持容器、能力和资源限制。

## 12. 暂不排期

以下方向保留为实验或社区需求，不进入近期承诺：

- Kross-as-MCP-server；
- 公开模型排行榜；
- 独立 GUI 客户端；
- 通用 Workflow 编排器；
- 任意规模 Agent swarm；
- 多模态生成；
- 自动向量化全部历史对话；
- 当前开源仓库内的多租户 SaaS。

## 13. 提交与回滚规范

每批建议保持一个主提交；机械重命名可先独立提交，避免与行为修改混合。

提交信息建议：

```text
docs: ...
test: ...
feat(eval): ...
feat(cli): ...
refactor(core): ...
feat(protocol): ...
feat(mcp): ...
feat(storage): ...
```

提交前：

```bash
git status --short
git diff --check
npm run typecheck
npm run docs:check
```

行为或发布改动再运行：

```bash
npm run check
```

回滚必须以 `git revert` 为主，不修改已经公开的历史。涉及存储格式时，代码回滚前
必须确认新版本写出的数据是否仍能被旧版本安全读取。

## 14. 第一轮执行顺序

如果维护者没有重新排序，下一批按以下顺序启动：

1. A0 路线文档基线；
2. A1 发布资产与版本一致性审计；
3. A2 持久化格式审计；
4. A3 最小 Smoke Test；
5. B1 Eval 契约与 Fixture Runner；
6. B2 第一组 Eval Case；
7. C1 Headless 命令与 NDJSON 契约；
8. C2 Headless Runtime Host。

A4 真实发布 Workflow 受 D1、D2 决策影响，可以与 B1 并行准备，但在确认权限和
License 前不得触发实际发布。
