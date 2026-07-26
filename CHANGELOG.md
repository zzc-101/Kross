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

[Unreleased]: https://github.com/zzc-101/Kross/commits/main
