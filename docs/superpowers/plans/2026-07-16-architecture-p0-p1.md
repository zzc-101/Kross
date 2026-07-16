# Architecture P0/P1 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除架构 review 中的 P0（`AgentRuntime` 过重门面）与 P1（层依赖倒置、组合根在 tui、主/子双工具环漂移），在不改变对外产品行为的前提下让 core 可独立装配、可按层演进。

**Architecture:** 先修依赖方向（types 下沉、tools 不依赖 runner 实现），再把 Host 组合根迁入 core，再抽共享工具环原语并让 subagent 复用，最后把 `AgentRuntime` 拆成可委托的协作对象，门面 API 保持兼容。每步以现有测试为回归基线，禁止行为漂移。

**Tech Stack:** TypeScript monorepo (`@kross/core`, `@kross/tui`)、Vitest、Node ≥ 22.19、现有 `AgentRuntime` / `ToolGateway` / `SessionContext`。

**Out of scope（本计划不做）:**
- 收紧 `@kross/core` 全部 public exports（P2）
- Todo 持久化、OS 沙箱、MCP 热重载
- 主 agent 流式环与审批语义强行塞进 subagent（subagent 保持 complete + auto-allow）
- TUI `handleCommand` 重构（P2）

**回归命令（每个 Task 结束必须跑）:**
```bash
npm test -- --run
npm run typecheck
```

**执行顺序（依赖图）:**
```
Task1 层依赖: pending types
  → Task2 层依赖: subagent types / Task tool
    → Task3 组合根迁入 core
      → Task4 共享工具环原语 + subagent 迁移
        → Task5 AgentRuntime 拆分（Session + Model）
          → Task6 AgentRuntime 拆分（Mode flows）
            → Task7 门面收口 + 文档
```

---

## File Structure (target)

| Path | Responsibility |
|------|----------------|
| `packages/core/src/modes/conductorPlan.ts` | `ConductorTask` / `ConductorTaskPlan` schema + 纯格式化（从 runtime 下沉） |
| `packages/core/src/modes/pendingExecution.ts` | `PendingPlanExecution` / `PendingConductorExecution` / `PendingModeExecution` |
| `packages/core/src/runtime/subagentTypes.ts` | Subagent 请求/结果/runner 类型（无实现） |
| `packages/core/src/runtime/toolLoopShared.ts` | 主/子共享：`toLlmTools`、顺序执行工具、soft-land 文案、stall 检测 helper |
| `packages/core/src/runtime/completeToolLoop.ts` | 非流式 complete 工具环（供 subagent；可测） |
| `packages/core/src/host/createAgentHost.ts` | Composition root：tooling + runtime options + MCP |
| `packages/core/src/runtime/sessionServices.ts` | mode/permission/todo/registry/context source 同步 |
| `packages/core/src/runtime/modelSession.ts` | llm client / model / thinking effort 绑定 |
| `packages/core/src/runtime/modeFlows.ts` | plan gate / conductor gate / conductor execute 生成器 |
| `packages/core/src/runtime/agentRuntime.ts` | 薄门面：构造委托 + `executeRun` 分发 + 对外方法转发 |
| `packages/tui/src/createRuntime.ts` | 薄 re-export / 兼容包装，逻辑迁到 core |

修改但保持公开行为不变：
- `packages/core/src/modes/modePolicy.ts`
- `packages/core/src/runtime/agentRuntimeTypes.ts`
- `packages/core/src/runtime/conductorOrchestration.ts`
- `packages/core/src/runtime/subagentRunner.ts`
- `packages/core/src/tools/builtin/task.ts`
- `packages/core/src/index.ts`
- `packages/tui/src/main.tsx`
- `packages/tui/src/createRuntime.test.ts`（迁测或加 core 侧测试）

---

### Task 1: 切断 `modes → runtime` 类型依赖

**Files:**
- Create: `packages/core/src/modes/conductorPlan.ts`
- Create: `packages/core/src/modes/pendingExecution.ts`
- Modify: `packages/core/src/runtime/conductorOrchestration.ts`
- Modify: `packages/core/src/runtime/agentRuntimeTypes.ts`
- Modify: `packages/core/src/modes/modePolicy.ts`
- Modify: `packages/core/src/index.ts`（如需 re-export）
- Test: 现有 `packages/core/src/modes/modePolicy.test.ts`（若无则新建最小测）；`packages/core/src/runtime/agentRuntime.test.ts` 回归

- [x] **Step 1: 抽出 conductor plan 类型到 modes**

把 `conductorOrchestration.ts` 里的 schema/types 迁到 `modes/conductorPlan.ts`：

```ts
// packages/core/src/modes/conductorPlan.ts
import { z } from 'zod';

export const conductorTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  repoId: z.string().min(1).optional()
});
export type ConductorTask = z.infer<typeof conductorTaskSchema>;

export const conductorTaskPlanSchema = z.object({
  goal: z.string().min(1),
  tasks: z.array(conductorTaskSchema).min(1),
  notes: z.string().optional()
});
export type ConductorTaskPlan = z.infer<typeof conductorTaskPlanSchema>;
```

`conductorOrchestration.ts` 改为：

```ts
export {
  conductorTaskSchema,
  conductorTaskPlanSchema,
  type ConductorTask,
  type ConductorTaskPlan
} from '../modes/conductorPlan';

// 保留 formatConductorTaskPlanSummary / formatConductorReviewSummary / parse*
// 从 '../modes/conductorPlan' import 类型
```

- [x] **Step 2: 新建 pendingExecution，并从 agentRuntimeTypes 迁出**

```ts
// packages/core/src/modes/pendingExecution.ts
import type { ConductorTaskPlan } from './conductorPlan';

export interface PendingConductorExecution {
  kind: 'conductor';
  goal: string;
  mode: 'conductor';
  plan: ConductorTaskPlan;
}

export interface PendingPlanExecution {
  kind: 'plan';
  goal: string;
  mode: 'plan';
  planText: string;
}

export type PendingModeExecution =
  | PendingConductorExecution
  | PendingPlanExecution;
```

`agentRuntimeTypes.ts`：

```ts
export type {
  PendingConductorExecution,
  PendingPlanExecution,
  PendingModeExecution
} from '../modes/pendingExecution';
```

（兼容 re-export，避免破坏现有 import 路径。）

- [x] **Step 3: modePolicy 改为只依赖 modes**

```ts
// modePolicy.ts
import type { PendingModeExecution } from './pendingExecution';
// 删除: import type { PendingModeExecution } from '../runtime/agentRuntimeTypes';
```

- [x] **Step 4: 写/更新层依赖守护测试**

Create `packages/core/src/modes/layerBoundaries.test.ts`：

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const modesDir = join(__dirname);

function listTsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(dir, name));
}

describe('modes layer boundaries', () => {
  it('does not import from runtime/', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(modesDir)) {
      const src = readFileSync(file, 'utf8');
      if (/from ['"]\.\.\/runtime\//.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [x] **Step 5: 跑测试**

Run:
```bash
npm test -- --run packages/core/src/modes
npm run typecheck
```
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add packages/core/src/modes packages/core/src/runtime/agentRuntimeTypes.ts packages/core/src/runtime/conductorOrchestration.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
refactor(core): move pending/conductor plan types into modes layer

Cut modes → runtime type dependency so mode policy stays above the runner.
EOF
)"
```

---

### Task 2: Task 工具只依赖 subagent 类型，不依赖 runner 实现

**Files:**
- Create: `packages/core/src/runtime/subagentTypes.ts`
- Modify: `packages/core/src/runtime/subagentRunner.ts`
- Modify: `packages/core/src/tools/builtin/task.ts`
- Modify: `packages/core/src/tools/builtin/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/runtime/subagentRunner.test.ts`；必要时 `packages/core/src/tools/builtin/layerBoundaries.test.ts`

- [x] **Step 1: 抽出纯类型**

```ts
// packages/core/src/runtime/subagentTypes.ts
import type { SubagentResult } from '../domain';

export type SubagentMode = 'explore' | 'general';

export interface SubagentRunRequest {
  prompt: string;
  mode?: SubagentMode;
  title?: string;
  parentRunId: string;
  parentDepth?: number;
  signal?: AbortSignal;
  workspaceRoot?: string;
  repoId?: string;
  preferWorkerModel?: boolean;
}

export interface SubagentRunOutcome {
  result: SubagentResult;
  subRunId: string;
  mode: SubagentMode;
  modeForcedToExplore: boolean;
}

export type SubagentRunner = (
  request: SubagentRunRequest
) => Promise<SubagentRunOutcome>;
```

`subagentRunner.ts`：删除本地重复 type 定义，改为 re-export：

```ts
export type {
  SubagentMode,
  SubagentRunRequest,
  SubagentRunOutcome,
  SubagentRunner
} from './subagentTypes';
```

保留 `SubagentRunDeps`、`runSubagent`、`formatSubagentToolContent` 等实现。

- [x] **Step 2: 重写 task.ts 依赖**

`createTaskTool` 只 import 类型 + 本地/共享的 content 格式化接口：

```ts
// packages/core/src/tools/builtin/task.ts
import type {
  SubagentMode,
  SubagentRunRequest,
  SubagentRunner,
  SubagentRunOutcome
} from '../../runtime/subagentTypes';

export interface CreateTaskToolOptions {
  parentDepth?: number;
  run: SubagentRunner;
  resolveRepoPath?: (repoId: string) => string | undefined;
  /** 可选：注入格式化，默认用 formatOutcome；避免 tools 绑定 runner 实现 */
  formatOutcome?: (outcome: SubagentRunOutcome) => string;
}
```

把 `formatSubagentToolContent` 的**默认实现**仍放在 `subagentRunner.ts`，但 Task 内提供一个最小默认或由调用方注入。

**推荐（零行为变化）:** 把 `formatSubagentToolContent` 挪到 `subagentTypes` 旁的纯函数文件：

- Create: `packages/core/src/runtime/subagentFormat.ts`（仅字符串格式化，依赖 `SubagentRunOutcome`）
- `task.ts` import `formatSubagentToolContent` from `../../runtime/subagentFormat`
- `subagentRunner.ts` re-export 保持兼容

- [x] **Step 3: 移动 `createDefaultSubagentRunner` 到 subagentRunner.ts**

从 `task.ts` 删除 `createDefaultSubagentRunner`。在 `subagentRunner.ts` 末尾：

```ts
export function createDefaultSubagentRunner(
  deps: SubagentRunDeps
): SubagentRunner {
  return (request) => runSubagent(request, deps);
}
```

`tools/builtin/index.ts` 改为：

```ts
export { createTaskTool, type CreateTaskToolOptions } from './task';
export { createDefaultSubagentRunner } from '../../runtime/subagentRunner';
```

（或 index 只 export task，host 直接从 runtime 取 runner。）

- [x] **Step 4: 层依赖守护测试**

```ts
// packages/core/src/tools/builtin/layerBoundaries.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('builtin tools layer boundaries', () => {
  it('task.ts does not import subagentRunner implementation', () => {
    const src = readFileSync(join(__dirname, 'task.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"].*subagentRunner['"]/);
  });
});
```

- [x] **Step 5: 跑测试**

```bash
npm test -- --run packages/core/src/runtime/subagentRunner.test.ts packages/core/src/tools/builtin
npm run typecheck
```
Expected: PASS（含 Task 嵌套拒绝、repoId、取消上抛）

- [x] **Step 6: Commit**

```bash
git add packages/core/src/runtime/subagentTypes.ts packages/core/src/runtime/subagentFormat.ts packages/core/src/runtime/subagentRunner.ts packages/core/src/tools/builtin/task.ts packages/core/src/tools/builtin/index.ts packages/core/src/tools/builtin/layerBoundaries.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
refactor(core): decouple Task tool from subagentRunner implementation

Task depends only on SubagentRunner types and pure format helpers.
EOF
)"
```

---

### Task 3: Composition root 迁入 core（`createAgentHost`）

**Files:**
- Create: `packages/core/src/host/createAgentHost.ts`
- Create: `packages/core/src/host/createAgentHost.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/tui/src/createRuntime.ts`（薄包装）
- Modify: `packages/tui/src/main.tsx`（import 可改 core，或继续经 tui 包装）
- Move/adapt tests from: `packages/tui/src/createRuntime.test.ts`

- [x] **Step 1: 把 createRuntime 逻辑原样迁到 core host**

目标 API（保持现有语义）：

```ts
// packages/core/src/host/createAgentHost.ts
export interface CreateAgentHostConfigOptions {
  homeDir?: string;
  krossHome?: string;
}

export interface AgentHostTooling {
  toolGateway: ToolGateway;
  traceStore: ObservableTraceStore;
  todoStore: TodoStore;
  workspaceRoots: WorkspaceRoots;
  setLlmClient: (client: LlmClient | undefined) => void;
  runSubagent: NonNullable<AgentRuntimeOptions['runSubagent']>;
  mcpManager?: McpManager;
  closeTraceStore: () => void;
  close: () => Promise<void>;
}

export function createRuntimeOptionsFromEnv(
  cwd: string,
  env: Record<string, string | undefined>,
  fetch?: LlmFetch,
  options?: CreateAgentHostConfigOptions,
  tooling?: Pick<
    AgentHostTooling,
    | 'toolGateway'
    | 'traceStore'
    | 'todoStore'
    | 'setLlmClient'
    | 'runSubagent'
    | 'workspaceRoots'
  >
): AgentRuntimeOptions;

export async function bootstrapRuntimeTooling(
  cwd: string,
  env?: Record<string, string | undefined>,
  options?: CreateAgentHostConfigOptions
): Promise<AgentHostTooling>;
```

实现步骤：
1. 复制 `packages/tui/src/createRuntime.ts` 全文到 `host/createAgentHost.ts`
2. 修正 import：全部改为 core 相对路径（去掉 `@kross/core`）
3. 将 `RuntimeTooling` rename 为 `AgentHostTooling`（tui 侧 `export type RuntimeTooling = AgentHostTooling` 兼容）
4. `createLocalTooling` / `parseMaxToolIterations` 一并迁入（不必 export）

- [x] **Step 2: core index 导出**

```ts
// packages/core/src/index.ts
export * from './host/createAgentHost';
```

- [x] **Step 3: tui createRuntime 变薄**

```ts
// packages/tui/src/createRuntime.ts
export {
  bootstrapRuntimeTooling,
  createRuntimeOptionsFromEnv,
  type AgentHostTooling as RuntimeTooling,
  type CreateAgentHostConfigOptions as CreateRuntimeConfigOptions
} from '@kross/core';
```

若测试仍 import 自 `./createRuntime`，无需改 import 路径。

- [x] **Step 4: 迁移测试到 core**

Create `packages/core/src/host/createAgentHost.test.ts`，把 `createRuntime.test.ts` 中断言原样迁入，import：

```ts
import { createRuntimeOptionsFromEnv } from './createAgentHost';
```

tui 的 `createRuntime.test.ts` 可保留 1 个冒烟测试证明 re-export 存在，或删除重复只留 core。

关键断言至少保留：
- 有 OPENAI env 时 `llmClient` 为 `PiAiLlmClient`
- 无配置时 `llmClient` undefined
- `AGENT_MAX_TOOL_ITERATIONS` 解析
- tooling 复用时不重复建 gateway

- [x] **Step 5: 跑测试**

```bash
npm test -- --run packages/core/src/host packages/tui/src/createRuntime.test.ts
npm run typecheck
```
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add packages/core/src/host packages/core/src/index.ts packages/tui/src/createRuntime.ts packages/tui/src/createRuntime.test.ts packages/tui/src/main.tsx
git commit -m "$(cat <<'EOF'
refactor: move agent host composition root into @kross/core

TUI now re-exports bootstrap APIs; core can assemble tooling without UI.
EOF
)"
```

---

### Task 4: 共享工具环原语 + subagent 迁移到 `completeToolLoop`

**Files:**
- Create: `packages/core/src/runtime/toolLoopShared.ts`
- Create: `packages/core/src/runtime/completeToolLoop.ts`
- Create: `packages/core/src/runtime/completeToolLoop.test.ts`
- Modify: `packages/core/src/runtime/subagentRunner.ts`（删除内联 `runSubagentToolLoop` / `executeToolCalls` / `toLlmTools`）
- Modify: `packages/core/src/runtime/toolLoop.ts` 与/或 `streamingToolLoop.ts`（改用 shared `toLlmTools` / soft-land 常量，若已有重复）
- Test: 现有 `subagentRunner.test.ts` + 新 `completeToolLoop.test.ts`

**设计约束（避免过度统一）:**
- 主环继续 `runStreamingToolLoop`（流式 + 审批挂起）
- 子环使用 `runCompleteToolLoop`（`client.complete` + auto-allow gateway）
- 共享：工具 metadata→LLM tools、顺序 `gateway.call`、soft-land 文案、重复 tool signature stall 检测

- [x] **Step 1: 写 completeToolLoop 失败测试（TDD）**

```ts
// packages/core/src/runtime/completeToolLoop.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runCompleteToolLoop } from './completeToolLoop';
import { createSessionContext } from '../context/sessionContext';
import { ToolGateway } from '../tools/toolGateway';
import { z } from 'zod';

describe('runCompleteToolLoop', () => {
  it('returns assistant text when model emits no tool calls', async () => {
    const sessionContext = createSessionContext({});
    const gateway = new ToolGateway({});
    const complete = vi.fn().mockResolvedValue({
      provider: 'openai',
      model: 't',
      text: 'done',
      raw: {},
      toolCalls: []
    });
    const summary = await runCompleteToolLoop({
      runId: 'run-1',
      prompt: 'hello',
      systemPrompt: 'sys',
      llmClient: {
        provider: 'openai',
        model: 't',
        complete,
        stream: async function* () {}
      } as any,
      gateway,
      tools: [],
      sessionContext,
      maxIterations: 5
    });
    expect(summary).toBe('done');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('soft-lands when max iterations hit with tool calls every turn', async () => {
    // mock complete always returns one tool call; register a no-op tool
    // expect final summary from soft-land complete without tools
  });

  it('stops on repeated identical tool signatures', async () => {
    // same tool name+input twice in a row after first → stall summary
  });
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
npm test -- --run packages/core/src/runtime/completeToolLoop.test.ts
```
Expected: FAIL（module not found / function not defined）

- [x] **Step 3: 实现 shared + completeToolLoop**

```ts
// packages/core/src/runtime/toolLoopShared.ts
import type { LlmMessage, LlmToolCall, LlmToolDefinition } from '../llm/types';
import type { ToolGateway, ToolMetadata } from '../tools/toolGateway';
import { throwIfAborted } from '../abort';

export function toLlmTools(tools: ToolMetadata[]): LlmToolDefinition[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

export function toolCallsSignature(calls: LlmToolCall[]): string {
  return calls
    .map((call) => `${call.name}:${stableJson(call.input)}`)
    .join('|');
}

export function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function executeSequentialToolCalls(input: {
  runId: string;
  gateway: ToolGateway;
  calls: LlmToolCall[];
  signal?: AbortSignal;
}): Promise<LlmMessage[]> {
  const out: LlmMessage[] = [];
  for (const call of input.calls) {
    throwIfAborted(input.signal);
    const result = await input.gateway.call({
      runId: input.runId,
      name: call.name,
      input: call.input,
      callId: call.id,
      returnErrors: true,
      signal: input.signal
    });
    out.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: result.content
    });
  }
  return out;
}
```

`completeToolLoop.ts`：把 `subagentRunner.ts` 里 `runSubagentToolLoop` 的 while 循环搬过来，参数泛化为 `systemPrompt` / `mode` / optional `onTrace` / `metadataPurpose`，**行为与现 subagent 环逐条对齐**（含 stall `repeatedSignatureCount >= 2`、soft-land user 文案）。

- [x] **Step 4: subagentRunner 改为调用 completeToolLoop**

```ts
const summary = await runCompleteToolLoop({
  runId: subRunId,
  prompt,
  systemPrompt: SUBAGENT_SYSTEM_PROMPT,
  mode: 'auto',
  llmClient,
  gateway: childGateway,
  tools: toolMeta,
  sessionContext,
  maxIterations: deps.maxToolIterations ?? 40,
  signal: request.signal,
  // 把 llm.subagent.* trace 通过 onTurn hooks 保留
  onTurn: async (event) => { await appendTrace(...); }
});
```

删除 `runSubagentToolLoop` / 本地 `executeToolCalls` / 本地 `toLlmTools`。

- [x] **Step 5: 主环去重（小步）**

在 `toolLoop.ts` / `streamingToolLoop.ts` 中，若存在同名 `toLlmTools`，改为 import from `toolLoopShared`。不要在本 Task 改审批/流式控制流。

- [x] **Step 6: 跑全量相关测试**

```bash
npm test -- --run packages/core/src/runtime/subagentRunner.test.ts packages/core/src/runtime/completeToolLoop.test.ts packages/core/src/runtime/agentRuntime.test.ts
npm run typecheck
```
Expected: PASS

- [x] **Step 7: Commit**

```bash
git add packages/core/src/runtime/toolLoopShared.ts packages/core/src/runtime/completeToolLoop.ts packages/core/src/runtime/completeToolLoop.test.ts packages/core/src/runtime/subagentRunner.ts packages/core/src/runtime/toolLoop.ts packages/core/src/runtime/streamingToolLoop.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract shared complete tool loop for subagents

Keep streaming approval path for main agent; eliminate duplicated
tool execution and soft-land logic drift.
EOF
)"
```

---

### Task 5: 从 AgentRuntime 拆出 SessionServices + ModelSession

**Files:**
- Create: `packages/core/src/runtime/sessionServices.ts`
- Create: `packages/core/src/runtime/modelSession.ts`
- Create: `packages/core/src/runtime/sessionServices.test.ts`（可选，轻量）
- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Test: `packages/core/src/runtime/agentRuntime.test.ts`（必须全绿）

**约束:** 不改变任何 public 方法签名；`AgentRuntime` 方法体改为委托。

- [x] **Step 1: 抽出 ModelSession**

迁入（来自 `agentRuntime.ts` 的现有实现）：
- `getModelLabel` / `getThinkingEffort` / `setThinkingEffort` / `cycleThinkingEffort`
- `getLlmClient` / `setLlmClient` / `setModel`

```ts
// packages/core/src/runtime/modelSession.ts
export class ModelSession {
  constructor(
    private options: { llmClient?: LlmClient },
    private readonly onClientChange: (client: LlmClient | undefined) => void
  ) {}

  getLlmClient(): LlmClient | undefined {
    return this.options.llmClient;
  }

  setLlmClient(client: LlmClient | undefined): void {
    this.options.llmClient = client;
    this.onClientChange(client);
  }

  // ... setModel / thinking effort 与现实现一致
}
```

`AgentRuntime` 构造：

```ts
this.modelSession = new ModelSession(this.options, (client) => {
  this.toolLoop.setLlmClient(client);
  this.sessionContext.setLlmClient(client);
});
```

公开方法：

```ts
getModelLabel(): string {
  return this.modelSession.getModelLabel();
}
// 其余同理委托
```

- [x] **Step 2: 抽出 SessionServices**

迁入：
- `sessionMode` 状态 + `getSessionMode` / `setSessionMode` / `onModeChanged`（EventEmitter 可注入 `emit` 回调）
- `permissionMode` + `get/setPermissionMode`
- `syncSessionModeSource` / `syncTodoContextSource` / `syncProjectRegistrySource`
- `getTodoStore` / `getWorkspaceRoots`
- pending mode execution 的 get/clear（可选本 Task 或 Task 6）

```ts
export class SessionServices {
  constructor(
    private readonly deps: {
      sessionContext: SessionContext;
      toolGateway?: ToolGateway;
      options: AgentRuntimeOptions;
      emitModeChanged: (event: { mode: AgentMode; previous: AgentMode }) => void;
    }
  ) {}

  // 现有 private sync* 方法整体搬迁，保持文案与 priority 不变
}
```

- [x] **Step 3: agentRuntime 改为组合**

构造函数创建 `sessionServices` / `modelSession`，删除已迁走的 private 字段与方法实现。`buildPlannerContext` / `resolveContextBuildInput` 调用 `this.sessionServices.sync*()`。

- [x] **Step 4: 回归**

```bash
npm test -- --run packages/core/src/runtime/agentRuntime.test.ts
npm run typecheck
```
Expected: PASS；`agentRuntime.ts` 行数应明显下降（目标：<1100，不强制精确）。

- [x] **Step 5: Commit**

```bash
git add packages/core/src/runtime/sessionServices.ts packages/core/src/runtime/modelSession.ts packages/core/src/runtime/agentRuntime.ts packages/core/src/runtime/sessionServices.test.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract SessionServices and ModelSession from AgentRuntime

Keep public AgentRuntime API; move session sync and model binding out.
EOF
)"
```

---

### Task 6: 从 AgentRuntime 拆出 ModeFlows（plan/conductor）

**Files:**
- Create: `packages/core/src/runtime/modeFlows.ts`
- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Test: `packages/core/src/runtime/agentRuntime.test.ts`（plan gate、conductor、approve 相关用例）

- [x] **Step 1: 识别迁移块（按现有方法）**

从 `agentRuntime.ts` 迁到 `modeFlows.ts`（作为 class `ModeFlows` 或模块级函数 + deps）：

| 方法 | 新位置 |
|------|--------|
| `runnerPlanGatePhase` | `ModeFlows.planGatePhase` |
| `classifyPlanIntent` | `ModeFlows.classifyPlanIntent` |
| `streamPlainAssistantText` | `ModeFlows.streamPlainAssistantText` |
| `finishPlanGateWithText` | `ModeFlows.finishPlanGateWithText` |
| `runnerConductorGatePhase` | `ModeFlows.conductorGatePhase` |
| `buildConductorTaskPlan` | `ModeFlows.buildConductorTaskPlan` |
| `runnerConductorExecutePhase` | `ModeFlows.conductorExecutePhase` |
| `parsePlanIntentKind` / `isCasualChatInput` / `chunkTextForStream` | 可留在 modeFlows 作为 exported helpers |

Deps 注入（避免 ModeFlows 反向 new Runtime）：

```ts
export interface ModeFlowsDeps {
  options: AgentRuntimeOptions;
  sessionContext: SessionContext;
  sessionServices: SessionServices;
  createRunId: () => string;
  record: (runId: string, type: string, payload: Record<string, unknown>) => Promise<void>;
  runAgentToolLoop: (...) => AsyncIterable<AgentRunStreamEvent>;
  finishRunWithoutLlm: (...) => Promise<AgentResult>;
  completeInterruptedRun: (...) => Promise<AgentResult>;
  get/set pendingModeExecution: ...
  // 仅复制现有闭包依赖，不发明新行为
}
```

- [x] **Step 2: executeRun 只做分发**

```ts
private async *executeRun(input: AgentRunInput): AsyncIterable<AgentRunStreamEvent> {
  const { detection, action } = resolveModeTurn({...});
  const runId = this.createRunId();
  // record started / mode.detected 可留在 Runtime 或 ModeFlows.entry
  switch (action.type) {
    case 'agent-loop':
      yield* this.runAgentToolLoop(...);
      return;
    case 'plan-gate-flow':
      yield* this.modeFlows.planGatePhase(...);
      return;
    case 'conductor-gate-flow':
      yield* this.modeFlows.conductorGatePhase(...);
      return;
    case 'conductor-execute':
      yield* this.modeFlows.conductorExecutePhase(...);
      return;
    case 'no-llm':
      // ...
  }
}
```

- [x] **Step 3: 全量 runtime 回归**

```bash
npm test -- --run packages/core/src/runtime
npm run typecheck
```
Expected: PASS。重点人工扫：plan `/approve`、conductor fan-out、无 LLM 模板路径。

- [x] **Step 4: Commit**

```bash
git add packages/core/src/runtime/modeFlows.ts packages/core/src/runtime/agentRuntime.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract plan/conductor mode flows from AgentRuntime

AgentRuntime executeRun becomes a thin mode-policy dispatcher.
EOF
)"
```

---

### Task 7: 门面收口、导出整理、架构文档

**Files:**
- Modify: `packages/core/src/runtime/agentRuntime.ts`（确认仅编排）
- Modify: `packages/core/src/index.ts`（导出 host / 新模块；旧路径 re-export 不删）
- Modify: `README.md`（「架构」小节：层、host、双环策略）
- Create or update: `docs/superpowers/specs/2026-07-16-architecture-hardening-design.md`（可选短文，记录不变量）

- [x] **Step 1: 核对 AgentRuntime 职责清单**

完成后 `agentRuntime.ts` 应主要包含：
1. 构造与协作对象装配
2. `run` / `runStreaming` / `executeRun` 分发
3. `runAgentToolLoop`（或再委托 RuntimeToolLoop 的薄封装）
4. 审批转发（已委托 toolLoop）
5. context inspect / compact 转发
6. trace 订阅与 record 辅助

不应再包含：长段 plan JSON 解析、conductor worker 循环细节、context source 字符串拼装（已在 SessionServices）。

目标体量：**约 400–700 行**（硬上限 900；超过则继续拆 `runAgentToolLoop` 周边）。

- [x] **Step 2: README 增补架构小节**

在 README「当前能力」后或独立 `## 架构`：

```markdown
## 架构（core）

- **modes**：策略（`resolveModeTurn`），不拥有输出管线；pending plan 类型在 modes。
- **host**：`bootstrapRuntimeTooling` / `createRuntimeOptionsFromEnv` 为组合根，TUI 只消费。
- **runtime**：`AgentRuntime` 门面 + `ModeFlows` + `RuntimeToolLoop`（流式/审批）+ `completeToolLoop`（子代理）。
- **tools**：Gateway 与 builtin；Task 只依赖 `SubagentRunner` 类型。
- **context**：ConversationThread 为模型上下文 SSOT。
```

- [x] **Step 3: 全量验证**

```bash
npm test -- --run
npm run typecheck
git diff --check
```
Expected: 全绿；无新增 layer boundary 失败。

- [x] **Step 4: 最终 Commit**

```bash
git add README.md docs/superpowers packages/core/src/index.ts packages/core/src/runtime/agentRuntime.ts
git commit -m "$(cat <<'EOF'
docs: record core layering and host composition after P0/P1 refactor

Document modes/host/runtime/tools boundaries and dual tool-loop policy.
EOF
)"
```

---

## Self-Review (plan vs P0/P1)

| 问题 | 对应 Task |
|------|-----------|
| P0 `AgentRuntime` God Facade | Task 5 + Task 6 + Task 7 收口 |
| P1 modes → runtime 类型依赖 | Task 1 |
| P1 tools → subagentRunner 实现 | Task 2 |
| P1 组合根在 tui | Task 3 |
| P1 主/子双环漂移 | Task 4（共享原语 + subagent 迁移；主环保留流式） |

**刻意不做的过度设计：**
- 不把 subagent 强行改为 streaming + approval（会改产品语义）
- 不在本计划拆 monorepo 新 package
- 不改 TUI 命令总线（P2）

**风险与缓解：**
| 风险 | 缓解 |
|------|------|
| modeFlows 抽取漏传 deps | 只搬现有方法，全量 `agentRuntime.test.ts` |
| host 迁移路径/env 差异 | 原样搬 createRuntime + 迁测试 |
| completeToolLoop 行为差 1 字节 | 保留 stall 阈值与 soft-land 文案；对照 subagent 测试 |
| 公开 API 破坏 | 旧路径 re-export；tui createRuntime 兼容别名 |

**类型一致性约定：**
- `PendingModeExecution` 唯一定义：`modes/pendingExecution.ts`
- `SubagentRunner` 唯一定义：`runtime/subagentTypes.ts`
- Host 对外名：`createRuntimeOptionsFromEnv` / `bootstrapRuntimeTooling`（与现 tui 同名，降低迁移成本）
- `AgentHostTooling` 为规范名；tui `RuntimeTooling` 为别名
