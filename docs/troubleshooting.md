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

常见原因包括 `.env` 缺失、端口 `8787`/`8788` 被占用，或首次构建镜像失败。停止
并保留数据：

```bash
./scripts/start-cloud.sh --stop
```

## 登录页看不到密码，或普通用户密码登录失败

超级管理员在管理中心启用了企业 SSO 后，普通用户只能走「使用企业账号登录」。
超级管理员仍可展开「管理员应急登录」。若 IdP 回调失败，地址栏会带 `sso_error`。

常见原因：

- IdP 未登记当前 Origin 的回调地址（本机 `8787` 与 `8788` 要各登记一条）；
- Issuer 与 discovery 文档中的 `issuer` 不一致；
- Client Secret 未保存或主密钥 `KROSS_CREDENTIAL_MASTER_KEY` 已更换导致无法解密。

接入步骤见 [Cloud Agent 部署与运维](cloud-agent-deployment.md#身份与-sso)。

## 能打开工作台，但没有真实模型回复

在管理控制台确认已配置可用模型。开发环境也可以用环境变量注入：

```bash
export AGENT_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-5
```

然后重启 Cloud 栈，让 Worker 拿到新的模型环境。

## 消息发出去后没有直播

确认浏览器走的是控制面 SSE：`GET /api/v2/agent/conversations/{id}/events`。
Nginx 必须关闭 buffering，并且控制面 `spring.mvc.async.request-timeout` 不能把
长连接提前掐断。Worker 只在容器运行时保持 WebSocket；如果容器已休眠，控制面应
先唤醒再推任务。

刷新页面后历史仍在，说明 `parts` 已写入 PostgreSQL；只有直播扇出失败时才会
出现“结束后才看到完整回复”。

## 计划一直等待确认

`plan` 和 `conductor` 模式会在执行前暂停。输入：

```text
/approve
```

或取消：

```text
/reject
```

## `/undo` 报 conflict

这表示目标事务执行后，相关文件又发生了变化。Kross 会拒绝强制覆盖。

建议：

1. 用 `/diff` 和 Git 检查当前改动。
2. 手工保存需要保留的内容。
3. 明确解决冲突后再决定是否人工恢复。

Kross 当前不提供 `--force` undo。

## 恢复会话后工具审批面板没有出现

只有“尚未执行且证据完整”的工具审批可以恢复。以下情况会 fail-closed，并把上次轮次标记为 interrupted：

- 保存的 assistant tool call 或已完成 tool result 缺失；
- 工具已被移除或输入不再符合当前 schema；
- 动态风险或当前审批策略与保存时不一致；
- 上次进程在普通 LLM / 工具执行中间点退出，而不是停在审批边界。

Kross 不会为了恢复界面而猜测性重放 write / execute 操作。先用 Git、`/diff` 或 `/trace` 确认已有结果，再发送一条新任务继续。

## `/processes` 看不到之前的进程

managed process 按持久化会话隔离。切换到其他会话后不可查看或控制原会话进程。
Worker 容器重启后，原先的后台进程不会自动重连。

## MCP server 没有加载

检查 Worker 工作区中的 MCP 配置：

- `command` 必须存在且可执行。
- `args` 必须是字符串数组。
- `cwd` 必须有效。
- `disabled` 不能为 `true`。
- 可增加 `connectTimeoutMs`。

单个 MCP server 失败不会阻止 Agent 启动。修改配置后需要让 Worker 重新加载。

## 上下文过大或回答遗忘旧信息

先查看：

```text
/context
```

再按需压缩：

```text
/compact 保留精确文件路径、命令、错误文本和所有未完成事项
```

## 测试似乎运行了旧代码

该仓库的 TypeScript build 会刷新源码旁的 ignored JavaScript 产物。开发中如果测试表现与 TypeScript 源码不一致，先执行：

```bash
cd frontend && pnpm build && pnpm test
cd worker && pnpm test
```
