# Kross

本地优先的终端编程 Agent：理解项目规则、调用工具修改代码、管理长任务，并在真正执行高风险操作前保留你的控制权。

> Kross 正在积极开发中，当前适合本地试用、功能验证和参与开发，尚未发布稳定版本。

## 为什么是 Kross

Kross 不只是一个把提示词转发给模型的聊天界面。它围绕真实开发任务提供完整运行闭环：

- **三种工作模式**：`auto` 直接解决问题，`plan` 先确认计划，`conductor` 拆分任务并交给子代理执行、复核。
- **可验证的完成契约**：代码修改后根据 mutation 与真实工具 trace 检查验证证据；测试失败或未运行时不会伪装成成功。
- **抗空转工具循环**：重复调用无进展时先引导模型恢复策略，仍然停滞则有限退出并报告阻塞。
- **项目规则感知**：自动加载 workspace 根目录中的 `CLAUDE.md`、`AGENTS.md` 和 `KROSS.md`。
- **可扩展 Skills**：发现个人与项目 Skills，只在需要时安全读取正文和资源。
- **安全文件修改**：写入前后记录 mutation journal，支持带冲突保护的 `/undo`。
- **可恢复会话与运行**：消息、上下文、Todo、当前模式、待确认计划和未执行的工具审批可跨重启安全恢复，已完成写操作不会重放。
- **可管理后台进程**：启动、轮询、输入和终止长时间运行的命令，并按会话隔离进程。
- **受控工具调度**：独立只读调用可并发执行，写入、执行、Process 和 MCP 调用保持有序；无进展轮询会自动退避。
- **透明可调试**：通过 `/context`、`/trace` 和 `/diff` 查看上下文、执行轨迹与代码变更。
- **多模型支持**：兼容 OpenAI、Anthropic、OpenRouter、DeepSeek 和 xAI。

## 快速开始

### 环境要求

- Node.js `>= 22.19`
- npm

### 安装并启动

当前公开版本尚未推送到 npm，请先从源码运行：

```bash
git clone https://github.com/zzc-101/Kross.git
cd Kross
npm install
npm run dev
```

仓库中的发布包名为 `@zzc-101/kross`，安装后的命令保持为 `kross`。首个 npm 版本发布后可使用：

```bash
npm install -g @zzc-101/kross
kross
```

没有配置模型时也可以启动 TUI，但无法获得真实的 Agent 回复。首次启动若检测到 Claude Code 或 Codex 配置，可直接在 Kross 中导入：

```text
/import claude
/import codex
/import skip
```

也可以通过环境变量配置模型。例如使用 OpenAI：

```bash
export AGENT_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-5
npm run dev
```

使用 Anthropic：

```bash
export AGENT_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL=claude-sonnet-4-5
npm run dev
```

## 基本使用

启动后直接描述任务即可：

```text
检查当前分支的改动，修复登录流程中的回归，并运行相关测试。
```

需要先审阅计划时：

```text
/mode plan
重构会话持久化模块，保持现有行为不变。
/approve
```

需要拆分复杂任务时：

```text
/mode conductor
梳理前后端认证协议，分别完成修改，最后统一验证。
```

跨目录工作与模式相互独立：

```text
/add-dir ~/work/api
/add-dir ~/work/web
/dirs
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `/mode auto\|plan\|conductor` | 切换 Agent 工作模式 |
| `/approve` / `/reject` | 批准或拒绝待执行计划 |
| `/add-dir <path>` / `/dirs` | 添加或查看 workspace roots |
| `/resume [sessionId]` | 恢复历史会话 |
| `/undo [runId\|transactionId]` | 安全撤销 Agent 文件修改 |
| `/context` / `/compact` | 检查或压缩模型上下文 |
| `/instructions` / `/skills` | 查看已加载的项目规则和 Skills |
| `/trace [runId]` / `/diff` | 检查执行轨迹和代码变更 |
| `/processes` | 查看当前会话管理的后台进程 |
| `/model` / `ctrl+p` | 选择模型和思考强度 |
| `/lang zh\|en` | 切换界面语言 |

## 模型配置

| Provider | `AGENT_LLM_PROVIDER` | API Key | Model |
|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` |
| xAI | `xai` | `XAI_API_KEY` | `XAI_MODEL` |

通过 `/import` 或模型设置保存的配置位于 `~/.kross/config.json`。环境变量优先于配置文件；各 Provider 也支持对应的 `*_BASE_URL`。

## 核心设计

```mermaid
flowchart LR
    U["Terminal User"] --> T["Ink TUI"]
    T --> R["Agent Runtime"]
    R --> C["Context / Sessions / Checkpoints"]
    R --> H["Harness Completion Gate"]
    H --> G["Tool Gateway & Scheduler"]
    R --> M["LLM Providers"]
    G --> F["Files / Git / Search"]
    G --> P["Processes / MCP / Subagents"]
```

仓库采用 TypeScript monorepo：

- `packages/core`：Agent runtime、Harness 完成门、上下文治理、会话、工具、权限、Skills、MCP 与模型适配。
- `packages/tui`：基于 Ink 的交互式终端界面。
- `docs`：用户指南、技术概览、Harness 说明和发布文档。

## 文档

- [文档导航](docs/README.md)
- [快速上手](docs/getting-started.md)
- [配置参考](docs/configuration.md)
- [命令手册](docs/command-reference.md)
- [安全模型](docs/security.md)
- [故障排查](docs/troubleshooting.md)
- [技术概览](docs/technical-overview.md)
- [Agent Harness](docs/harness.md)
- [Harness 优化路线图](docs/harness-roadmap.md)
- [发布指南](docs/releasing.md)
- [参与贡献](CONTRIBUTING.md)
- [漏洞报告](SECURITY.md)

## 安全边界

- 默认只自动允许读操作；写入、执行和网络操作需要审批。
- 文件工具使用真实路径校验，限制在已授权 workspace 内。
- `/undo` 会验证当前文件 hash，检测到人工后续修改时拒绝覆盖。
- `Bash` 和后台进程工具目前**不是 OS 级沙箱**。批准命令前仍应确认其影响范围。
- Skills 中的脚本不会自动执行；执行仍需经过工具审批。

## 开发与验证

```bash
npm run dev
npm test -- --run
npm run typecheck
npm run build
npm run package:check
```

`npm run package:check` 会打包并在临时目录真实安装 CLI，然后验证 `kross --help` 和 `kross --version`。

当前主要待补能力包括 OS 级执行沙箱、MCP resources/prompts 与 HTTP transport、跨会话语义记忆，以及嵌套目录级 Project Instructions。
