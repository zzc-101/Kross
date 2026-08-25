# 发布指南

Kross 发布 SaaS Work Agent 镜像候选。当前采用人工确认发布：CI 验证代码
与容器 smoke，但不会自动创建标签或推送镜像。首次公开发布前仍需由项目所有者
确认 License、镜像仓库和 GitHub 权限。`worker/core` 当前保持为 Worker 内部源码，
不发布 npm 包。

仓库中的 `release-candidate.yml` 只生成候选产物，没有 `contents: write`、
`packages: write` 或镜像推送权限。它不会创建 GitHub Release 或推送容器镜像。

## 版本契约

Kross 使用一个应用版本：

- `frontend/package.json`、`frontend/web`、`frontend/admin-web`、`worker/package.json` 必须同版本，并各自提交 pnpm lockfile。
- Worker 内 MCP 客户端的运行时兜底版本必须与应用版本一致。
- Web、控制面、Worker、Node 镜像应使用同一应用标签。
- Protocol、checkpoint 和持久化 schema 有独立版本，不能因为应用版本变化而
  自动递增；只有格式发生不兼容变化时才升级并提供迁移策略。

`node scripts/check-version-consistency.mjs` 会自动校验上述可静态检查的约束、
Node.js 最低版本和 `CHANGELOG.md` 基本结构。

## 首次发布前

1. 确认 GitHub Private Vulnerability Reporting 已开启。
2. 确认 `LICENSE` 的授权方式和版权主体符合项目所有者预期。
3. 按[支持范围](support.md)在受支持平台确认 CI 全绿。
4. 明确容器镜像仓库、命名规则和保留策略；在此之前不发布 Cloud 镜像。

## 准备版本

不要只改其中一个清单的版本号：`frontend` 与 `worker` 必须保持同一应用版本。

准备新版本时：

1. 更新 `frontend/package.json`、`frontend/web`、`frontend/admin-web` 和
   `worker/package.json` 的 `version`。
2. 分别在 `frontend/` 和 `worker/` 运行 `pnpm install --lockfile-only`
   更新 lockfile。
3. 把 `CHANGELOG.md` 的 `Unreleased` 内容归档到
   `## [x.y.z] - YYYY-MM-DD`，并补充版本比较链接。
4. 更新文档中的兼容性、升级步骤和破坏性变化说明。

在创建标签前执行：

```bash
cd frontend && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
cd ../worker && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
cd ../backend && ./mvnw -B -DskipTests compile
cd ../node && go build -o /tmp/kross-node .
node scripts/check-version-consistency.mjs
node scripts/check-doc-links.mjs
pnpm --dir frontend audit --prod
pnpm --dir worker audit --prod
node scripts/check-version-consistency.mjs --tag "v0.1.0" --release
git diff --check
git status --short
```

将示例标签替换为当前版本。`--release` 会额外要求 changelog 中存在当前版本的
日期标题和链接。

## 创建标签与发布

提交所有发布准备改动，确认工作区干净，再创建带注释标签：

```bash
git tag -a v0.1.0 -m "Kross v0.1.0"
git push origin HEAD
git push origin v0.1.0
```

推送 `v*` 标签会触发 Release Candidate Workflow。也可以在 Actions 页面手动
输入一个已经存在的标签重新验证。Workflow 会：

1. checkout 指定标签并验证 tag、package version 和 changelog；
2. 分别在 frontend、worker、backend、node 跑检查；
3. 使用应用版本和 12 位 commit SHA 分别标记 Web、Server、Worker、Node 本地镜像；
4. 运行 Cloud 容器 smoke；
5. 上传保留 14 天的候选 artifact，其中包含容器镜像元数据、
   `release-metadata.json` 和 `SHA256SUMS`。

候选 metadata 中的 publication 标志固定为 `false`，用来明确区分“已验证”
和“已发布”。正式自动发布仍要等待 License、镜像仓库和受保护 Environment 决策。

最后创建对应的 GitHub Release，并使用 `CHANGELOG.md` 的版本内容作为发布说明。
若任何发布步骤失败，不要复用已公开的版本号；修复后递增补丁版本。

## 安装、升级与回滚验收

Cloud 发布需要分别验证 Web、控制面、Worker（以及集群时的 `kross-node`）使用同一标签，执行
[Cloud Agent 部署与运维](cloud-agent-deployment.md)，并保留上一版本镜像。
数据卷不应随容器回滚自动删除。

三个 `kross-*:ci` 镜像构建完成后可运行：

```bash
./scripts/cloud-container-smoke.sh
```

该命令会创建临时网络和容器，验证 Worker health、控制面 health 与鉴权接口、
Web 静态入口和 Nginx 反向代理；成功或失败后都会清理本次创建的资源。失败时
脚本输出容器日志。
