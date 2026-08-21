# 故障排查

## Cloud Agent 无法启动

先确认 Docker 与 Compose：

```bash
docker --version
docker compose version
```

然后从仓库根目录重新启动并查看日志：

```bash
./scripts/start-cloud.sh --logs
```

常见原因包括 `.env` 缺失、端口 `8787` 被占用，或首次构建镜像失败。停止
并保留数据：

```bash
./scripts/start-cloud.sh --stop
```

## 登录页看不到密码，或普通用户密码登录失败

超级管理员在管理中心启用了企业 SSO 后，普通用户只能走「使用企业账号登录」。
超级管理员仍可展开「管理员应急登录」。若 IdP 回调失败，地址栏会带 `sso_error`。

常见原因：

- IdP 未登记当前 Origin 的回调地址（Compose 部署只需一条，本机 Vite 开发才要
  给 `:4173` / `:4174` 各登记一条）；
- Issuer 与 discovery 文档中的 `issuer` 不一致；
- Client Secret 未保存或主密钥 `KROSS_CREDENTIAL_MASTER_KEY` 已更换导致无法解密。

接入步骤见 [Cloud Agent 部署与运维](cloud-agent-deployment.md#身份与-sso)。

## 能打开工作台，但没有真实模型回复

在管理中心确认本组织已配置可用模型档案。开发环境也可以把 `AGENT_LLM_*` /
`OPENAI_API_KEY` 等写入 `.env` 后重启栈，让 Worker 拿到新的模型环境。字段见
[配置参考](configuration.md)。

## 消息发出去后没有直播

确认浏览器走的是控制面 SSE：`GET /api/v2/agent/conversations/{id}/events`。
Nginx 必须关闭 buffering，并且控制面 `spring.mvc.async.request-timeout` 不能把
长连接提前掐断。Worker 只在容器运行时保持 WebSocket；如果容器已休眠，控制面应
先唤醒再推任务。

刷新页面后历史仍在，说明 `parts` 已写入 PostgreSQL；只有直播扇出失败时才会
出现“结束后才看到完整回复”。

## 工具一直停在确认面板

工作台用按钮批准或拒绝高风险工具，不要发送 TUI 的 `/approve`。若面板消失：

- 刷新后只有「尚未执行且证据完整」的审批能恢复；
- 工具定义、动态风险或策略与保存时不一致会 fail-closed；
- 上次进程若在 LLM / 工具执行中间退出，该轮会标为 interrupted，需要发一条新消息
  继续。

先看对话里的工具结果和 Git 状态，再决定是否重试。

## 集群节点不上线，或任务起不来

- 控制面必须是 `KROSS_WORKER_RUNTIME=cluster` 且 `KROSS_WORKER_STORAGE=juicefs`。
- `KROSS_NODE_TOKEN` 在控制面与 `kross-node` 上一致。
- `KROSS_PUBLIC_BASE_URL` / `KROSS_CONTROL_PLANE_URL` 必须是节点和 Worker 容器
  都能访问的地址，不要用 `http://kross-server:8787`。
- 节点机能访问 `.../internal/v2/nodes/ws`，本机已挂载同一套 JuiceFS。
- `kross-node` 日志若反复 connection refused，先查控制面 Nginx `/internal/` 反代
  和防火墙。

## MCP server 没有加载

Cloud Worker 从容器 `$HOME/.kross/mcp.json` 读取配置，该路径不随 `/work` 持久化。
检查：

- `command` 必须在容器内存在且可执行。
- `args` 必须是字符串数组。
- `cwd` 必须有效。
- `disabled` 不能为 `true`。
- 可增加 `connectTimeoutMs`。

单个 MCP server 失败不会阻止 Agent 启动。修改配置后需要让 Worker 重新加载。

## 上下文过大或回答遗忘旧信息

工作台没有独立的 `/context` 面板。可以直接请 Agent 摘要当前任务要点，或新开
对话以降低上下文。超长历史由 Runtime 自动老化工具输出并滚动压缩。

## 测试似乎运行了旧代码

该仓库的 TypeScript build 会刷新源码旁的 ignored JavaScript 产物。开发中如果
测试表现与 TypeScript 源码不一致，先执行：

```bash
cd frontend && pnpm build && pnpm test
cd worker && pnpm test
```
