# 发布指南

Kross 的公开 npm 包名是 `@zzc-101/kross`，安装后的命令是 `kross`。当前采用手动确认发布，避免标签或 CI 配置错误直接推送 npm。

## 首次发布前

1. 确认 npm 账号或组织拥有 `@zzc-101` scope。
2. 确认 GitHub Private Vulnerability Reporting 已开启。
3. 确认 `LICENSE` 的授权方式和版权主体符合项目所有者预期。
4. 在受支持平台检查 CI 全绿。

## 发布检查

```bash
npm ci
npm run check
npm audit --omit=dev
git status --short
```

`npm run package:check` 会构建 CLI、执行 `npm pack`、在临时目录安装 tarball，并运行 `kross --version` 与 `kross --help`。发布前工作区必须干净，版本号与 `CHANGELOG.md` 必须一致。

## 创建版本

首次发布 `0.1.0` 前，先把 `CHANGELOG.md` 的 `Unreleased` 内容归档为带日期的 `0.1.0`，提交所有发布准备改动，然后创建首个标签：

```bash
git status --short
npm version 0.1.0 --allow-same-version
git push origin main --follow-tags
```

后续补丁版本使用：

```bash
npm version patch
git push origin main --follow-tags
```

确认标签对应的 GitHub Actions 结果后发布到 npm：

```bash
npm login
npm publish --access public
```

最后创建对应的 GitHub Release，并把 `CHANGELOG.md` 中该版本内容作为发布说明。首次发布前不要创建 `v0.1.0` 标签，以免 changelog 链接指向不存在或错误的提交。
