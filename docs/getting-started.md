# 快速上手

本指南从源码启动自托管 Cloud Agent，并完成第一个受审批保护的编程任务。

## 1. 准备环境

需要：

- Docker Engine 与 Docker Compose v2
- Node.js `>= 22.19` 与 pnpm `10.14`（仅在从源码开发 Web / Worker 时需要）
- 可用的模型凭证

确认 Docker：

```bash
docker --version
docker compose version
```

## 2. 启动 Cloud Agent

从仓库根目录运行：

```bash
./scripts/start-cloud.sh
```

首次运行会从 `.env.example` 创建 `.env`、生成内部服务密钥，并构建 Web、管理端、
控制面和 Worker 镜像。启动后打开：

- 用户工作台：`http://localhost:8787`
- 组织管理控制台：`http://localhost:8788`

常用命令：

```bash
./scripts/start-cloud.sh --no-build
./scripts/start-cloud.sh --logs
./scripts/start-cloud.sh --stop
```

本地开发使用显式开发身份流；公网部署必须换成生产 OIDC 或会话认证。配置、安全
边界和验收清单见 [Cloud Agent 部署与运维](cloud-agent-deployment.md)。

## 3. 配置模型

在管理控制台或控制面配置中保存模型档案。开发环境也可以用环境变量注入：

OpenAI 示例：

```bash
export AGENT_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-5
```

Anthropic 示例：

```bash
export AGENT_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL=claude-sonnet-4-5
```

其他 Provider 和完整字段见 [配置参考](configuration.md)。

## 4. 完成第一个任务

在工作台直接输入自然语言：

```text
检查当前分支的改动，找出最可能的回归并运行相关测试。
```

默认权限模式下：

1. 读取类工具自动执行。
2. 写文件、运行命令或访问网络前暂停。
3. 审批面板展示工具、风险类型和输入预览。
4. 选择 Approve 或 Reject 后继续运行。

## 5. 选择工作方式

### 自动模式

```text
/mode auto
```

适合大多数任务。Agent 直接工作，也可根据任务复杂度进入计划或编排流程。

### 计划模式

```text
/mode plan
重构配置模块，但先给我完整计划。
/approve
```

计划未批准前不会开始文件修改。

### 指挥家模式

```text
/mode conductor
把认证改造拆成独立任务，交给 worker 执行并统一验收。
```

## 6. 检查与恢复

```text
/diff
/trace
/context
/undo
```

- `/diff` 查看 Agent 触达的文件和 Git 变更摘要。
- `/trace` 查看最近运行和工具事件。
- `/context` 查看上下文预算与来源。
- `/undo` 在文件未被后续修改时撤销最近事务。

对话历史保存在控制面 PostgreSQL。刷新页面后仍可从库中加载完整 `parts`。下一步
可阅读 [安全模型](security.md)。

## 停止与清理

从仓库启动的 Cloud Agent 可以停止并保留数据：

```bash
./scripts/start-cloud.sh --stop
```

Compose 声明的 PostgreSQL 数据卷会保留。`docker compose down -v` 会删除本地
控制面数据库，属于破坏性操作。更多细节见
[SaaS Work Agent 部署与运维](cloud-agent-deployment.md#数据与恢复)。
