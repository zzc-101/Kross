# Kross

一个本地优先的交互式 agent runtime。第一阶段目标是先具备普通 agent 的基础能力，再把跨仓库协作作为独立模式接入。

## 当前能力

- 交互式 TUI 入口，启动后像 Claude Code 一样输入自然语言任务。
- 全屏 TUI 为 Ink 预留安全行，避免高频更新触发整屏 `clearTerminal`；触摸板滚动采用单层帧合并，消息视口复用稳定 paint layout，流式文本按帧批量更新。
- `auto` / `normal` / `cross-repo` 三种模式。
- 普通模式具备最小运行闭环：解析目标、生成计划、记录 trace、返回报告。
- 跨仓库模式已经具备入口和确认门：检测到前后端/管理端/跨系统联动后，在执行前暂停等待确认，可通过 `/approve` 继续或 `/reject` 取消。
- JSONL trace store，用于后续任务回放和 agent 迭代分析。
- 工作区级会话持久化：完整可见消息以 append-only JSONL 保存，SQLite 仅维护可重建的最近会话索引；启动页可选择历史会话，`/resume` 打开选择器，`/resume <sessionId>` 直接恢复。
- TUI 界面 i18n：默认中文，支持 `/lang en|zh` 与 `AGENT_LANG` / `KROSS_LANG` / `config.locale` 切换英文。
- SessionContext：以 ConversationThread 为单一事实源，把 system prompt、对话线程、上下文源、工具清单、技能 metadata 组装为 LLM messages；token 预算制（启发式估算 + usage EMA 校准），按优先级与预算选择 sources（支持 pinned 固定注入）。
- Tool Gateway：统一注册工具、暴露工具 metadata、校验工具入参、阻断高风险工具的未授权调用，并把工具调用事件写入 trace。
- 内置工具集：文件读写、目录与元信息查询、Git 状态/差异/历史、文本检索、Bash，**Task（子代理）**，以及 **TodoWrite/TodoRead（会话任务清单）** 均已接入 Tool Gateway，支持原生 tool-call loop、审批恢复和 trace 记录。
- 首次配置导入：首次进入 TUI 时，如果本机检测到 Claude Code 或 Codex 配置，会提示通过 `/import claude`、`/import codex` 或 `/import skip` 导入/跳过；导入后保存到 `~/.kross/config.json`。

## 上下文系统

Kross 的上下文以 **ConversationThread** 为单一事实源：会话内所有消息（用户输入、assistant 回复、tool_calls、工具结果、压缩摘要）统一活在 Thread 里，工具循环每轮从 Thread 取、向 Thread 写。会话存储会同时保存 UI 记录和治理后的 Thread 检查点；恢复时优先还原真实模型上下文，旧会话才从 user/assistant 记录兼容重建。

已实现：

- **统一消息流（Thread）**：轮次生命周期 `beginTurn` → append → `commitTurn` / `abortTurn`；进程内审批挂起时 open-turn 留在 Thread 上，批准后继续 append。
- **Token 预算制**：输入预算 = `contextWindow - 输出预留`（默认 256K 窗口、32K 预留）；压缩阈值 = 输入预算的 80%。顶栏与 `/context` 显示校准后的「下次请求预估 token / 输入预算」（`snapshot()` 纯读，无副作用）。
- **三级治理流水线**（请求前 `prepareRequest` + 手动 `/compact` Stage2）：
  - Stage1 工具结果老化：超配额或距今超过 N 轮时替换为省略占位，保留 tool 消息本体。
  - Stage2 滚动压缩：旧历史原位替换为唯一摘要，二次压缩吸收旧摘要；按 token 保留最近原文，超长单轮仅在安全 assistant 边界切分。
  - Stage3 硬截断：单条超大消息 head+tail 截断兜底。
- **上下文源**：workspace、repo、trace、memory、user、skill、compaction；`pinned` 源（如 session-todos）固定注入，不因预算被静默 drop。
- **工具清单 / 技能清单**：工具 metadata 与技能名称/描述/位置进入 system 段；技能正文仅在触发时加载。
- **纯读快照**：`inspectContext` / `snapshot()` 产出 section 占用、contributors、included/dropped/pinned sources、estimatedTokens、inputBudget、compactThreshold。
- **`/context`**：按 token 展示总预估/预算/阈值、各 section（system/thread/sources/skills/tools）、sources 状态、最近治理记录。
- **`/compact [额外要求]`**：手动触发一次 Stage2 滚动压缩，可临时要求保留文件名、精确值等信息。
- **压缩可配置**：支持默认压缩指令和独立摘要模型；未配置时复用当前模型，失败自动回退到高保真 extractive 摘要。
- **可恢复检查点**：JSONL 持久化完整 Thread；重启时恢复摘要、tool 状态和消息顺序，未完成 open turn 安全转为 aborted。
- **治理可感知**：自动治理时写入 `context.compacted` trace，TUI 消息流插入简短 system 提示。
- **`/trace` / `/diff`**：不变。

尚未实现：

- embedding/FTS 语义检索和跨 session memory 检索。
- 子代理之间的共享 context store。
- tokenizer 库精确计数（当前启发式 + EMA 校准）。

## 工具调用系统

Kross 的 Tool Gateway 负责把模型可见的工具能力和本地真实执行隔离开。

已实现：

- 工具注册：每个工具声明名称、描述、风险等级、可选分类和输入 JSON Schema。
- 条件启用：工具可以按当前模式等上下文动态出现在 planner prompt 中，例如只在 `cross-repo` 模式暴露跨仓库扫描工具。
- 入参校验：执行前用 zod schema 校验模型/调用方给出的输入。
- 审批策略：默认只自动允许 `read` 工具，`write`、`execute`、`network` 会要求显式批准；也支持自定义 allow/ask/deny 策略并记录拒绝原因。
- 选项式确认：当模型请求高风险工具时，TUI 会暂停当前运行并显示 Approve / Reject 选项，用户可用方向键切换、Enter 确认，也可按 `a`/`r`。
- 超时控制：支持 gateway 默认超时和单工具超时。
- 错误 observation：工具失败时可选择抛错，也可把失败作为结构化结果返回给 agent loop，方便模型换方案。
- 结果摘要：保留原始输出，同时生成 summary 写入 trace 和上下文，避免大输出污染后续 prompt。
- Trace：记录 `tool_call.started`、`tool_call.completed`、`tool_call.failed`、`tool_call.approval_required`、`tool_call.denied`。
- 原生 tool-call loop：OpenAI-compatible 解析 `tool_calls`，Anthropic-compatible 解析 `tool_use`，Runtime 执行工具后把 tool result 回填给模型，支持多轮工具迭代直到模型返回最终文本。
- 内置文件工具：`Read`、`Write`、`Edit`、`Delete`、`Move`、`Glob`、`Grep`、`Rg`、`List`、`Stat` 默认限制在 workspace 内，并使用真实路径校验阻断 symlink 越界。`Rg` 基于系统 ripgrep，优先用于内容搜索与文件枚举；`Grep`/`Glob` 为纯 JS 回退。`Edit` 支持 `edits[]` 一次多处替换与失败时附近内容提示。
- 内置 Git 工具：`GitStatus`、`GitDiff`、`GitLog` 提供只读的结构化仓库检查，并拒绝读取仓库根目录位于 workspace 外的 Git 仓库。
- `Read` 支持 `offset` / `limit` 分段读取大文件，避免先把超大文件完整塞进上下文。
- `Bash` 会以 workspace 内目录作为 cwd 启动命令，但当前版本没有 OS 级沙箱；命令本身的系统访问能力主要由审批策略约束。
- 工具调用循环默认最多 **200 轮**（一轮 = 模型 tool_calls → 执行 → 回填），作死循环安全网，不是“正常任务配额”。触顶时 **软着陆**：丢弃未执行 tool_calls、强制一轮无工具文本总结（`completed`），并记录 `llm.tool_loop.max_iterations` + `llm.soft_land.completed`；可用 `AGENT_MAX_TOOL_ITERATIONS` 覆盖。
  - 对照：OpenCode 默认不限步，可选 `steps`，触顶要求 summarize；实现层约 1000 步硬保险。Codex 基本不按步数掐断。Claude Code 会话可跑大量工具调用，另有产品侧单 turn 工具次数限制。

已实现（Todo list）：

- **`TodoWrite` / `TodoRead`**：会话级任务清单（pending / in_progress / completed / cancelled）。
- 默认按 id **merge**；`merge: false` 整表替换。
- 每轮请求前注入 context source `session-todos`，模型可持续看到进度。
- **TUI 顶栏右上**：原权限芯片改为 `Todo done/total ▸/▾`；**点击展开**查看全部 todo（完成项 `✓` 打勾），再点收起。权限仍在 Composer 页脚（shift+tab）。
- 内存态（进程内）；不跨重启持久化。

已实现（Subagent P0）：

- **`Task` 工具**：主 agent 可派生子代理执行聚焦任务。
- **专用执行路径**（不走主 `AgentRuntime.run` 规划器壳）：独立 system prompt + 独立工具环。
- **工具白名单**：Read / Glob / Grep / Rg / List / Stat / Git* / Edit / Write（无 Bash/Delete/Move/Task/MCP）。
- **子代理内 auto-allow**；**maxDepth=1**。
- Trace：lifecycle 在父 run；子工具事件带 **`isSubagent: true`**，主 transcript 硬过滤。
- **TUI**：对话区下单行 `▸ Subagent …`（点击展开）；完成态约保留 60s。

已实现（MCP）：

- stdio MCP：从 `~/.kross/mcp.json` 或 `~/.kross/config.json` 的 `mcpServers` 启动外部 server。
- 启动时 `tools/list`，注册为 Gateway 工具，命名 `serverId__toolName`（描述带 `[MCP:serverId]` 前缀）。
- 调用走现有审批 / 超时 / trace；默认 risk 为 `network`（需确认），可用 tool annotations 的 `readOnlyHint` 降为 `read`，或在 server 配置里写 `risk`。
- 单 server 失败不阻断启动（stderr 打印 `[kross:mcp] ...`）。

```json
// ~/.kross/mcp.json
{
  "mcpServers": {
    "mock": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": {},
      "disabled": false
    }
  }
}
```

尚未实现：

- MCP resources / prompts、SSE/HTTP transport、运行时热重载 MCP 列表。
- OS 级 Bash 沙箱。
- `apply_patch` 专用内置工具。


### 权限和安全边界

Kross 当前默认学习 Claude Code 的交互体验：沙箱不是默认前提，高风险动作通过权限模式和用户确认控制。

- `default` 权限模式下，读类工具默认允许，写入、执行、网络类工具需要确认。
- `classifier` / `auto` 权限模式可用于更激进的自动化场景，但仍会保留 deny 规则。
- 文件类工具会做 workspace 边界校验；`Bash` 不是完整沙箱，批准命令前仍需要确认命令意图。
- 如果后续接入 OS 级沙箱，建议作为可选配置能力接入，不改变当前默认体验。

## 运行

```bash
npm install
npm run dev
```

默认不配置模型也能启动 TUI，会使用本地占位 planner。配置模型后，runtime 会在规划阶段调用 LLM，并把调用结果写入 trace。

### 运行时要求

- Node.js **>= 22.19**（`@earendil-works/pi-ai` 要求；仓库根目录有 `.nvmrc`）。

### 配置优先级

模型配置优先级如下：

1. 环境变量：`AGENT_LLM_PROVIDER` + 对应的 `OPENAI_*` 或 `ANTHROPIC_*`。
2. Kross 配置：`~/.kross/config.json`，可由首次启动的 `/import` 命令生成。
3. 未配置：TUI 仍可启动，但普通 agent 回复会提示缺少模型配置。

协议层默认走 **`@earendil-works/pi-ai`**（`PiAiLlmClient`），保留 Kross 内部 `LlmClient` 接口不变。  
可用 `AGENT_LLM_BACKEND=native` 强制回退到自研 HTTP 客户端（测试注入 `fetch` 时也会自动走 native）。

#### 支持的 provider

| `AGENT_LLM_PROVIDER` | 密钥 | 模型 | 默认 baseUrl |
|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` | `https://api.openai.com/v1` |
| `anthropic` | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_MODEL` | `https://api.anthropic.com` |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | `https://openrouter.ai/api/v1` |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `https://api.deepseek.com` |
| `xai` | `XAI_API_KEY` | `XAI_MODEL` | `https://api.x.ai/v1` |

通用：`AGENT_LLM_MODEL` 可作为模型回退；各 provider 还支持 `*_BASE_URL` 覆盖。

TUI 命令：

- **`ctrl+p` / `/settings` / 单独 `/model`**：打开模型与思考强度面板  
- `/resume` — 打开最近会话选择（↑↓ 选中后 Enter 恢复）；`/resume <sessionId>` 直接恢复指定会话
- `/lang zh|en` — 切换界面语言（写入 `~/.kross/config.json` 的 `locale`）
- `/model list` — 列出 provider  
- `/model <modelId>` / `/model <provider> <model>` — 切模型  
- `/model off|minimal|low|medium|high|xhigh|cycle` — 切思考强度  
- 右下角：`model (effort)`，例如 `claude-sonnet-4-5 (medium)`  

模型配置优先序：完整 `AGENT_LLM_*` 环境变量 → `~/.kross/config.json`（`/import`）。  
不完整的 env **不会**覆盖或挡住已导入的配置；写盘时若会导致丢失密钥会拒绝写入。

界面语言优先序：`AGENT_LANG` / `KROSS_LANG` → `~/.kross/config.json` 的 `locale` → 系统 `LANG` → 默认 `zh`。

上下文窗口默认统一为 `256000` token，不再按模型名推断。可在
`~/.kross/config.json` 的 `llm.contextWindow` 中覆盖：

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-5",
    "contextWindow": 512000
  }
}
```

`AGENT_CONTEXT_WINDOW`（兼容 `KROSS_CONTEXT_WINDOW`）优先于配置文件。
顶栏已用 token 采用模型接口最近一次响应返回的 `usage.inputTokens`，接口未返回
usage 时显示为 `0`，不再使用字符数估算。

上下文治理可在同一配置文件中调整；`summarizer` 与 `llm` 字段结构一致，省略时复用主模型：

```json
{
  "context": {
    "preserveRecentTokens": 20000,
    "preserveFullTurns": 4,
    "compactionInstructions": "保留精确文件路径、命令、错误文本和未完成事项",
    "summarizer": {
      "provider": "openai",
      "apiKey": "sk-...",
      "model": "gpt-5-mini"
    }
  }
}
```

导入规则：

- Codex：读取 `~/.codex/config.toml`、`~/.codex/auth.json` 和 `OPENAI_*` 环境变量，保存 OpenAI-compatible 的 `baseUrl`、默认模型和 API key。
- Claude Code：读取 `~/.claude/settings.json`、`~/.claude.json` 和 `ANTHROPIC_*` 环境变量，保存 Anthropic-compatible 的 `baseUrl`、默认模型和 API key。
- 如果两者都可导入，TUI 会要求二选一。

### OpenAI / OpenRouter / DeepSeek / xAI

```bash
export AGENT_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-5
# 可选：export OPENAI_BASE_URL=https://api.openai.com/v1

# 或
export AGENT_LLM_PROVIDER=openrouter
export OPENROUTER_API_KEY=...
export OPENROUTER_MODEL=anthropic/claude-sonnet-4

npm run dev
```

### Anthropic

```bash
export AGENT_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL=claude-sonnet-4-5

# 可选，默认 https://api.anthropic.com（可写 .../v1，会自动归一化）
export ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
export ANTHROPIC_VERSION=2023-06-01

npm run dev
```

## 验证

```bash
npm test -- --run
npm run typecheck
```

## 架构

```text
packages/core
  context          ConversationThread、TokenEstimator、ContextGovernor、SessionContext
  domain           共享协议和 zod schema
  llm              OpenAI-compatible / Anthropic-compatible 模型协议适配
  modes            normal / cross-repo 模式检测
  runtime          agent run 生命周期和事件流
  session          append-only JSONL 会话事实源和 SQLite 最近会话索引
  tools            Tool Gateway、工具注册、权限、入参校验和内置工具
  trace            JSONL trace 存储（~/.kross/traces/）

packages/tui
  App              交互式终端界面
  main             本地启动入口，trace 写入 ~/.kross/traces/，会话写入 ~/.kross/sessions/
```

## 后续扩展

短期优先把本地 agent 的可调试闭环补齐：

1. ~~实现 `/trace`~~：已支持最近运行列表与 `/trace <runId>` 详情（工具/审批/失败/context flags）。
2. ~~实现 `/diff`~~：agent 触达文件 + git status/diff --stat + 建议验证命令；`report.changedFiles` 在 run 结束时从 Write/Edit 回填。
3. 补齐 README 与真实能力的同步，持续让文档作为项目状态板使用。

随后把 `cross-repo` 从占位模式扩展成真实编排：

1. 读取本地 project registry。
2. 主代理调用已有 codegraph 服务做跨仓库影响面探索。
3. 生成 Cross-Repo Impact Map。
4. 拆分 repo 级子代理任务。
5. 子代理执行修改并回传 diff、测试和风险。
6. 主代理二次验收并保存完整 trace。
