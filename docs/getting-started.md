# 快速上手

本指南从源码启动自托管 Cloud Agent，并完成第一个受审批保护的任务。

## 1. 准备环境

需要：

- Docker Engine 与 Docker Compose v2
- 可用的模型凭证（OpenAI / Anthropic / OpenRouter 等）
- 从源码开发 Web / Worker 时才需要 Node.js `>= 22.19` 与 pnpm `10.14`

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

首次运行会从 `.env.example` 创建 `.env`、生成内部服务密钥，并构建 Web、
控制面和 Worker 镜像。启动后打开：

- 用户工作台：`http://localhost:8787`
- 管理中心：`http://localhost:8787/admin/`

空实例第一次注册的用户会成为平台超级管理员。超管创建组织并指定组织管理员后，
组织管理员再为本组织登记成员和模型。普通用户只使用工作台。企业 SSO 在管理中心
「平台设置」接入，Kross 只做 OIDC 验证方。

常用命令：

```bash
./scripts/start-cloud.sh --no-build
./scripts/start-cloud.sh --logs
./scripts/start-cloud.sh --stop
```

默认使用账号密码和 `KROSS_SESSION`。`KROSS_DEV_IDENTITY=1` 仅供本机冒烟跳过登录，
公网必须关闭。配置、安全边界和验收清单见
[Cloud Agent 部署与运维](cloud-agent-deployment.md)。
单机 Compose 默认即可；JuiceFS 与多机 `kross-node` 见该文档「工作区存储：单机与集群」。

## 3. 配置模型

用组织管理员登录管理中心，添加一条模型档案（Provider、模型名、API Key）。
开发环境也可以把凭证写进 `.env` 后重启栈，字段见 [配置参考](configuration.md)。

## 4. 完成第一个任务

在工作台直接输入自然语言：

```text
检查当前工作区，找出最可能的回归并运行相关测试。
```

Cloud Worker 默认按可信工作区权限运行：

1. 工作区内的读/写类工具自动执行。
2. Shell、网络等更高风险操作会在对话里弹出确认面板。
3. 选择「允许一次」或「拒绝」后继续。

对话历史写在控制面 PostgreSQL，刷新页面可以接着看。代码改动在该成员的 `/work`
工作区，容器休眠后磁盘仍在。

## 5. 工作方式

工作台始终以 `auto` 开跑。Agent 仍可能根据话术进入计划或指挥家流程，例如：

```text
先做计划，再重构配置模块，等我确认方案后再改文件。
```

```text
用指挥家把认证改造拆成独立任务，分别实现后再统一验收。
```

计划或高风险工具都会在界面里等待你确认，不需要输入 TUI 斜杠命令。

## 停止与清理

```bash
./scripts/start-cloud.sh --stop
```

Compose 声明的 PostgreSQL 和 MinIO 数据卷会保留。`docker compose down -v` 会删除
本地数据库和对象存储，属于破坏性操作。更多细节见
[Cloud Agent 部署与运维](cloud-agent-deployment.md#数据与恢复)。
