# Runtime 拆分与 TUI 流畅渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持公共 API 和现有视觉语义的前提下拆分核心大文件，并消除 TUI 高频更新时的整屏频闪和双层滚动调度。

**Architecture:** `AgentRuntime` 与 `App` 保留门面职责，把 inspection、tool loop、commands、trace mapping、scroll state、stream buffering 和 shell layout 抽成独立模块。渲染侧用安全根高度避开 Ink `clearTerminal`，用稳定 paint layout 复用历史布局，并按 32ms 合并流式消息更新。

**Tech Stack:** TypeScript 5.7、React 18、Ink 5.2.1、Vitest 2、Zod 3。

## Global Constraints

- `AgentRuntime`、`AgentRuntimeOptions`、`AgentRunInput`、`AgentRunStreamEvent`、`AppProps` 和 `AppTestApi` 保持向后兼容。
- 不新增运行时依赖，不改变 Markdown 样式和工具审批语义。
- 所有行为改动必须先有失败测试，重构阶段持续运行现有回归测试。
- 全屏 TUI 输出高度必须严格小于 `stdout.rows`。
- 触摸板事件最多经过一个 frame scheduler。

---

### Task 1: 拆分 AgentRuntime 类型与 Inspection

**Files:**
- Create: `packages/core/src/runtime/agentRuntimeTypes.ts`
- Create: `packages/core/src/runtime/runtimeInspection.ts`
- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/runtime/agentRuntime.test.ts`
- Test: `packages/core/src/runtime/runtimeInspection.test.ts`

**Interfaces:**
- Produces: `AgentRuntimeOptions`、`AgentRunInput`、`ResolveToolApprovalInput`、`AgentRunStreamEvent`；`RuntimeInspection` 类的 `listTraces()`、`inspectTrace()`、`formatTraceCommand()`、`formatDiffCommand()`。
- Consumes: `TraceStore`、`GitRunner`、`workspaceRoot`。

- [ ] **Step 1: 写 RuntimeInspection 的失败测试**

```ts
const inspection = new RuntimeInspection({ traceStore });
expect(await inspection.formatTraceCommand()).toContain('run-1');
expect(await inspection.formatTraceCommand('../bad')).toContain('无效 runId');
```

- [ ] **Step 2: 运行测试确认因模块不存在而失败**

Run: `npm test -- packages/core/src/runtime/runtimeInspection.test.ts --run`
Expected: FAIL，无法导入 `RuntimeInspection`。

- [ ] **Step 3: 移动类型与 inspection 实现并由 AgentRuntime 委托**

```ts
private readonly inspection = new RuntimeInspection({
  traceStore: this.options.traceStore,
  workspaceRoot: this.options.workspaceRoot,
  runGit: this.options.runGit
});
```

- [ ] **Step 4: 运行 runtime 与 inspection 测试**

Run: `npm test -- packages/core/src/runtime/runtimeInspection.test.ts packages/core/src/runtime/agentRuntime.test.ts --run`
Expected: PASS。

### Task 2: 抽取工具循环与审批会话

**Files:**
- Create: `packages/core/src/runtime/toolLoop.ts`
- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Test: `packages/core/src/runtime/agentRuntime.test.ts`

**Interfaces:**
- Produces: `RuntimeToolLoop`，公开 `createPlannerSuggestion()`、`executeToolBatch()`、`resolveToolApproval()`、`streamSoftLand()` 和 `createMaxToolIterationsResult()`。
- Consumes: LLM client、ToolGateway、ContextManager，以及 runtime 提供的 `record`、`attachChangedFiles`、`appendConversation` 回调。

- [ ] **Step 1: 运行工具循环相关现有用例建立绿色基线**

Run: `npm test -- packages/core/src/runtime/agentRuntime.test.ts --run`
Expected: 25 tests PASS。

- [ ] **Step 2: 抽取 RuntimeToolLoop 并保持执行顺序不变**

```ts
this.toolLoop = new RuntimeToolLoop({
  llmClient: options.llmClient,
  toolGateway: this.toolGateway,
  contextManager: this.contextManager,
  maxToolIterations: options.maxToolIterations,
  record: this.record.bind(this),
  attachChangedFiles: this.attachChangedFiles.bind(this),
  appendConversation: this.appendConversation.bind(this)
});
```

- [ ] **Step 3: AgentRuntime 改为委托并删除重复私有方法**

```ts
const plannerOutcome = await this.toolLoop.createPlannerSuggestion(
  runId,
  input.input,
  detection.mode
);
```

- [ ] **Step 4: 运行 core 全量测试和类型检查**

Run: `npm test -- packages/core --run`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

### Task 3: 拆分 App 命令、trace 和布局职责

**Files:**
- Create: `packages/tui/src/app/appCommands.ts`
- Create: `packages/tui/src/app/traceMessages.ts`
- Create: `packages/tui/src/app/AppShell.tsx`
- Modify: `packages/tui/src/App.tsx`
- Test: `packages/tui/src/App.test.tsx`

**Interfaces:**
- Produces: `handleCommand()`、`handleTraceEvent()`、`appendApprovalResult()`、`AppShell`、`resolveShellRows(rows: number): number`。
- Consumes: 现有 UI 组件、AgentRuntime 和 App 状态 setter；不拥有业务状态。

- [ ] **Step 1: 增加 AppShell 安全行数失败测试**

```ts
expect(resolveShellRows(24)).toBe(23);
expect(resolveShellRows(1)).toBe(1);
```

- [ ] **Step 2: 运行测试确认导出不存在**

Run: `npm test -- packages/tui/src/app/AppShell.test.ts --run`
Expected: FAIL，无法导入 `resolveShellRows`。

- [ ] **Step 3: 移动纯函数与 JSX，App 只传递状态和回调**

```tsx
return <AppShell rows={rows} columns={columns} header={header} body={body} footer={footer} />;
```

- [ ] **Step 4: 运行 App 回归测试**

Run: `npm test -- packages/tui/src/app/AppShell.test.ts packages/tui/src/App.test.tsx --run`
Expected: PASS。

### Task 4: 修复整屏清空和双层滚动调度

**Files:**
- Create: `packages/tui/src/app/fullscreenOutput.test.tsx`
- Create: `packages/tui/src/app/useViewportScroll.ts`
- Modify: `packages/tui/src/app/AppShell.tsx`
- Modify: `packages/tui/src/App.tsx`
- Modify: `packages/tui/src/ui/useMouseScroll.ts`
- Test: `packages/tui/src/ui/scrollSchedule.test.ts`

**Interfaces:**
- Produces: `useViewportScroll()` 返回 `scrollOffset`、`scrollBy()`、`resetToBottom()`、`handleScrollBounds()`。
- Consumes: `useMouseScroll()` 已合并的一帧净位移。

- [ ] **Step 1: 写假 TTY ANSI 失败测试**

```tsx
expect(stdout.writes.some((chunk) => chunk.includes(ansiEscapes.clearTerminal))).toBe(false);
```

- [ ] **Step 2: 运行测试确认当前全屏根高度触发 clearTerminal**

Run: `npm test -- packages/tui/src/app/fullscreenOutput.test.tsx --run`
Expected: FAIL，捕获至少一次 `clearTerminal`。

- [ ] **Step 3: AppShell 使用 `rows - 1`，scroll state 抽到单一 hook**

```tsx
const shellRows = resolveShellRows(rows);
return <Box width={columns} height={shellRows}>{children}</Box>;
```

- [ ] **Step 4: 删除 App 的第二层 ScrollScheduler**

```ts
const scrollBy = useCallback((delta: number) => {
  setScrollOffset((current) => clampScroll(current + delta, maxRef.current));
}, []);
```

- [ ] **Step 5: 运行 ANSI、滚动和 App 测试**

Run: `npm test -- packages/tui/src/app/fullscreenOutput.test.tsx packages/tui/src/ui/scrollSchedule.test.ts packages/tui/src/App.test.tsx --run`
Expected: PASS。

### Task 5: 稳定 PaintLayout 并批处理流式更新

**Files:**
- Create: `packages/tui/src/app/messageUpdateBuffer.ts`
- Create: `packages/tui/src/app/messageUpdateBuffer.test.ts`
- Modify: `packages/tui/src/ui/messagePaint.ts`
- Modify: `packages/tui/src/ui/messagePaint.test.ts`
- Modify: `packages/tui/src/ui/MessageViewport.tsx`
- Modify: `packages/tui/src/App.tsx`

**Interfaces:**
- Produces: `buildPaintLayout()`、`windowPaintLayout()`；`createMessageUpdateBuffer()` 的 `enqueue(id, text)`、`flush()`、`cancel()`。
- Consumes: `MessagePaintCache` 和现有 `ChatMessage[]`。

- [ ] **Step 1: 写 paint layout 与 buffer 失败测试**

```ts
const layout = buildPaintLayout({ messages, columns: 80, paintCache });
windowPaintLayout({ layout, viewportRows: 20, scrollOffset: 0 });
windowPaintLayout({ layout, viewportRows: 20, scrollOffset: 10 });
expect(paintCount).toBe(messages.length);

buffer.enqueue(7, 'a');
buffer.enqueue(7, 'ab');
frame.flush();
expect(onFlush).toHaveBeenCalledWith(new Map([[7, 'ab']]));
```

- [ ] **Step 2: 运行测试确认新接口不存在**

Run: `npm test -- packages/tui/src/ui/messagePaint.test.ts packages/tui/src/app/messageUpdateBuffer.test.ts --run`
Expected: FAIL，缺少新导出。

- [ ] **Step 3: 构建稳定 PaintLayout，并仅在 offset 变化时窗口切片**

```ts
const layout = useMemo(
  () => buildPaintLayout({ messages, columns, streamingMessageId, paintCache }),
  [messages, columns, streamingMessageId]
);
const windowed = useMemo(
  () => windowPaintLayout({ layout, viewportRows, scrollOffset }),
  [layout, viewportRows, scrollOffset]
);
```

- [ ] **Step 4: 流式增量按 32ms 合并并在边界强制 flush**

```ts
buffer.enqueue(messageId, fullText);
// turn-start、tools-start、result、catch 和 unmount 前调用 flush/cancel
```

- [ ] **Step 5: 运行 TUI 测试和类型检查**

Run: `npm test -- packages/tui --run`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

### Task 6: 全量验证

**Files:**
- Modify: `README.md`，同步说明 TUI 的安全全屏高度、单层滚动调度和 paint layout 缓存。

**Interfaces:**
- Consumes: Task 1-5 的最终实现。
- Produces: 可复现的验证记录。

- [ ] **Step 1: 运行全量测试**

Run: `npm test -- --run`
Expected: 全部测试 PASS，0 failures。

- [ ] **Step 2: 运行类型和 diff 检查**

Run: `npm run typecheck`
Expected: PASS。

Run: `git diff --check`
Expected: 无输出，exit 0。

- [ ] **Step 3: 检查核心文件规模和工作区边界**

Run: `wc -l packages/core/src/runtime/agentRuntime.ts packages/tui/src/App.tsx`
Expected: 两个文件均显著小于重构前的 1476 行和 1314 行。

