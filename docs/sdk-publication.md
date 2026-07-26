# Core 与 Protocol SDK 发布决策

> 状态：已采纳  
> 日期：2026-07-26

## 决策

v0.1 只发布 `@zzc-101/kross` CLI。`@kross/core` 与 `@kross/protocol` 继续作为
monorepo 内的 private workspace，不在本阶段发布独立 npm SDK。

这不是否定现有 TypeScript Core 的价值，而是区分三种不同的复用边界：

| 使用方 | 当前推荐边界 |
|---|---|
| Kross TUI、Headless、Eval、Worker | 仓库内直接消费 `@kross/core` |
| 自定义 TypeScript Host | Fork/源码依赖 `createAgentHost` 和 public API |
| Web、移动端、未来 SaaS Control Plane | 消费 Cloud Protocol，不依赖 Core |
| Go、Java、Python 客户端 | 固定版本的 JSON Schema 与线协议语义 |

未来独立 SaaS 仓库应把 Gateway/Control Plane 当作 Protocol 客户端与路由层。模型
循环、工具、会话 Checkpoint 和工作区执行仍由 Worker/Core 负责。这样 Control
Plane 可以使用 Go、Java、Python 或 TypeScript，而不需要重写已经成熟的 Core。

## 为什么现在不发布

Core 已有显式 public/experimental 边界和 API 快照，但仍缺少独立 SDK 所需的
发行条件：

- 当前真实调用方全部位于同一仓库，没有外部安装反馈；
- package 仍直接导出 TypeScript 源码，没有独立 JS、类型声明和 exports 条件；
- Core 依赖 Node.js、SQLite、进程、文件系统和本地工作区语义，不是通用浏览器
  SDK；
- `0.x` 期间 Host、存储与 Provider 组合仍可能调整；
- 发布后需要额外维护 SemVer、弃用周期、安全公告和跨版本集成矩阵。

Protocol 比 Core 更接近独立发布条件，但语言无关 JSON Schema 已经满足当前跨仓库
需求。此时发布 npm 包只会让非 TypeScript 控制面再次绑定 Node 工具链。

## 当前兼容承诺

- Core `public` 表示首方 Host 优先复用的源码级预览接口；变更进入 Changelog 并
  受 API 快照保护，但不等于长期稳定 npm SDK。
- Core `experimental` 可在次版本调整；internal 不允许从顶层导出。
- Cloud Protocol 按 `PROTOCOL_VERSION` 管理破坏性变化。消费者应从 release tag
  或 commit 固定三份 JSON Schema，不要在生产中跟随 `main`。
- 应用版本、Protocol 版本和持久化 schema 版本分别演进。

## 重新评估触发条件

满足以下任一产品信号后重新评估，而不是按日期强制发布：

1. 至少两个仓库外的真实 Host 需要直接嵌入 Core；
2. 未来 SaaS Worker 需要从主仓库之外安装 Core；
3. 社区插件开发反复因为源码依赖受阻；
4. Protocol 出现多个 TypeScript 客户端，复制 schema 与类型开始产生漂移。

## 发布门

若决定发布 `@kross/protocol`：

- 确认可用且归属明确的 npm scope；
- 产出 ESM JavaScript、`.d.ts`、JSON Schema 和正确的 package exports；
- 在 monorepo 外通过 `npm pack` 安装并验证；
- 定义 Protocol 版本与 npm SemVer 的映射和弃用窗口；
- 保持包不依赖 Core、Node 原生模块或服务端私有实现。

若决定发布 `@kross/core`，除以上条件外还必须：

- 收敛 public API 到 Host、Runtime、工具与持久化的必要契约；
- 明确 Node.js/操作系统/原生依赖支持矩阵；
- 提供自定义 Host、工具、审批、取消和关闭的集成测试；
- 验证相邻版本的会话恢复与数据兼容；
- 建立实验 API 的标记、弃用和迁移流程。

在这些发布门完成前，保持 private 能避免制造虚假的稳定性承诺，同时不阻碍源码
Fork、MCP 扩展、Protocol 客户端或未来 SaaS 控制面的开发。
