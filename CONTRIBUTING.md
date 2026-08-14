# 参与贡献

感谢参与 Kross。本分支面向自托管 Cloud Agent。提交改动前请先确认它与可审计、用户可控的 Agent 方向一致。

## 开发环境

需要 Node.js `>= 22.19`、npm、Docker Engine 与 Docker Compose：

```bash
cd frontend && npm ci && npm run dev
```

管理端：`cd frontend && npm run dev:admin`。Worker：`cd worker && npm ci && npm run dev`。
Java 后端在 `backend/`，用 Maven，不需要 npm。完整栈用 `./scripts/start-cloud.sh`。

## 仓库边界

| 路径 | 职责 |
|---|---|
| `frontend/web` | 普通用户工作台 |
| `frontend/admin-web` | 组织管理端 |
| `backend` | Java Spring Boot 控制面 |
| `worker` | 容器内的 Agent 宿主 |
| `worker/core` | Runtime、上下文、工具、会话、权限、Skills、MCP 与模型适配 |

前端和 Worker 各自 `npm ci`。后端只用 Maven。Core 是 Worker 内部代码，不要被 Web 引用。

扩展点的稳定级别、工具契约和协议边界见[扩展 Kross](docs/extensions.md)。新增公开
接口前先确认配置、Skills 或 MCP 是否已经能够解决问题。

## 提交前验证

```bash
cd frontend && npm run typecheck && npm test && npm run build
cd worker && npm run typecheck && npm test && npm run api:check
cd backend && ./mvnw -B -DskipTests compile
node scripts/check-doc-links.mjs
```

- 新行为应补充对应测试。
- 修改用户可见命令、配置或安全边界时同步更新 `README.md` 与 `docs/`。
- 新工具必须声明准确风险、校验输入、响应取消，并避免在 trace 中记录密钥。
- 不要提交 API key、`~/.kross` 数据、trace、会话文件或构建产物。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告，不要公开创建 PoC Issue。

## Pull Request

PR 描述应说明问题、实现方式、验证结果和已知限制。尽量保持单一目标，避免夹带
无关格式化或生成文件。大型重构、持久化格式变更和新扩展接口建议先创建 Feature
Request 对齐边界。
