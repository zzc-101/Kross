# 数据格式与备份

Kross 把应用版本、线协议版本和持久化格式版本分开管理。升级应用不代表所有数据
格式都要递增；只有某种格式发生不兼容变化时才升级对应版本并提供迁移说明。

## 当前格式清单

### 本地 TUI 与 Core

| 数据 | 位置 | 当前版本 | 兼容行为 |
|---|---|---:|---|
| 用户配置 | `~/.kross/config.json` | 1 | 读取无版本旧文件；下次写入补版本 |
| 多仓项目模板 | `~/.kross/projects.json`、项目 `.kross/project.json` | 1 | 读取无版本旧文件；未来版本拒绝 |
| 会话事实源 | `~/.kross/sessions/**/events.jsonl` | 1 | 每行 `schemaVersion`；未来版本拒绝 |
| Context / Thread / Work State / Run Checkpoint | 嵌入会话事件 | 1 | 各自独立版本；未来版本拒绝 |
| 会话索引 | `~/.kross/session-store.db` | SQLite migration 2 | 可由会话 JSONL 重建 |
| Trace 事件 | `~/.kross/traces/**/*.jsonl` | 1 | 新行写入 `schemaVersion`；读取无版本旧行 |
| Trace 索引 | `~/.kross/traces/index.db` | SQLite migration 2 | JSONL 是主要恢复来源 |
| Mutation journal | `~/.kross/mutations/**/journal.jsonl` | 1 | 新行写入 `schemaVersion`；读取无版本旧行 |
| Mutation blobs | `~/.kross/mutations/**/blobs` | 内容寻址 | hash 即格式边界 |

`~/.kross/mcp.json`、Project Instructions 和 Skills 是用户维护的声明式输入，不是
Kross 生成的运行状态。它们由各自 schema 校验，但当前不承诺独立的持久化迁移
版本。

### Cloud Gateway 与 Worker

| 数据 | 容器内位置 | 当前版本 | 兼容行为 |
|---|---|---:|---|
| 工作区注册表 | Gateway 数据目录 `workspaces.json` | 1 | 未来版本拒绝 |
| Provider 配置 | Gateway 数据目录 `provider.json` | 1 | 未来版本拒绝 |
| Push 订阅 | Gateway 数据目录 `push-subscriptions.json` | 1 | 读取旧数组；新写入版本化对象 |
| Worker 事件 | 工作区 `.kross/cloud-events/*.jsonl` | Protocol 1 | 未来协议版本拒绝 |
| 请求幂等索引 | 工作区 `.kross/cloud-events/**/requests/*.json` | 1 | 读取旧数组；新写入版本化对象 |
| 事件序号预留 | 工作区 `.kross/cloud-events/**/sequences/*.seq` | 1 | 读取旧整数；新写入版本化对象 |
| 会话设置 | 工作区 `.kross/cloud-session-settings/*.json` | 1 | 读取旧直接对象；新写入版本化对象 |
| Worker 会话、Trace、Mutation | 工作区 `/workspace/.kross` | 同 Core | 同本地格式 |

Web 端还会在浏览器 `localStorage` 保存 Gateway 地址、访问令牌、界面语言和每会话
最后接收的事件序号。这些都是独立标量，不采用结构化 schema 版本；清理站点数据会
要求重新登录和重新同步，但不会删除 Gateway 或 Worker 中的权威会话数据。

Gateway 数据目录默认挂载到 Compose 的 `kross-server-data` 命名卷。每个工作区的
仓库和 Worker 状态位于独立的 `kross-workspace-*` 命名卷；卷的真实名称以
Gateway 注册表和 `docker volume ls` 为准。

## 读取原则

- 无版本的已知旧格式只在明确提供兼容分支时读取；首次改写后升级为当前格式。
- 明确带有更高版本的数据不会被猜测性降级、部分读取或覆盖，启动/恢复会返回
  包含格式名称、实际版本和支持版本的错误。
- append-only JSONL 可能因进程崩溃留下最后半行。语法损坏或 schema 不完整的单行
  可以跳过，以保留此前完整历史；这不适用于语法完整但版本未知的记录。
- SQLite 索引不是会话或 Trace 的唯一事实源。删除索引前仍应备份整个数据目录，
  不能假设任何数据库文件都永远可丢弃。
- 旧版本应用不保证读取新版本写出的数据。降级前必须恢复升级前备份。

## 本地备份与恢复

先退出所有 Kross TUI 进程，避免复制到一半的 SQLite WAL 或 JSONL：

```bash
cp -a ~/.kross ~/.kross.backup-YYYYMMDD
```

恢复时先保留当前目录，再把完整备份放回 `~/.kross`。不要只复制
`session-store.db` 或 `traces/index.db`；应连同 JSONL、WAL、mutation blobs 和
配置一起备份。该目录可能包含 API Key、源码片段、命令参数和历史文件正文，备份
应加密并限制访问。

## Cloud 备份与恢复

1. 使用 `./scripts/start-cloud.sh --stop` 停止 Web、Gateway 和动态 Worker。
2. 记录 `docker volume ls` 中的 Gateway 与全部 `kross-workspace-*` 卷。
3. 对每个命名卷创建一致性归档；不要只备份 `kross-server-data`。
4. 恢复时使用相同或更高的 Kross 版本，把归档恢复到原卷名后再启动服务。
5. 执行[部署验收清单](cloud-agent-deployment.md#部署验收清单)，确认工作区、
   会话、待审批状态和 Git 数据均可读取。

工作区删除操作和 `docker compose down -v` 会改变可恢复范围。永久删除前至少
保留一次可验证归档；单纯停止容器不会删除数据卷。

## 格式变更要求

任何修改上述格式的提交都必须：

1. 明确旧格式是否可读，以及未知未来版本如何拒绝。
2. 同时提供旧格式 fixture 和未来版本拒绝测试。
3. 更新本清单和 `CHANGELOG.md`。
4. 涉及不可逆迁移时提供升级前备份、失败回滚与降级限制。
5. 运行完整 `npm run check`；Cloud 格式还要构建三个容器并执行部署验收。
