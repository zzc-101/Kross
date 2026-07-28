# Kross 实施进度快照（2026-07-27）

> 状态：F 阶段完成，暂停在 G 阶段之前
>
> 对应路线：[Kross 分批实施路线](./implementation-roadmap.md)
>
> F 阶段实现点：`main` / `e227674 feat(eval): report provider cost and compatibility`

本文记录本轮分批实施已经落地的能力、验证基线和下一恢复点。它是一次阶段性
快照，不替代面向用户的现行指南；功能用法仍以 [`docs/`](../README.md) 中的对应
文档为准。

## 1. 当前结论

路线的 A–F 阶段已经完成。F 阶段包含 Trace Replay（F1）、Core 与 Cloud 两条
独立迁移链（F2a/F2b）、Provider Capability（F3）以及成本与兼容性报告（F4）。
当前按维护者要求结束本轮开发，暂停在项目知识与记忆（G）开始之前。

截至本快照：

- F 阶段实现提交完成后，本地 `main` 比 `origin/main` 多 26 个提交，尚未推送；
- 工作区在编写本快照前是干净的；
- v0.1 的发布基线、确定性 Eval、Headless CLI、Core/Protocol 边界和 MCP 扩展
  已形成完整闭环；
- 独立 Sandbox 当前不在产品计划内；本地使用审批，Cloud 使用 Worker 容器边界；
- 真正的 npm/GHCR 发布、真实模型 Eval 预算仍受维护者决策和发布权限约束。

## 2. 已完成批次

| 阶段 | 已完成内容 | 主要提交 |
|---|---|---|
| 路线基线 | 将融合路线拆为可独立实现、验证和回滚的批次 | `3779b08` |
| A. 发布基线 | 固化 v0.1 版本契约、持久化格式版本、TUI/Cloud 发布 Smoke Test 和只构建不发布的 Release Candidate 工作流 | `9e41ca9`–`dcf80fe` |
| B. 确定性 Eval | 建立无网络、无密钥、fixture 驱动的 Harness Eval，并覆盖完成、失败、停滞、审批恢复和 Conductor 验收 | `59f7fee`、`b97ad6e` |
| C. Headless | 定义版本化 NDJSON 与退出码，完成 `kross exec`、持久会话、审批边界、验证、信号取消和文档 | `f912fb5`–`5411c5e` |
| D. Core / Protocol | 收敛 public/experimental/internal API，加入快照守卫和最小 Host 生命周期；生成语言无关 JSON Schema；明确 v0.1 SDK 发布边界 | `a5f851d`–`4b045da` |
| E. MCP | 抽象 Transport；支持 Streamable HTTP、Resources、Prompts、原子配置重载和受限生命周期 Hooks | `de39a41`–`b3dfb39` |
| F1. Trace Replay | 加入严格、无副作用的 Trace 回放和稳定错误码，并接入 TUI、Cloud 与全部 Eval fixture | `c865068` |
| F2a. Core 迁移 | 加入默认 dry-run 的 `kross migrate`，支持锁、并发变更检测、哈希清单、备份、原子写入和回滚 | `b70ac09` |
| F2b. Cloud 迁移 | 为 Gateway 数据卷提供独立 dry-run/apply、锁、哈希备份、原子写入和回滚入口，不跨入 Worker 卷 | `7fe3103` |
| F3. Provider Capability | 由 Adapter/模型目录统一声明工具、思考、结构化输出、缓存和多模态能力，并通过 Protocol 交给 Cloud UI | `1453a8c` |
| F4. 成本与兼容性 | 记录无内容的 token、费用、延迟、限流和错误类别，并把 Eval 证据聚合为 Provider/模型矩阵 | `e227674` |

## 3. 当前能力摘要

### 发布与质量

- package、TUI、Cloud runtime/image 均有发布 Smoke Test。
- Release Candidate 工作流可以构建 tarball、校验和、构建元数据和版本化镜像，
  但不会绕过权限直接发布。
- 持久化数据有明确的格式版本锚点。

### Eval 与自动化

- 确定性 Eval 当前包含 6 个 fixture，覆盖读取、TypeScript 修复、验证失败、
  stall guard、审批 checkpoint 恢复和 Conductor 最终 diff review。
- 所有 fixture 都执行严格 Trace Replay 断言。
- `--matrix` 可按 Provider/模型聚合 capability 通过率、token、费用覆盖、延迟、
  限流和错误类别；Fixture 矩阵不冒充真实厂商兼容结论。
- `kross exec` 提供版本化 NDJSON 事件契约和稳定退出码，可用于 Shell、CI 和
  后续 SaaS 调度。

### Core 与 Protocol

- `createAgentHost` 作为最小运行时生命周期入口，被 TUI、Headless 和 Worker
  复用，关闭操作幂等。
- 公共 API 已按 public、experimental、internal 分类，并由快照检查防止无意扩张。
- Client Command、Server Event 和 Event Envelope 已生成 Draft-07 JSON Schema，
  带兼容检查和 Python 消费示例。
- v0.1 只发布 CLI；Core 和 Protocol package 暂时保持 private。非 TypeScript
  Cloud/SaaS 消费者应依赖语言无关协议，而不是直接耦合 TypeScript 内部实现。

### MCP

- Transport 生命周期统一了取消、请求超时、诊断和幂等关闭。
- Streamable HTTP 支持 JSON/SSE、session、`Last-Event-ID` 恢复、404 重建、
  DELETE 关闭和 Bearer Token 环境变量引用。
- 非 localhost 远程 MCP 默认要求 HTTPS，并保留远程网络风险边界。
- Resource 只作为不可信 Context Source 注入，限制为文本和 128 KiB。
- Prompt 只提供显式预览，限制为 64 KiB，不能覆盖 system 指令。
- `/mcp reload` 先准备完整新 generation，再原子切换工具；失败保留旧配置，
  旧连接会等待在途调用排空后关闭。
- experimental lifecycle hooks 使用冻结、脱敏、版本化的事件，并受到超时、
  并发上限和速率限制约束；Hook 失败不会中断 Agent 主流程。

### Trace 与持久化

- Trace Replay v1 校验同一 run、唯一 ID、单调时间、已知事件、开始/终止状态和
  工具生命周期，且不执行工具、模型、网络或持久化副作用。
- TUI 和 Cloud 均支持 `/trace replay <runId>`。
- `kross migrate` 默认只展示计划；`--apply` 才会写入。
- 当前第一条真实迁移只处理未版本化的 `config.json` 和 `projects.json` 到 v1。
- Core 本地数据迁移与 Cloud 控制面迁移明确分离，Core 命令不会跨边界修改
  Gateway/Server 数据。
- 停止 Gateway 后可用 `./scripts/start-cloud.sh --migrate` 查看 Cloud 计划，
  `--migrate-apply` 只迁移 Gateway 卷内三类控制面 JSON。

### Provider 能力与观测

- Capability v1 由 Provider Adapter 和 pi-ai 模型目录生成，Runtime 不检查模型名。
- 未知/私有模型使用保守 Adapter 默认值；未接通的 structured output 和多模态
  不会因为上游模型宣称支持就暴露给用户。
- LLM 调用指标不保存 prompt、正文、密钥或错误 body，只保留模型、状态、耗时、
  usage、费用、限流和稳定错误类别。
- 费用只能来自 Provider usage 或当前模型目录；无法确定时字段缺失并报告覆盖率，
  不按模型名称硬编码价格。

## 4. 最近一次完整验证基线

F4 完成后运行了完整 `npm run check`，结果为：

- 178 个测试文件、942 项测试通过；
- API 守卫通过：142 个 public、53 个 experimental 导出；
- Protocol Schema 检查通过：v1、3 个发布物；
- 28 个 Markdown 文档的本地链接检查通过；
- CLI、Web 构建和 package smoke 通过，安装产物中的 TUI、Headless、Migrate
  三个入口可用。

完整 fixture Eval 与 Provider Matrix 通过全部 6 个案例。Server、Server
Migration 和 Worker 的生产 bundle 均构建通过，启动脚本语法检查通过。本机
Docker Engine 在收尾时不可用，因此没有重复执行三镜像容器 Smoke；既有 Cloud
Smoke 脚本仍保留在完整运行环境中执行。后续如果依赖、测试数量或协议产物发生
变化，应以新的完整检查结果更新基线，不应把这些数字当作永久指标。

## 5. 已确认的边界与暂缓项

- v0.1 不发布独立 Core SDK；先通过 CLI 和语言无关 Protocol 稳定真实需求。
- Resources 和 Prompts 必须由用户显式触发，且始终视为不可信外部输入。
- 本地 Core 数据和 Cloud 控制面数据采用独立迁移链。
- 独立 Sandbox 不纳入当前路线。
- 不自动推送、不创建 tag、不向 npm 或 GHCR 发布，除非维护者明确授权。
- CI 默认不使用真实模型密钥；真实模型 Eval 需要先确认 Provider、模型和预算。

## 6. 尚未完成

F 阶段没有剩余实现项。建议恢复时继续遵循原路线顺序：

1. **G：受控项目知识与记忆**
   - 先定义来源、作用域、更新、冲突、撤销和隐私边界，再实现最小闭环。
2. **发布决策项**
   - 确认 License 延续策略、npm/GHCR 权限和真实模型 Eval 预算；
   - 条件满足后再执行正式 tag、npm、GitHub Release 和镜像发布。

## 7. 恢复开发检查表

恢复时建议先执行：

```bash
git status --short
git log --oneline origin/main..HEAD
npm run docs:check
```

确认没有新增的未提交改动后，从 G 的知识来源、作用域和删除语义开始设计，不要
直接引入默认收集全部对话的向量库。提交前运行：

```bash
npm run check
```

如果恢复前先决定推送当前成果，应单独检查本地提交及远端分支状态，明确
要求后再推送，不能把推送夹带在后续功能批次中。
