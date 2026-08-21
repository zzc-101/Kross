# 配置参考

本分支是自托管 Cloud Agent。模型、身份和对话在 Java 控制面；Agent 读写的文件在
Worker 容器的 `/work`。`main` 上的本地 TUI 仍使用 `~/.kross`；不要把那套路径
当成本分支的用户配置入口。

安装与基础设施变量见 [Cloud Agent 部署与运维](cloud-agent-deployment.md)。

## 组织模型

组织管理员在管理中心登记模型档案：显示名、Provider、模型 ID、API Key、可选
Base URL。密钥用 `KROSS_CREDENTIAL_MASTER_KEY` 加密后入库，接口不回显明文。
Worker 领取任务时，控制面把当前可用模型下发为进程环境变量。会话只保存模型配置
引用，不复制 API Key。

未配置可用模型时，工作台可以打开，但 Worker 无法产生真实回复。

## Provider 环境变量

开发或冒烟仍可用环境变量注入（Compose / `.env` 传入控制面后，再随 Worker 下发）。
生产请优先用管理中心档案。

| Provider | 值 | 密钥 | 模型 | Base URL |
|---|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` | `OPENAI_BASE_URL` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_MODEL` | `ANTHROPIC_BASE_URL` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | `OPENROUTER_BASE_URL` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `DEEPSEEK_BASE_URL` |
| xAI | `xai` | `XAI_API_KEY` | `XAI_MODEL` | `XAI_BASE_URL` |

```bash
export AGENT_LLM_PROVIDER=openrouter
export OPENROUTER_API_KEY=...
export OPENROUTER_MODEL=anthropic/claude-sonnet-4
```

`AGENT_LLM_MODEL` 可作为各 Provider 模型字段的通用回退值。兼容 OpenAI / Anthropic
协议的自建端点，改对应 `*_BASE_URL` 即可；端点必须支持流式输出和工具调用，否则
无法跑完整 Agent 循环。

## Worker 行为变量

这些变量作用于 Agent 容器进程，不控制 Web 界面语言。

| 变量 | 作用 |
|---|---|
| `AGENT_LLM_BACKEND=native` | 强制使用 Kross 内置 HTTP 协议客户端 |
| `AGENT_THINKING_EFFORT` | `off\|minimal\|low\|medium\|high\|xhigh` |
| `KROSS_THINKING_EFFORT` | 思考强度兼容别名 |
| `AGENT_CONTEXT_WINDOW` | 覆盖模型上下文窗口 token 数 |
| `KROSS_CONTEXT_WINDOW` | 上下文窗口兼容别名 |
| `AGENT_MAX_TOOL_ITERATIONS` | 覆盖默认工具循环上限 200 |

Anthropic 还支持 `ANTHROPIC_VERSION`。

## 工作区文件

Worker 的工作目录是 `/work`（本机 Docker volume 或 JuiceFS 上的
`agents/{agentId}`）。刷新浏览器不会丢对话：对话在 PostgreSQL。克隆仓库、改代码
都发生在 `/work`。

### Project Instructions

`/work` 根目录可放置：

```text
CLAUDE.md
AGENTS.md
KROSS.md
```

同一目录中后者优先级更高。适合记录构建测试命令、目录职责和禁止修改的生成文件。
当前只扫描工作区根顶层，不递归子目录。

### Skills

随工作区一起保留的项目 Skill：

```text
/work/.agents/skills/<id>/SKILL.md
```

Runtime 还会读取容器 `$HOME/.kross/skills`（Cloud Worker 里是 `/home/node/.kross`）。
该目录不在 `/work` 卷上，容器重建或换节点后可能丢失。长期使用的 Skill 请放在
工作区 `.agents/skills`。

### MCP

stdio 或 Streamable HTTP MCP 仍从容器 `$HOME/.kross/mcp.json`（或同目录
`config.json` 的 `mcpServers`）加载，合并规则与 Core 一致：同名 server 以
`config.json` 为准。远程 token 只通过环境变量名引用；除 localhost 外必须 HTTPS。

Cloud 上这份配置同样不随 `/work` 持久化。需要长期 MCP 时，把 server 定义放进
工作区文档，并在容器起来后写入 `$HOME/.kross`，或接受重建后重新配置。

```json
{
  "mcpServers": {
    "remote": {
      "transport": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "authorization": {
        "type": "bearer-env",
        "env": "MCP_REMOTE_TOKEN"
      }
    }
  }
}
```

`risk` 可为 `read`、`write`、`execute` 或 `network`。远程 MCP 默认按 `network`
审批。Resources / Prompts 不会静默进入模型上下文，需用户或 Agent 显式拉取。
修改配置后需要 Worker 重新加载 MCP 连接。

## 数据落在哪里

| 数据 | 位置 |
|---|---|
| 账号、SSO、组织模型、对话 `parts` | 控制面 PostgreSQL |
| 工作区文件、项目 Skills、仓库 | `/work`（volume 或 JuiceFS） |
| 产物对象 | MinIO / S3 |
| mutation journal、trace、个人 Skills、MCP | Worker `$HOME/.kross`，默认不随工作区卷备份 |

子代理 `Task` 若指定 `modelProfileId`，只在 Worker 进程内已加载的模型档案中解析；
Cloud 默认下发的是当前组织模型环境，未指定时子代理继承主模型。
