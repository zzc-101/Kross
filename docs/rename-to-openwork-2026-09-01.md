# 产品改名方案：Kross 到 OpenWork

远程仓库已从 `zzc-101/Kross-Work` 改名为 `zzc-101/OpenWork`，本文给出代码库内产品名替换的分阶段方案。
方案待产品负责人审核后执行，其中命名映射一节存在未拍板项，需先定稿。

## 目标与核心原则

**核心原则：把产品名与技术标识解耦。**

本轮改名的价值不只是把 `Kross` 换成 `OpenWork`，而是让技术标识不再绑定产品名。
配置前缀、环境变量、资源名一旦使用与产品名无关的稳定值（`app`、release name、组件名），
下一次产品改名就只需改文案，不必再做一轮全仓库替换与部署迁移。

因此推荐：产品名（面向用户的文案、仓库、镜像仓库 namespace）用 `OpenWork`；
技术标识（配置树、环境变量、k8s 资源名）中性化，不带产品名。

## 现状盘点

全仓库命中 346 个文件，`kross` 1287 处、`KROSS` 238 处、`Kross` 145 处。按目录分布：

| 目录 | 命中文件数 | 主要内容 |
|---|---|---|
| `backend` | 226 | Java 包名 `com.kross`、MyBatis XML、配置前缀 |
| `worker` | 54 | `~/.kross` 家目录、包名、测试临时目录前缀 |
| `docs` | 20 | 产品名文案约 40 处、两个图片文件名 |
| `deploy` | 19 | compose、Helm chart、镜像名、数据库名 |
| `frontend` | 15 | UI 文案、HTTP header、localStorage key、CSS keyframes |
| `scripts` 及根目录 | 12 | 启动脚本、README、CI 模板 |

## 改动分层

按"改动风险"而非"改动位置"分四层，这是分阶段的依据。

### 第一层：内部标识（编译期可验证，无运行时风险）

| 位置 | 现状 | 说明 |
|---|---|---|
| Java 包名 | `com.kross.*` | backend 226 个文件，需移动目录并改全部 `package` / `import` |
| MyBatis XML | `namespace` 与 `resultType` 全限定名 | `backend/src/main/resources/mapper/*.xml`，随包名同步 |
| MyBatis 配置 | `application.yml:49` `type-handlers-package: com.kross.support` | 随包名同步 |
| Java 类名 | `KrossProperties`（60 处引用）、`KrossApplication`、`KrossBearerHandshakeHandler` | 建议改为 `AppProperties` 等中性名 |
| Maven 坐标 | `com.kross:kross-control-plane`、`<finalName>`、`<description>` | `backend/pom.xml` |
| npm 包名 | `kross-worker`、`kross-frontend` | `worker/package.json`、`frontend/package.json` |
| worker 内部符号 | `krossPaths.ts` 文件名、`KrossHomeOptions`、`resolveKrossHome`、`krossHome` 参数 | 建议随家目录常量一起中性化 |
| 测试临时目录 | 约 20 处 `mkdtemp(join(tmpdir(), 'kross-xxx-'))` | 无风险，随手替换 |

### 第二层：对外契约（前后端需同步，影响在线用户与既有部署）

| 位置 | 现状 | 影响 |
|---|---|---|
| HTTP header | `x-kross-organization-id`、`x-kross-user-id`、`x-kross-user-name`、`x-kross-knowledge-token`、`x-kross-test` | 前后端必须同一次发布，否则鉴权失败 |
| Cookie | `KROSS_SESSION`（`application.yml:9`） | 改名后在线会话全部失效，用户被登出 |
| localStorage | `kross.conversation-id`、`kross.organization-id` | 用户丢失上次选中的组织与会话，可接受 |
| 环境变量 | 60 个 `KROSS_*` | 所有 compose、Helm values、CI、本地 `.env` 需同步 |
| 配置根节点 | `application.yml:70` 的 `kross:`；`@ConditionalOnProperty(prefix = "kross.cache")`、`name = "kross.worker-runtime"` | 与环境变量绑定，同一次改 |

### 第三层：持久化状态（改名等于数据迁移）

以下命名承载运行态或已落盘的数据，改名会导致既有资源无法识别，**不能只做字符串替换**。

| 位置 | 现状 | 后果 |
|---|---|---|
| `AgentNames.java:19` | 容器名前缀 `"kross-work-" + digest(agentId)` | 改前缀后运行中的容器成为孤儿，调度与清理找不到它们 |
| `KubernetesAgentNames.java:7` | annotation key `kross-workspace-path` | 被 `storageclass.yaml:16` 的 `pathPattern` 引用，改后既有 PVC 路径解析失败 |
| worker 家目录 | `~/.kross`（存 `mcp.json`），及工作区内 `.kross` 目录 | 既有 workspace 的 MCP 配置失联 |
| PostgreSQL | 库名与用户名均为 `kross` | 需 dump/restore 或建角色迁移 |
| JuiceFS | `metaDatabase: kross_jfs`、`bucket: kross-jfs`、`volumeName: kross-work`、`storageClass: kross-juicefs` | 文件系统级迁移，成本最高 |
| Docker volume | `kross-postgres-v3`、`kross-minio-v2`、network `kross-control` | 本地环境重建即可 |
| k8s | namespace `kross`、secret `kross-secrets`、`kross.labels` / `kross.namespace` helper、label `app.kubernetes.io/name: kross` | 需重新部署；label 变更会导致 Deployment selector 不可变冲突 |

### 第四层：门面（镜像名、UI 文案、文档）

| 位置 | 现状 |
|---|---|
| 镜像名 | `kross-server`、`kross-web`、`kross-worker`、`kross-knowledge`；出现在 compose、Helm values、`ci.yml`、`release-candidate.yml`、`PULL_REQUEST_TEMPLATE.md` |
| 页面标题 | `frontend/web/index.html` 的 `Kross`、`frontend/admin-web/index.html` 的 `Kross Admin` |
| PWA | `frontend/web/public/manifest.webmanifest` 的 `name` / `short_name` |
| UI 文案 | `screens.tsx:44` "登录 Kross"、`Thread.tsx:271` "Kross Work Agent"、`AuthPage.tsx:36`、`AdminLayout.tsx:67` |
| CSS | keyframes `kross-spin`（`styles.css:17`）、`kross-loading-dot`（`Thread.css:61`） |
| 日志 | `worker/src/logger.ts:20` 的 `service: 'kross-worker'` |
| 文档 | `docs` 下 20 个文件与根目录 README 共约 40 处产品名；图片 `docs/images/kross-model-profiles.png`、`kross-agent-workflow.png` |

## 命名映射（待拍板）

下表左列已确认，右列标注"待定"的项需产品负责人定稿后才能开工。

| 类别 | 现状 | 建议取值 | 状态 |
|---|---|---|---|
| 产品名（文案） | Kross | OpenWork | 已定 |
| 仓库 | Kross-Work | OpenWork | 已完成 |
| Java 包名 | `com.kross` | `com.openwork` | 待定 |
| Java 配置类 | `KrossProperties` | `AppProperties` | 待定 |
| 配置根节点 | `kross:` | `app:` | 待定 |
| 环境变量 | `KROSS_*` | `APP_*` | 待定 |
| HTTP header | `x-kross-*` | 短命名空间，如 `x-ow-*`；不建议裸用 `x-organization-id`，易与网关 header 冲突 | 待定 |
| Cookie | `KROSS_SESSION` | `APP_SESSION`；不建议裸用 `SESSION`，同域多应用会互相覆盖 | 待定 |
| localStorage | `kross.*` | `app.*` | 待定 |
| 镜像名 | `kross-server` 等 | registry 下 `<org>/server`；本地用 compose 项目名区分 | 待定 |
| 容器名前缀 | `kross-work-` | 保留前缀（归属识别需要），建议同时改用 label 选择器判定归属 | 待定 |
| k8s annotation | `kross-workspace-path` | `openwork.io/workspace-path`（k8s 规范要求域名式 key，现状不合规） | 待定 |
| k8s 资源名 | `kross-secrets` | `{{ .Release.Name }}-secrets`，与产品名解耦 | 待定 |
| k8s label | `app.kubernetes.io/name: kross` | `name` 填组件名（server/web/worker），产品名放 `part-of` | 待定 |
| 数据库名与用户 | `kross` | `app` | 待定 |
| worker 家目录 | `~/.kross` | 保留一个 dotfile 名以避免与其他工具冲突，取值待定 | 待定 |

需要注意：中性化本身不降低迁移成本，第二、三层的中断照样发生。
它的收益是让这一轮成为最后一轮。

## 分阶段实施

阶段划分的原则是：先做可独立验证、不影响运行态的部分，把会中断服务的改动集中到一次发布。

### 阶段一：门面（第四层）

范围：镜像名、页面标题、PWA manifest、UI 文案、CSS keyframes、日志 service 名、文档与图片文件名。

不涉及任何接口与持久化命名，可独立合并、独立回滚。镜像名改动需同步 compose、Helm values 与两个 workflow。

验收标准：

1. 前台与管理端页面标题、登录页、侧栏、会话头部均显示新产品名，无 `Kross` 残留。
2. `docker build` 与 compose 起服务成功，Helm `helm template` 通过。
3. `rg -i kross frontend docs *.md` 仅剩预期的历史记录类引用。

### 阶段二：内部标识（第一层）

范围：Java 包名与目录、MyBatis XML 与 `type-handlers-package`、三个 `Kross*` 类名、Maven 坐标、npm 包名、worker 内部符号、测试临时目录前缀。

改动量最大但风险最低，全部由编译器和现有测试兜住。建议单独一个 PR，且不与其他逻辑改动混在一起，便于 review 时用"仅重命名"的假设快速过。

包名迁移建议用 IDE 的 rename package 重构而非文本替换，避免漏改 MyBatis XML 中的全限定名。

验收标准：

1. `./mvnw test` 与 `pnpm test` 全绿。
2. 服务启动后 MyBatis mapper 全部可解析（启动期即暴露，无需额外验证）。
3. 全仓库无 `com.kross` 与 `Kross` 类名残留。

### 阶段三：对外契约（第二层）

范围：HTTP header、Cookie、localStorage key、环境变量、配置根节点。

这一层必须前后端同一次发布，且发布即导致用户登出。执行要点：

1. **先收敛 header 常量，再改名。** 目前 header 名未统一常量化：`ApiHeaders` 只定义了
   `ORGANIZATION_ID`，而 `IdentityFilter:81,85` 的 `x-kross-user-id` / `x-kross-user-name`、
   `ApiExceptionHandler:33,34` 的 `x-kross-organization-id`、`KnowledgeClient:92,112` 的
   `x-kross-knowledge-token` 都是散落的硬编码字符串。建议先把它们全部收敛到 `ApiHeaders`
   作为独立的一次重构（无行为变更），再改取值，可显著降低漏改风险。
2. 环境变量与配置根节点一起改，改完立即更新 compose、Helm values、`ci.yml`、`release-candidate.yml` 与本地 `.env` 样例。
3. 前端侧对应改动在 `frontend/web/src/api/client.ts:382,416`、`frontend/admin-web/src/apiClient.ts:350`
   及 `apiClient.test.ts`（约 10 处断言）。
4. 文档中 `docs/configuration.md`、`docs/security.md`、`docs/cloud-agent-deployment.md` 均记录了 `KROSS_SESSION` 与环境变量，需同步。
5. 发布前需准备一份环境变量对照表交付给已有部署方。

验收标准：

1. 全新环境用新环境变量起服务，登录、会话、组织切换、知识库检索均正常。
2. 旧 Cookie 存在时能正常降级为未登录状态，不出现 500。
3. Worker 能用新 header 完成 agent token 鉴权与 MCP 调用。

### 阶段四：持久化状态（第三层）

范围：容器名前缀、k8s annotation、worker 家目录、数据库名与用户、JuiceFS 命名、k8s namespace 与资源名、label。

这一层是迁移而非改名，建议单独立项，并按"是否有存量部署"分两种路径：

- 无存量部署（当前实际情况）：直接改到目标命名，环境重建即可，成本接近零。
- 有存量部署：需要 dump/restore、PVC 数据搬迁、容器优雅接管方案，成本远高于前三阶段之和。

因此**建议在还没有存量部署的窗口内尽早完成这一层**，否则以后只能长期背着 `kross` 命名。

k8s label 需特别注意：`Deployment.spec.selector` 不可变，改 label 必须删除并重建 Deployment。

验收标准：

1. 全新集群按新命名部署成功，agent 容器可创建、可回收，workspace 可读写。
2. JuiceFS 挂载正常，工作区文件在 Worker 重启后仍可见。
3. `helm template` 与实际 apply 均无残留 `kross` 资源名。

## 待确认事项

1. 命名映射表中标注"待定"的各项取值，尤其是包名、配置前缀、环境变量前缀与 header 命名空间。
2. 是否接受"技术标识中性化"的原则；若坚持技术标识也用产品名（`OPENWORK_*`、`com.openwork`），下次改名仍需重来一轮。
3. 当前是否存在需要保留数据的存量部署，这决定阶段四是重建还是迁移。
4. 阶段二的包名迁移是否单独占用一个发布窗口，避免与功能改动产生大范围冲突。
5. 现有 `main` 分支上 3 个仅存于旧 Kross 仓库的提交如何处置（暂按不动处理）。
