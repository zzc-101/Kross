# 发布指南

Kross 的公开 npm 包名是 `@zzc-101/kross`，安装后的命令是 `kross`。当前采用
人工确认发布：CI 验证代码与安装产物，但不会自动创建标签、推送镜像或发布 npm
包。首次公开发布前仍需由项目所有者确认 License、npm scope 和 GitHub 权限。

仓库中的 `release-candidate.yml` 只生成候选产物，没有 `contents: write`、
`packages: write` 或 npm 发布权限。它不会创建 GitHub Release、推送容器镜像或
执行 `npm publish`。

## 版本契约

Kross 使用一个应用版本：

- 根 `package.json`、所有 `packages/*/package.json` 和 lockfile 必须同版本。
- workspace 之间使用精确的内部依赖版本，不使用 `workspace:*` 或浮动范围。
- CLI 显示版本和 MCP 客户端默认版本必须与应用版本一致。
- 未来发布的 Web、Gateway、Worker 镜像应使用同一应用标签。
- Protocol、checkpoint 和持久化 schema 有独立版本，不能因为应用版本变化而
  自动递增；只有格式发生不兼容变化时才升级并提供迁移策略。

`npm run version:check` 会自动校验上述可静态检查的约束、Node.js 最低版本和
`CHANGELOG.md` 基本结构。

## 首次发布前

1. 确认 npm 账号或组织拥有 `@zzc-101` scope。
2. 确认 GitHub Private Vulnerability Reporting 已开启。
3. 确认 `LICENSE` 的授权方式和版权主体符合项目所有者预期。
4. 按[支持范围](support.md)在受支持平台确认 CI 全绿。
5. 明确容器镜像仓库、命名规则和保留策略；在此之前不发布 Cloud 镜像。

## 准备版本

不要直接运行 `npm version patch`：npm workspace 不会替项目同步所有内部精确
依赖，容易让根包、workspace 和 lockfile 产生漂移。

准备新版本时：

1. 更新根包和全部 workspace 的 `version`。
2. 把 `@kross/*` 内部依赖更新为同一个精确版本。
3. 运行 `npm install --package-lock-only` 更新 lockfile。
4. 把 `CHANGELOG.md` 的 `Unreleased` 内容归档到
   `## [x.y.z] - YYYY-MM-DD`，并补充版本比较链接。
5. 更新文档中的兼容性、升级步骤和破坏性变化说明。

在创建标签前执行：

```bash
npm ci
npm run check
npm audit --omit=dev
npm run version:check -- --tag "v0.1.0" --release
git diff --check
git status --short
```

将示例标签替换为当前版本。`--release` 会额外要求 changelog 中存在当前版本的
日期标题和链接。`npm run package:check` 会构建 CLI、执行 `npm pack`、在临时
目录安装 tarball，并运行 `kross --version` 与 `kross --help`。

## 创建标签与发布

提交所有发布准备改动，确认工作区干净，再创建带注释标签：

```bash
git tag -a v0.1.0 -m "Kross v0.1.0"
git push origin main
git push origin v0.1.0
```

确认标签对应的 GitHub Actions 通过后，检查将要发布的文件并手动发布：

```bash
npm pack --dry-run
npm login
npm publish --access public
```

推送 `v*` 标签会触发 Release Candidate Workflow。也可以在 Actions 页面手动
输入一个已经存在的标签重新验证。Workflow 会：

1. checkout 指定标签并验证 tag、package version 和 changelog；
2. 运行完整 `npm run check`；
3. 生成 npm tarball；
4. 使用应用版本和 12 位 commit SHA 分别标记 Web、Gateway、Worker 本地镜像；
5. 运行 Cloud 容器 smoke；
6. 上传保留 14 天的候选 artifact，其中包含 tarball、容器镜像元数据、
   `release-metadata.json` 和 `SHA256SUMS`。

候选 metadata 中的三个 publication 标志固定为 `false`，用来明确区分“已验证”
和“已发布”。正式自动发布仍要等待 License、npm scope、镜像仓库和受保护
Environment 决策。

最后创建对应的 GitHub Release，并使用 `CHANGELOG.md` 的版本内容作为发布说明。
若任何发布步骤失败，不要复用已公开的版本号；修复后递增补丁版本。

## 安装、升级与回滚验收

在一个不包含源码仓库的临时目录中验证：

```bash
npm install --global @zzc-101/kross@0.1.0
kross --version
kross --help
npm install --global @zzc-101/kross@0.1.1
kross --version
npm install --global @zzc-101/kross@0.1.0
kross --version
npm uninstall --global @zzc-101/kross
```

将示例版本替换为真实的当前版本和相邻版本。升级、降级或卸载 CLI 都不会自动
删除 `~/.kross`；这样可以避免误删配置、会话和凭据。若版本引入存储迁移，必须
先验证旧数据升级，并在 changelog 中说明能否回滚。

Cloud 发布还需要分别验证 Web、Gateway、Worker 使用同一标签，执行
[部署验收清单](cloud-agent-deployment.md#部署验收清单)，并保留上一版本镜像。
数据卷不应随容器回滚自动删除。

三个 `kross-*:ci` 镜像构建完成后可运行：

```bash
npm run cloud:smoke
```

该命令会创建临时网络和容器，验证 Worker health、Gateway health 与鉴权接口、
Web 静态入口和 Nginx 到 Gateway 的反向代理；成功或失败后都会清理本次创建的
资源。失败时脚本输出三个容器日志。
