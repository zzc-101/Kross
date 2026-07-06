# Kross

一个本地优先的交互式 agent runtime。第一阶段目标是先具备普通 agent 的基础能力，再把跨仓库协作作为独立模式接入。

## 当前能力

- 交互式 TUI 入口，启动后像 Claude Code 一样输入自然语言任务。
- `auto` / `normal` / `cross-repo` 三种模式。
- 普通模式具备最小运行闭环：解析目标、生成计划、记录 trace、返回报告。
- 跨仓库模式已经具备入口和确认门：检测到前后端/管理端/跨系统联动后，在执行前暂停等待确认。
- JSONL trace store，用于后续任务回放和 agent 迭代分析。

## 运行

```bash
npm install
npm run dev
```

默认不配置模型也能启动 TUI，会使用本地占位 planner。配置模型后，runtime 会在规划阶段调用 LLM，并把调用结果写入 trace。

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
  domain           共享协议和 zod schema
  llm              OpenAI-compatible / Anthropic-compatible 模型协议适配
  modes            normal / cross-repo 模式检测
  runtime          agent run 生命周期和事件流
  trace            JSONL trace 存储

packages/tui
  App              交互式终端界面
  main             本地启动入口，trace 写入 runs/
```

## 后续扩展

下一步会把 `cross-repo` 从占位模式扩展成真实编排：

1. 读取本地 project registry。
2. 主代理调用已有 codegraph 服务做跨仓库影响面探索。
3. 生成 Cross-Repo Impact Map。
4. 拆分 repo 级子代理任务。
5. 子代理执行修改并回传 diff、测试和风险。
6. 主代理二次验收并保存完整 trace。
