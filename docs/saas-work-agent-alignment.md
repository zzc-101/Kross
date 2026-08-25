# SaaS Work Agent 架构收敛清单

状态：执行中  
目标分支：`codex/saas-work-agent`  
基线提交：`8af14d1`

## 目标

Kross 的唯一产品定位是面向组织普通成员的 SaaS Work Agent。Cloud Runtime、控制面、
工作台和文档不再兼容本地 Ink TUI、CLI 或 Coding Agent 的产品能力和数据契约。

软件开发仍可以作为后续 Skill 或可选 Tool Pack 提供，但 Git、Shell、Patch、代码验证、
多仓库和 Conductor 不再定义平台默认架构。

## 保留的通用能力

- 每位成员独立的容器和持久工作区；
- 对话、任务租约、SSE/WebSocket 事件和断线恢复；
- Tool Gateway、外部操作确认、审计 Trace；
- 文件真实路径边界、Mutation journal、进程取消与资源限制；
- 上下文治理、自动压缩、长期记忆；
- 平台版本化 Skills 和受管 MCP/Connector 基础设施。

## 已确认的遗产及影响

### 1. Mode、Plan 和 Conductor 仍是 Core 主干模型

Cloud 虽然固定传入 `auto`，Core 仍保留 `AgentMode`、`requestedMode`、`sessionMode`、
`pendingModeExecution`、`SetMode`、Plan gate、Conductor 编排、Mode Prompt、Trace 和
Checkpoint。后端仍持久化 `conversation.mode`。

影响：Cloud 只是绕过旧能力，而不是拥有独立、清晰的 SaaS Runtime；所有运行时接口、
状态和测试仍需为不可达的 TUI 行为付出复杂度。

### 2. 组织审批策略已成为无效的第二事实源

管理页面已删除，但后端仍保存 `approvalPolicy`、默认风险等级、Plan 审批和成员高风险
审批字段，并保留 `/admin/approval-policy` 接口。Worker 实际只使用固定 Cloud 策略。

影响：管理员看到或调用的配置与实际运行行为不一致。

### 3. 默认 Host 仍注册 Coding Agent 工具箱

所有 Cloud 会话默认拥有 Git、ApplyPatch、Bash、代码搜索、Task 子代理、Todo 和长进程
工具。Coding profile 仍是 Core 的默认 profile。

影响：普通工作任务携带大量开发工具描述，模型更容易按仓库、代码修改和测试任务理解
用户意图；Token 和维护成本也被无效能力占用。

### 4. Bash 可以绕过外部操作确认

固定策略允许除少量危险正则外的所有 Bash 命令。`git push`、HTTP 写请求、云 CLI 和
数据库客户端可以绕开结构化 Git/MCP 工具的确认逻辑。

影响：容器隔离只能限制宿主机影响，不能限制对外部系统的真实副作用。

### 5. Task 和完成契约仍以软件开发为中心

子代理契约包含 `repoId`、Git、`changedFiles`、`diffSummary`、测试、类型检查、构建、
lint 和 reviewer verdict。通用工作成果无法自然表达。

影响：委派、复核和完成判断被绑定到代码仓库，而不是用户目标、业务产物和外部结果。

### 6. 工作台仍以开发者为主要用户

文件面板突出 Git 分支、未提交文件和仓库克隆；Composer 展示底层模型和 Token 上下文；
工具卡片展示原始工具名和 JSON；MCP 面板要求普通用户填写 stdio 命令；附件、文件预览、
Notes、Bookmarks 和 Projects 仍不可用或仅为占位。

影响：普通用户首先看到基础设施和开发概念，而不是文件输入、任务进度和工作产物。

### 7. 多仓库和 TUI 命令门面仍大量存在

Core 仍包含 `projects.json`、workspace roots、`/add-dir`、`/approve`、`/reject`、
`/trace`、`/diff`、`/context`、`/compact`、`/undo` 相关状态、格式化和公开 Runtime API。

影响：无人调用的本地交互契约继续限制 Runtime 类型和模块边界。

### 8. Skill 存在控制面与目录两套事实源

平台已经提供版本化 Skill 包和组织安装，但 Worker 仍扫描本地个人/项目 Skill，并保留
无人调用的 `skills.list/upsert/remove` workspace command。

影响：版本、权限、持久化和来源语义不统一。

### 9. 产品文档持续传播旧定位

README、CHANGELOG、技术概览、扩展文档仍宣传三种模式、Cloud 编程 Agent、Git Diff、
Push、项目规则和本地 Host 扩展。

影响：后续产品与工程决策仍会沿旧架构继续建设。

## 有序实施清单

每项完成后独立提交；在全部结构改造完成前不运行测试或编译。

- [x] 1. 删除 Mode/Plan/Conductor、`SetMode` 和 `conversation.mode`。
- [x] 2. 删除组织审批策略字段、接口、默认值和数据库列。
- [ ] 3. 将 SaaS Profile 设为唯一 Runtime，删除 Coding profile 与兼容开关。
- [ ] 4. 收敛 SaaS 默认工具集，开发工具移出平台默认组合。
- [ ] 5. 禁止 Bash 绕过外部操作确认；外部副作用只走结构化工具边界。
- [ ] 6. 将 Task 和完成契约改为目标、产物、证据和未完成项，不再依赖 Git。
- [ ] 7. 删除 project registry、多 root 和 TUI 斜杠命令/inspection 门面。
- [ ] 8. 以平台版本化 Skill 为唯一来源，删除本地 Skill CRUD 遗产。
- [ ] 9. 重构普通用户工作台：文件/附件/产物优先，隐藏开发者诊断信息。
- [ ] 10. 重写 README、CHANGELOG、架构、安全、扩展与上手文档。
- [ ] 11. 统一运行 Worker 和前端的类型检查、测试与构建；后端由用户运行验证。

## 完成标准

- 生产代码中不存在 `plan`、`conductor`、`SetMode` 或权限模式兼容分支；
- Cloud 协议、数据库实体和 Runtime API 不再携带运行模式；
- 普通 SaaS 会话无法通过通用 Shell 绕过外部操作确认；
- 默认工具、Task、完成判断和工作台均使用通用工作语义；
- 平台 Skill、Connector、文件和记忆各自只有一个事实源；
- 用户文档不再把 Kross 描述为编程 Agent 或 TUI/CLI 的 Cloud 版本；
- 最终非后端验证全部通过，后端验证明确交由用户执行。
