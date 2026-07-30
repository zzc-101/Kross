# Changelog

本项目的重要变更记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- TUI 原生多模型档案：`models.profiles` 是唯一模型配置源，快捷向导可持续新增
  OpenAI/Anthropic 兼容模型，导入与公益模型也保存为档案，设置面板可在档案间
  即时切换；开发期旧顶层 `llm` 单模型结构已直接移除。
- Task 与 Conductor worker 支持通过 `modelProfileId` 指定已配置模型档案；可选档案
  动态注入 Agent 上下文，运行轨迹、工具结果和 TUI 子代理状态条显示实际模型。
- 三档工具权限语义：工作区读取自动允许且其他操作人工审批、可信工作区自动审批
  与完全访问；权限模式进入 Session Work State，可审计恢复，完全访问支持任意
  系统路径并保留 mutation journal。
- 统一结构化 `Git` 工具，覆盖 status、diff、log、show、branch、add、restore、
  commit、checkout、stash、fetch、pull 与 push，并按操作动态标记风险。
- 可发布的 `@zzc-101/kross` npm 包和 `kross` CLI。
- CLI 的 `--help`、`--version` 参数与安装后冒烟测试。
- Linux、macOS、Windows 和 Node.js 22/24 的持续集成验证。
- 基于 Ink 的交互式终端界面与多模型 Agent Runtime。
- auto、plan、conductor 三种工作模式及子代理任务编排。
- 文件、搜索、Git、Shell、后台进程与 stdio MCP 工具。
- workspace 边界、权限审批、trace、mutation journal 与冲突安全 `/undo`。
- 持久化会话、上下文治理、Project Instructions 与 Skills。
- 根包、workspace、lockfile、运行时兜底值和发布标签的版本一致性检查。
- Trace、Mutation、Cloud 幂等索引、事件序号、会话设置与 Push 订阅的数据版本锚点；
  兼容旧格式，并拒绝未知未来版本。
- 安装产物的无模型 TUI 启动 smoke，以及 Web、Gateway、Worker 镜像运行时 smoke。
- 不带发布权限的 Release Candidate Workflow：校验 tag/changelog，生成 npm
  tarball、校验和、构建元数据，并构建同版本与 commit 标签的三个 Cloud 镜像。
- 独立的确定性 Harness Eval workspace：使用 Fixture LLM、隔离临时工作区、真实
  Runtime/Trace、版本化 Case 与报告 schema，在普通 CI 中无网络运行。
- 最小 Eval Case 集覆盖 TypeScript 修复、失败验证、Stall Guard、审批
  Checkpoint 恢复和 Conductor 最终 diff 验收。
- Headless `exec` 的参数、版本化 NDJSON 事件、权限模式与稳定退出码契约。
- 可运行的 Headless Runtime Host：支持流式 NDJSON、持久化会话恢复、审批阻塞、
  验证失败退出码、SIGINT/SIGTERM 取消和统一资源清理。
- Headless Event v1 JSON Schema、Shell/Actions 示例、退出码表及权限和密钥文档。
- Core 顶层 API 收敛为显式 public / experimental barrel，并使用 TypeScript
  Checker 快照阻止未分类导出和内部编排模块泄漏。
- 最小 `createAgentHost` 生命周期：TUI、Headless 和 Worker 复用同一组合入口，
  支持替换 Runtime、会话级资源隔离和幂等关闭。
- Cloud Protocol v1 的 Client Command、Server Event 与 Event Envelope
  Draft-07 JSON Schema、兼容性守卫和 Python 消费示例。
- 明确 v0.1 只发布 CLI；Core/Protocol 保持 private，并记录未来独立 SDK 的触发
  条件、兼容承诺和发布门。
- MCP 协议客户端与 stdio Transport 解耦，统一请求取消、单请求超时、结构化诊断
  和幂等资源关闭，同时保持现有工具注册与权限语义。
- MCP 2025-11-25 Streamable HTTP：支持 JSON/SSE 响应、会话重建、cursor
  恢复、显式取消、远程默认风险和不落盘的 Bearer 环境变量引用。
- MCP Resources 与 Prompts：按 capability 建立目录，Resource 仅在显式选择后
  作为带来源的不可信文本 Context Source 注入，Prompt 仅预览；TUI 与 Cloud
  共享 `/mcp` 命令，并限制远端响应大小。
- MCP `/mcp reload` 原子热重载：先准备完整的新连接与工具 generation，失败时
  保留旧配置，成功后让旧连接等待在途调用排空再关闭。
- Experimental Lifecycle Hooks：Host 可接收冻结、脱敏、版本化的运行与工具
  生命周期通知；Hook 异常不影响 Agent，并受超时、pending 上限与事件限流保护。
- Trace Replay v1：严格校验 run、事件 ID、时间、已知类型、起止和工具生命周期，
  通过 `/trace replay <runId>` 生成纯派生状态；Fixture Eval 自动验证回放契约。
- Core 本地迁移 F2a：`kross migrate` 默认 dry-run，显式 apply 使用独占锁、
  SHA-256 备份 manifest、原子替换和失败回滚；首批为旧配置与项目模板补 v1。
- Cloud 控制面迁移 F2b：停止 Gateway 后可独立 dry-run/apply
  `kross-server-data`，对旧工作区、Provider 和 Push 数据执行备份、原子升级与
  失败回滚，不跨入 Worker 工作区卷。
- Provider Capability v1：由 Provider Adapter/模型目录声明工具调用、思考、
  structured output、prompt caching 和多模态读取能力；Runtime 与 Cloud 只消费
  声明，不再需要新增模型名称判断。
- Provider 调用指标与 Eval 兼容矩阵：记录不含内容的 token、估算费用、延迟、
  限流和稳定错误类别；按实测 case 聚合 Provider/模型能力，不为缺失价格或未经
  测试的模型编造结论。
- 真实 Provider Harness Eval：显式选择 Case、Provider、模型、重复次数和总预算，
  在一次性工作区运行真实 AgentRuntime；结果按文件、验证、Trace、token、费用和
  延迟评分，并以受限 `Verify` 代替任意 Shell 执行。
- TUI 与 Web 的 Provider 能力和最近调用概览：显示工具、思考、缓存、结构化输出、
  多模态能力以及 token、延迟、缓存、估算费用；Web Trace 结构化展示运行摘要、
  稳定错误类别并提供无副作用状态回放入口。
- Gateway 轻量管理面板：显示全局模型配置来源和当前 Worker 状态，支持不中断容器
  的模型 Client 热更新；Web 模型选择器区分 Gateway 与工作区私有模型，私有密钥
  仅以 `0600` 保存于 Worker 卷。

### Fixed

- 新建工作区处于 `creating` 阶段时 Web 不再提前请求会话和模型，避免错误提示
  “工作区不存在”，并在工作区进入 `ready` 后自动加载。

[Unreleased]: https://github.com/zzc-101/Kross/commits/main
