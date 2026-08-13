# 参与贡献

感谢参与 Kross。提交改动前请先确认它与本地优先、可审计、用户可控的 Agent 方向一致。

## 开发环境

需要 Node.js `>= 22.19` 和 npm：

```bash
git clone https://github.com/zzc-101/Kross.git
cd Kross
npm ci
npm run dev --workspace @kross/tui
```

Web、管理端和 Worker 也分别从 `@kross/web`、`@kross/admin-web` 与
`@kross/worker` workspace 启动；Java 控制面在 `control-plane/`。根目录只负责
全仓构建、测试和发布检查。

## 仓库边界

| 路径 | 职责 |
|---|---|
| `packages/core` | Runtime、上下文、工具、会话、权限、Skills、MCP 与模型适配 |
| `packages/protocol` | Cloud 命令、事件与快照的 Zod 线协议 |
| `packages/work-domain` | 浏览器安全的 Work 领域模型 |
| `packages/work-runtime` | Worker 侧 Work 运行时 |
| `apps/tui` | Ink 终端交互和本地宿主 |
| `apps/web` | 普通用户工作台 |
| `apps/admin-web` | 组织管理端 |
| `apps/worker` | 容器内的 headless Agent 宿主 |
| `apps/eval` | Harness Eval Runner |
| `control-plane` | Java Spring Boot 控制面 |

依赖应保持从产品层指向 Core/Protocol，Core 不得反向依赖 TUI、Web 或
Worker。跨包引用使用 workspace 包名，不使用穿越目录的相对路径。

扩展点的稳定级别、工具契约和协议边界见[扩展 Kross](docs/extensions.md)。新增公开
接口前先确认配置、Skills 或 MCP 是否已经能够解决问题。

## 提交前验证

```bash
npm run typecheck
npm test -- --run
npm run docs:check
npm run package:check
```

- 新行为应补充对应测试。
- 修改用户可见命令、配置或安全边界时同步更新 `README.md` 与 `docs/`。
- 修改 `packages/protocol` 时保留旧事件的解析与重放行为，必要时提升协议版本。
- 新工具必须声明准确风险、校验输入、响应取消，并避免在 trace 中记录密钥。
- 不要提交 API key、`~/.kross` 数据、trace、会话文件或构建产物。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告，不要公开创建 PoC Issue。

## Pull Request

PR 描述应说明问题、实现方式、验证结果和已知限制。尽量保持单一目标，避免夹带
无关格式化或生成文件。大型重构、持久化格式变更和新扩展接口建议先创建 Feature
Request 对齐边界。
