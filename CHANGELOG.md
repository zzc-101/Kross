# Changelog

本项目的重要变更记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/zzc-101/Kross/commits/main
