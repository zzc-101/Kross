# Kross

一个本地优先的交互式 agent runtime。第一阶段目标是先具备普通 agent 的基础能力，再把跨仓库协作作为独立模式接入。

## 当前能力

- 交互式 TUI 入口，启动后像 Claude Code 一样输入自然语言任务。
- `auto` / `normal` / `cross-repo` 三种模式。
- 普通模式具备最小运行闭环：解析目标、生成计划、记录 trace、返回报告。
- 跨仓库模式已经具备入口和确认门：检测到前后端/管理端/跨系统联动后，在执行前暂停等待确认，可通过 `/approve` 继续或 `/reject` 取消。
- JSONL trace store，用于后续任务回放和 agent 迭代分析。
- Context Manager：把 system prompt、对话历史、工作区/trace/memory 等上下文源、工具清单、技能 metadata、工具结果摘要组装为 LLM messages，并按字符预算裁剪低优先级上下文。
- Tool Gateway：统一注册工具、暴露工具 metadata、校验工具入参、阻断高风险工具的未授权调用，并把工具调用事件写入 trace。
- 内置工具集：`Read`、`Write`、`Edit`、`Glob`、`Grep` 和 `Bash` 已接入 Tool Gateway，支持原生 tool-call loop、审批恢复和 trace 记录。
- 首次配置导入：首次进入 TUI 时，如果本机检测到 Claude Code 或 Codex 配置，会提示通过 `/import claude`、`/import codex` 或 `/import skip` 导入/跳过；导入后保存到 `~/.kross/config.json`。

## 上下文系统

Kross 的上下文系统目前是本地内存版，目标是先把普通 agent 需要的上下文生命周期抽出来，后续再替换成持久化、检索和跨子代理共享实现。

已实现：

- 会话历史：保留最近多轮 user/assistant 消息，规划阶段自动带入模型请求。
- 上下文源：支持 workspace、repo、trace、memory、user、skill、tool-result、compaction 等来源类型，并按优先级和字符预算选择进入 prompt。
- 工具清单：Tool Gateway 注册的工具会以 metadata 形式进入上下文，让模型知道可用能力，但真实调用仍由 gateway 校验和执行。
- 技能清单：默认只注入技能名称、描述和位置，不把完整 `SKILL.md` 正文塞进 prompt；真正触发技能时再加载正文。
- 工具结果摘要：保留工具原始输出在 trace 中，prompt 里只放 summary，避免大段命令输出持续污染上下文。
- 历史压缩：支持把旧对话压成“仅供参考”的摘要，并保留最近 N 条消息，避免旧摘要覆盖最新用户指令。
- 上下文报告：每次 build 都会产出 section 大小、contributors、included/dropped sources，并写入 `context.built` trace event。
- `/context` 命令：在 TUI 中查看当前会话上下文状态，包括模式、总字符数、各 section 占用、included/dropped sources 和主要 contributors。

尚未实现：

- 自动触发 compaction 或 clearing。
- embedding/FTS 语义检索和跨 session memory restore。
- 子代理之间的共享 context store。
- 基于真实 token tokenizer 的精确预算，目前仍是字符估算。

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
- 内置文件工具：`Read`、`Write`、`Edit`、`Glob`、`Grep` 默认限制在 workspace 内，并使用真实路径校验阻断 symlink 越界。
- `Read` 支持 `offset` / `limit` 分段读取大文件，避免先把超大文件完整塞进上下文。
- `Bash` 会以 workspace 内目录作为 cwd 启动命令，但当前版本没有 OS 级沙箱；命令本身的系统访问能力主要由审批策略约束。
- 工具调用循环达到上限时，Runtime 会返回 failed 结果并记录 `llm.tool_loop.max_iterations`，避免静默完成。

尚未实现：

- MCP 工具发现和延迟加载。
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

### 配置优先级

模型配置优先级如下：

1. 环境变量：`AGENT_LLM_PROVIDER` + 对应的 `OPENAI_*` 或 `ANTHROPIC_*`。
2. Kross 配置：`~/.kross/config.json`，可由首次启动的 `/import` 命令生成。
3. 未配置：TUI 仍可启动，但普通 agent 回复会提示缺少模型配置。

导入规则：

- Codex：读取 `~/.codex/config.toml`、`~/.codex/auth.json` 和 `OPENAI_*` 环境变量，保存 OpenAI-compatible 的 `baseUrl`、默认模型和 API key。
- Claude Code：读取 `~/.claude/settings.json`、`~/.claude.json` 和 `ANTHROPIC_*` 环境变量，保存 Anthropic-compatible 的 `baseUrl`、默认模型和 API key。
- 如果两者都可导入，TUI 会要求二选一。

### OpenAI-compatible 协议

适合 OpenAI 官方接口，也适合 OpenRouter、DeepSeek、私有 OpenAI-compatible 网关等。

```bash
export AGENT_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-5

# 可选，默认 https://api.openai.com/v1
export OPENAI_BASE_URL=https://api.openai.com/v1

npm run dev
```

### Anthropic-compatible 协议

```bash
export AGENT_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL=claude-sonnet-4-5

# 可选，默认 https://api.anthropic.com/v1
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
  context          对话历史、上下文源、工具清单和 LLM messages 组装
  domain           共享协议和 zod schema
  llm              OpenAI-compatible / Anthropic-compatible 模型协议适配
  modes            normal / cross-repo 模式检测
  runtime          agent run 生命周期和事件流
  tools            Tool Gateway、工具注册、权限、入参校验和内置工具
  trace            JSONL trace 存储

packages/tui
  App              交互式终端界面
  main             本地启动入口，trace 写入 runs/
```

## 后续扩展

短期优先把本地 agent 的可调试闭环补齐：

1. 实现 `/trace`，在 TUI 中查看最近运行、工具调用、审批、失败原因和上下文事件。
2. 实现 `/diff`，汇总当前工作区变更、agent 触达文件和建议验证命令。
3. 补齐 README 与真实能力的同步，持续让文档作为项目状态板使用。

随后把 `cross-repo` 从占位模式扩展成真实编排：

1. 读取本地 project registry。
2. 主代理调用已有 codegraph 服务做跨仓库影响面探索。
3. 生成 Cross-Repo Impact Map。
4. 拆分 repo 级子代理任务。
5. 子代理执行修改并回传 diff、测试和风险。
6. 主代理二次验收并保存完整 trace。
