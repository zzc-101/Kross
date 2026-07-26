# 支持范围与兼容策略

本文说明 Kross 当前实际验证的运行环境。没有列入“持续集成验证”的组合不代表
一定无法运行，但维护者不会在缺少复现条件时承诺兼容。

## 支持级别

| 级别 | 含义 |
|---|---|
| 持续集成验证 | 每次提交都会自动安装、类型检查、测试并构建 |
| 构建验证 | 每次提交验证产物可以构建，但尚未覆盖完整交互流程 |
| 社区支持 | 可以提交 Issue 和修复，但不承诺每次发布前主动回归 |

## TUI 与源码开发

| 环境 | Node.js | 支持级别 |
|---|---|---|
| Ubuntu 最新 GitHub Runner | 22.19.0、24.x | 持续集成验证 |
| macOS 最新 GitHub Runner | 22.19.0 | 持续集成验证 |
| Windows 最新 GitHub Runner | 22.19.0 | 持续集成验证 |
| 其他 Linux、macOS、Windows 版本 | `>= 22.19.0` | 社区支持 |

`package.json` 的 `engines.node` 和仓库 `.nvmrc` 共同定义最低 Node.js
版本。npm lockfile 是依赖安装的权威来源，贡献者应使用 `npm ci` 验证干净安装。
依赖中的原生模块可能限制极少见 CPU 架构或操作系统版本；项目只对 CI 实际运行的
组合做出保证。

## Headless CLI

Headless 参数、NDJSON schema、Fixture LLM Runtime、会话恢复、审批阻塞、验证
退出码和信号清理会随 TUI 测试在 CI Node/OS 矩阵运行。安装 tarball 后的无模型
配置失败路径在 Ubuntu package job 中验证。真实 Provider 的配额、网络和输出质量
不属于普通 CI 保证；自动化用法见 [Headless 自动化](headless.md)。

## Cloud Agent

Cloud Agent 的生产目标是 Linux Docker Engine 与 Docker Compose v2。CI 会在
Ubuntu Runner 上解析 Compose 配置，分别构建 Web、Gateway 和 Worker 镜像，
并启动三个容器验证进程健康、Gateway 鉴权 API 与 Nginx 反向代理。
Docker Desktop on macOS/Windows 适合本地开发和自托管试用，属于社区支持范围。

目前 CI 不执行跨浏览器端到端测试。Web/PWA 面向当前稳定版
Chrome、Edge、Firefox 和 Safari；浏览器、移动端安装、Push、弱网恢复与远端 Git
流程应按[部署验收清单](cloud-agent-deployment.md#部署验收清单)在实际环境复验。

Gateway 默认使用 Docker Socket 管理 Worker，其权限近似宿主机 root。支持范围
不等于生产安全承诺；公网部署前必须遵循[安全模型](security.md)和
[Cloud Agent 部署与运维](cloud-agent-deployment.md)。

## 版本与兼容策略

- `0.x` 阶段可以调整内部 API、持久化格式和 Cloud 协议，但破坏性变化必须写入
  `CHANGELOG.md` 并提供迁移或清理说明。
- 根包和所有 workspace 采用同一应用版本；`npm run version:check` 会阻止版本
  漂移。协议版本、存储 schema 版本和应用版本彼此独立。
- 当前只维护 `main` 和最新预发布版本，不为旧的 `0.x` 分支承诺长期安全更新。
- `packages/core` 当前是源码扩展边界，不是稳定 SDK。稳定级别见
  [扩展 Kross](extensions.md)；public / experimental 分类描述预发布维护意图，
  不代表已经发布独立 Core 包。独立发布的触发条件见
  [SDK 发布决策](sdk-publication.md)。

遇到问题时先查看[故障排查](troubleshooting.md)。可复现问题请附上操作系统、
Node.js、Docker/Compose、浏览器版本和最小日志；安全问题按
[安全政策](../SECURITY.md)私下报告。
