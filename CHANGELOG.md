# Changelog

本项目的重要变更记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- 产品定位统一为 SaaS Work Agent：普通用户只描述工作目标，不选择运行模式、模型或权限档位。
- Runtime 只保留一套 SaaS 工作策略；Task 与最终结果使用产物、证据和未完成项表达完成情况。
- 默认工具收敛为工作区文件、检索、Todo 和受限子任务；删除 Shell、Git、Patch、后台进程和代码验证工具。
- 平台版本化 Skill 成为唯一 Skill 来源；会话固定使用已安装版本，并向子任务继承相同内容。
- 普通用户工作台重构为对话、Skill、记忆、文件与产物，隐藏模型、Token、底层工具参数和连接配置。
- 工作区文件面板支持目录浏览、文本预览和产物大小显示。
- 本地工作区操作自动执行；只有受管外部工具需要用户确认。
- 浏览器协议删除普通用户模型选择、MCP 配置、Git 状态和仓库克隆入口。
- 成员工作区上传改为预签名写入对象存储，再同步到 Worker；下载与图片预览走同源 `file/content` 302（约 2 分钟短缓存），不再返回 JSON 预签名 URL。
- 工作区文件不再自动加载为编程项目系统规则；平台 Skill、用户记忆和明确的用户请求构成可信工作上下文。

### Removed

- 终端 UI、本地 CLI、斜杠命令和旧客户端门面。
- 自研 `kross-node`、节点 WebSocket 与 Compose 集群叠加文件。
- 多运行模式及其计划确认、编排和兼容状态。
- 三档权限模式与组织级审批策略配置。
- 项目注册表、多工作区根和仓库路由字段。
- 本地 Skill 发现、读取和增删改接口。
- Runtime inspection、Trace 回放、上下文手动压缩和 Git Diff 门面。
- `GET /api/v2/agent/workspace/file/url` 与 Worker `workspace.put` / `workspace.get`。

### Added

- 每成员长期 Docker Worker 与持久 `/work` 工作区。
- PostgreSQL 对话、SSE 直播、Worker WebSocket 和任务租约恢复。
- 平台模型档案、版本化 Skill 包、个人记忆、OIDC SSO。
- 单机 Docker volume 与集群 JuiceFS CSI 工作区。
- k3s Helm 安装：控制面用 Kubernetes API 调度 Worker Pod。

### Migration notes

- 普通用户客户端必须停止调用 `/api/v2/agent/model`、`/models`、`/mcp`、`/workspace/git*` 和 `/workspace/file/url`；下载与图片预览改用 `/workspace/file/content`。
- 不再读取工作区中的本地 Skill 或编程项目规则；需要稳定行为时由管理员发布版本化 Skill。
- 后端数据库迁移由 Flyway 自动执行；升级前仍应备份 PostgreSQL、对象存储和 `/work`。
- `KROSS_WORKER_RUNTIME=cluster` 与 `kross-node` 已移除，多机改为 k3s Helm（`kubernetes` + JuiceFS CSI）。`worker_nodes` 表在 V25 删除。
