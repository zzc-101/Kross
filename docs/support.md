# 支持范围与兼容策略

本文说明 Kross 当前实际验证的运行环境。没有列入“持续集成验证”的组合不代表
一定无法运行，但维护者不会在缺少复现条件时承诺兼容。

## 支持级别

| 级别 | 含义 |
|---|---|
| 持续集成验证 | 每次提交都会自动安装、类型检查、测试并构建 |
| 构建验证 | 每次提交验证产物可以构建，但尚未覆盖完整交互流程 |
| 社区支持 | 可以提交 Issue 和修复，但不承诺每次发布前主动回归 |

## 源码开发

| 环境 | 运行时 | 支持级别 |
|---|---|---|
| Ubuntu 最新 GitHub Runner | Node.js 22.19.0、24.x；Java 21；Go 1.25 | 持续集成验证 |
| macOS 最新 GitHub Runner | Node.js 22.19.0 | 持续集成验证（frontend / worker） |
| Windows 最新 GitHub Runner | Node.js 22.19.0 | 持续集成验证（frontend / worker） |
| 其他 Linux、macOS、Windows 版本 | Node.js `>= 22.19.0` | 社区支持 |

`frontend/package.json` 与 `worker/package.json` 的 `engines.node` 和仓库
`.nvmrc` 共同定义最低 Node.js 版本。两套 pnpm lockfile 是依赖安装的权威来源，
贡献者应分别在 `frontend/` 和 `worker/` 使用 `pnpm install --frozen-lockfile`
验证干净安装。控制面用 Maven（JDK 21），`node/` 用 Go 1.25 与提交的 `go.sum`。

## Cloud Agent

生产目标是 Linux Docker Engine 与 Docker Compose v2。CI 会在 Ubuntu Runner 上
解析 Compose 配置，构建 Web、控制面、Worker、`kross-node` 镜像，并做容器 smoke
（进程健康、控制面鉴权 API 与 Nginx 反向代理）。

Docker Desktop on macOS/Windows 适合本地开发和自托管试用，属于社区支持范围。
目前 CI 不执行跨浏览器端到端测试。Web 面向当前稳定版 Chrome、Edge、Firefox
和 Safari；浏览器、移动端、弱网与公网反向代理应按
[Cloud Agent 部署与运维](cloud-agent-deployment.md) 在实际环境复验。

单机 Compose 把 Docker Socket 挂到控制面；集群应只给 `kross-node`。Socket 权限
近似宿主机 root。支持范围不等于生产安全承诺；公网部署前必须遵循
[安全模型](security.md)和[Cloud Agent 部署与运维](cloud-agent-deployment.md)。

## 版本与兼容策略

- `0.x` 阶段可以调整内部 API、持久化格式和 Cloud 协议，但破坏性变化必须写入
  `CHANGELOG.md` 并提供迁移或清理说明。
- `frontend` 与 `worker` 采用同一应用版本；`node scripts/check-version-consistency.mjs`
  会阻止版本漂移。协议版本、存储 schema 版本和应用版本彼此独立。
- 当前只维护本分支和最新预发布版本，不为旧的 `0.x` 分支承诺长期安全更新。
  本地 TUI / CLI 在 `main`，不随本分支发布。
- `worker/core` 当前是 Worker 内部源码，不是稳定 SDK。稳定级别见
  [扩展 Kross](extensions.md)；public / experimental 分类描述预发布维护意图，
  不代表已经发布独立 Core 包。

遇到问题时先查看[故障排查](troubleshooting.md)。可复现问题请附上操作系统、
Node.js、Docker/Compose、浏览器版本和最小日志；安全问题按
[安全政策](../SECURITY.md)私下报告。
