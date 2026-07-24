# Kross 文档

这里保留当前用户与贡献者需要维护的文档。已经完成的开发计划、阶段性评审和历史
路线图通过 Git 历史追溯，不继续作为现行说明。

## 用户指南

| 目标 | 文档 |
|---|---|
| 第一次安装和运行 | [快速上手](getting-started.md) |
| 配置模型、上下文、MCP 或多仓项目 | [配置参考](configuration.md) |
| 查询斜杠命令和快捷键 | [命令手册](command-reference.md) |
| 了解审批、文件边界和数据风险 | [安全模型](security.md) |
| 排查启动、模型、撤销或 MCP 问题 | [故障排查](troubleshooting.md) |
| 部署和维护 Cloud Agent | [Cloud Agent 部署与运维](cloud-agent-deployment.md) |

## 扩展与贡献

| 目标 | 文档 |
|---|---|
| 理解包边界、Runtime、上下文与 Cloud 数据流 | [技术概览](technical-overview.md) |
| 理解完成门、验证、恢复与工具调度 | [Agent Harness](harness.md) |
| 添加 Skills、MCP、工具、模型或客户端 | [扩展 Kross](extensions.md) |
| 检查 npm 包并准备版本发布 | [发布指南](releasing.md) |

## 维护约定

- 用户可见行为、命令和配置变化必须同步对应指南。
- 技术文档只描述当前实现，不在正文累计完成状态和开发日志。
- 尚未实施的想法优先放在 GitHub Issue，而不是创建长期失真的路线图文档。
- 扩展能力以[扩展 Kross](extensions.md)标注的稳定级别为准；导出的内部类型不自动
  等于稳定 SDK。
- `npm run docs:check` 会验证根目录和 `docs/` 中的本地 Markdown 链接。
