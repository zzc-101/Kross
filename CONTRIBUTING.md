# 参与贡献

感谢参与 Kross。提交改动前请先确认它与本地优先、可审计、用户可控的 Agent 方向一致。

## 开发环境

需要 Node.js `>= 22.19` 和 npm：

```bash
git clone https://github.com/zzc-101/Kross.git
cd Kross
npm ci
npm run dev
```

## 提交前验证

```bash
npm run typecheck
npm test -- --run
npm run package:check
```

- 新行为应补充对应测试。
- 修改用户可见命令、配置或安全边界时同步更新 `README.md` 与 `docs/`。
- 不要提交 API key、`~/.kross` 数据、trace、会话文件或构建产物。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告，不要公开创建 PoC Issue。

## Pull Request

PR 描述应说明问题、实现方式、验证结果和已知限制。尽量保持单一目标，避免夹带无关格式化或生成文件。
