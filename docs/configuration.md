# 配置参考

Kross 默认把用户配置和运行数据放在 `~/.kross`。

## 配置优先级

模型配置按以下顺序解析：

1. 完整的 Provider 环境变量。
2. `~/.kross/config.json` 中保存的配置。
3. 未配置模型时以占位 Runtime 启动 TUI。

环境变量可以逐字段覆盖同 Provider 的已保存配置。不完整的环境变量不会自动抹掉已导入的密钥。

## Provider 环境变量

| Provider | 值 | 密钥 | 模型 | Base URL |
|---|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` | `OPENAI_BASE_URL` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_MODEL` | `ANTHROPIC_BASE_URL` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | `OPENROUTER_BASE_URL` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `DEEPSEEK_BASE_URL` |
| xAI | `xai` | `XAI_API_KEY` | `XAI_MODEL` | `XAI_BASE_URL` |

先设置 Provider：

```bash
export AGENT_LLM_PROVIDER=openrouter
export OPENROUTER_API_KEY=...
export OPENROUTER_MODEL=anthropic/claude-sonnet-4
```

`AGENT_LLM_MODEL` 可作为各 Provider 模型字段的通用回退值。

## 通用环境变量

| 变量 | 作用 |
|---|---|
| `AGENT_LLM_BACKEND=native` | 强制使用 Kross 内置 HTTP 协议客户端 |
| `AGENT_THINKING_EFFORT` | 设置 `off|minimal|low|medium|high|xhigh` |
| `KROSS_THINKING_EFFORT` | 思考强度兼容别名 |
| `AGENT_CONTEXT_WINDOW` | 覆盖模型上下文窗口 token 数 |
| `KROSS_CONTEXT_WINDOW` | 上下文窗口兼容别名 |
| `AGENT_MAX_TOOL_ITERATIONS` | 覆盖默认工具循环上限 200 |
| `AGENT_LANG` / `KROSS_LANG` | 设置 `zh` 或 `en` 界面语言 |

Anthropic 还支持 `ANTHROPIC_VERSION`。

## `config.json`

示例：

```json
{
  "locale": "zh",
  "llm": {
    "provider": "openai",
    "apiKey": "sk-...",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5",
    "thinkingEffort": "medium",
    "contextWindow": 256000
  },
  "context": {
    "preserveRecentTokens": 20000,
    "preserveFullTurns": 4,
    "compactionInstructions": "保留精确文件路径、命令、错误文本和未完成事项"
  }
}
```

`/import`、`/model`、模型设置面板和 `/lang` 会更新此文件。文件中可能包含明文 API key，请限制访问权限，不要提交到仓库或分享到问题报告中。

## 独立摘要模型

上下文压缩默认复用主模型。需要独立模型时：

```json
{
  "context": {
    "summarizer": {
      "provider": "openai",
      "apiKey": "sk-...",
      "model": "gpt-5-mini"
    }
  }
}
```

## MCP

stdio MCP server 可放在 `~/.kross/mcp.json`，也可写入 `config.json` 的 `mcpServers`。同名 server 以 `config.json` 为准。

```json
{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": {},
      "cwd": "/optional/working/directory",
      "risk": "network",
      "connectTimeoutMs": 12000,
      "disabled": false
    }
  }
}
```

`risk` 可为 `read`、`write`、`execute` 或 `network`。未覆盖时优先参考 MCP tool annotations，否则按 `network` 处理。当前需要重启 Kross 才能重新加载 MCP 列表。

## 多仓项目模板

`~/.kross/projects.json` 可定义跨仓项目：

```json
{
  "defaultProjectId": "my-app",
  "projects": {
    "my-app": {
      "repos": [
        {
          "id": "api",
          "path": "/Users/me/work/api",
          "type": "backend",
          "testCommand": "npm test"
        },
        {
          "id": "web",
          "path": "/Users/me/work/web",
          "type": "frontend"
        }
      ]
    }
  }
}
```

workspace 还可通过 `<workspace>/.kross/project.json` 提供覆盖配置。

## Project Instructions

每个已授权 root 的根目录可放置：

```text
CLAUDE.md
AGENTS.md
KROSS.md
```

同一 root 内后者优先级更高。当前版本只扫描 root 顶层，不递归加载嵌套目录规则。使用 `/instructions` 查看来源和诊断。

## Skills

- 个人 Skill：`~/.kross/skills/<id>/SKILL.md`
- 项目 Skill：`<workspace>/.agents/skills/<id>/SKILL.md`

Skill metadata 自动进入上下文，正文通过 `ReadSkill` 按需加载。使用 `/skills` 查看发现结果。

## 运行数据目录

| 路径 | 内容 |
|---|---|
| `~/.kross/sessions` | append-only 会话 JSONL |
| `~/.kross/session-store.db` | 最近会话索引，可由 JSONL 重建 |
| `~/.kross/traces` | 运行 trace JSONL 与索引 |
| `~/.kross/mutations` | mutation journal 与 content-addressed blobs |
| `~/.kross/skills` | 个人 Skills |
