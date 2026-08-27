# 快速上手

目标：启动自托管 Kross，为组织配置模型，并让普通成员生成第一个工作产物。

## 1. 准备环境

- Docker Engine
- Docker Compose v2
- 一个受支持 Provider 的模型凭证

源码开发前端或 Worker 时还需要 Node.js `>= 22.19.0` 与 pnpm `10.14`。

## 2. 启动

在仓库根目录运行：

```bash
./scripts/start-cloud.sh
```

首次启动会创建 `.env`、生成内部密钥并构建镜像。打开：

- 工作台：`http://localhost:8787`
- 管理中心：`http://localhost:8787/admin/`

常用命令：

```bash
./scripts/start-cloud.sh --no-build
./scripts/start-cloud.sh --logs
./scripts/start-cloud.sh --stop
```

## 3. 初始化平台

1. 注册第一个账号，成为平台超级管理员。
2. 在管理中心添加并启用平台模型档案。
3. 创建组织，指定组织管理员并邀请成员。
4. 可选：配置企业 OIDC SSO。
5. 可选：发布版本化 Skill 并安装到组织。

普通成员不选择模型，也不填写 API Key 或外部工具命令。

## 4. 完成第一个任务

登录工作台，直接描述结果：

```text
阅读工作区中的资料，整理为一份摘要，并把后续行动保存成 Markdown 文档。
```

Agent 会自动选择是否读取文件、更新 Todo、派生受限子任务并创建产物。生成文件可在“文件与产物”中查看。若受管工具即将访问或修改外部系统，工作台会显示简化确认面板。

## 5. 使用 Skill 和记忆

- 从“技能”中启动管理员已安装的版本化 Skill；会话固定使用启动时的版本。
- 在“记忆”中保存长期事实或偏好，也可以在对话中要求“记住这个”。
- 放入 `/work/files` 的资料只是待处理数据，不会自动成为系统指令。

## 6. 数据与停止

对话保存在 PostgreSQL，文件保存在成员 `/work` 卷。停止服务不会删除这些数据：

```bash
./scripts/start-cloud.sh --stop
```

`docker compose --project-directory . -f deploy/local/docker-compose.yml down -v` 会删除 Compose 数据卷，属于破坏性操作。生产部署、备份和集群配置见[部署与运维](cloud-agent-deployment.md)。
