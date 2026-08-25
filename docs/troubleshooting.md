# 故障排查

## 服务无法启动

```bash
docker --version
docker compose version
./scripts/start-cloud.sh --logs
```

检查 `.env`、端口 `8787`、镜像构建和 Docker Socket 权限。停止且保留数据：

```bash
./scripts/start-cloud.sh --stop
```

## 登录或 SSO 失败

- 确认 IdP 回调地址与当前 Origin 一致。
- Issuer 必须与 discovery 文档完全一致。
- 更换 `KROSS_CREDENTIAL_MASTER_KEY` 后，旧 Client Secret 和模型密钥无法解密。
- 启用 SSO 后普通用户只使用企业入口，超级管理员保留应急密码入口。

## 没有模型回复

在管理中心确认至少一个平台模型已启用且凭证可解密。Worker 日志中的 `model_credential_unavailable` 表示控制面无法下发可用模型环境。

## 消息没有直播

确认浏览器的 `GET /api/v2/agent/conversations/{id}/events` 保持连接，反向代理关闭 buffering。Worker 休眠后控制面应先唤醒容器，再通过内部 WebSocket 派发任务。刷新后能看到最终消息通常表示持久化正常、仅直播链路异常。

## 外部操作停在确认

- 只有尚未执行且 checkpoint 证据完整的调用可以恢复。
- Worker 离线、租约失效、工具定义或策略变化会拒绝旧决定。
- 刷新页面后重试确认；仍失败时发送新消息让 Agent 继续并说明未完成项。

## 文件或预览失败

- 路径必须位于成员 `/work` 内，不能通过 symlink 越界。
- 文件面板只预览大小受限的 UTF-8 文本；二进制和超大文件仍可作为工作区产物存在。
- Worker 未连接时，控制面会尝试唤醒；超时检查容器和节点日志。

## Skill 没有出现

确认 Skill 版本已发布且安装到当前组织。会话使用启动时版本；发布新版本不会静默改变已有会话。Kross 不扫描工作区中的本地 Skill。

## 集群节点不上线

- `KROSS_NODE_TOKEN` 必须与 `KROSS_NODE_ID` 绑定。
- 节点应连接控制面内部地址，不要连接公网 Web 入口。
- JuiceFS 必须在所有 Worker 节点挂载一致。
- 内部端口只向节点网络开放，公网 Nginx 对 `/internal/` 返回 404 是预期行为。

## 上下文遗忘

将长期事实写入“记忆”，将流程要求发布为平台 Skill。普通工作区说明文件不会自动成为系统指令。长对话会自动摘要较早内容，必要时新建对话并重新选择 Skill。

## 源码验证

不要自动下载依赖。已有依赖时可运行：

```bash
cd frontend && pnpm typecheck && pnpm test && pnpm build
cd worker && pnpm typecheck && pnpm test && pnpm build
```

后端使用 Java 21；具体运行由部署者在目标环境完成。
