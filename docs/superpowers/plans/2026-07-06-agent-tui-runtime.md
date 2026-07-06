# Agent TUI Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable TypeScript foundation for an interactive local agent TUI with a normal agent mode and an extensible cross-repo mode.

**Architecture:** The project starts as a small npm workspace with focused packages. `@local-agent/core` owns typed domain protocols, trace storage, mode planning, and runtime orchestration. `@local-agent/tui` owns the interactive terminal shell and subscribes to core runtime events.

**Tech Stack:** TypeScript, Node.js, Vitest, Zod, Ink, React, tsx.

---

## File Structure

- Create `package.json`: npm workspace commands and dependency versions.
- Create `tsconfig.base.json`: shared strict TypeScript compiler options.
- Create `vitest.config.ts`: test discovery for all packages.
- Create `packages/core/package.json`: core package entrypoints.
- Create `packages/core/src/domain.ts`: shared zod schemas and TypeScript types for runs, tasks, modes, trace events, and agent results.
- Create `packages/core/src/trace/traceStore.ts`: JSONL trace writer and reader.
- Create `packages/core/src/modes/modeDetector.ts`: normal vs cross-repo mode detection.
- Create `packages/core/src/runtime/agentRuntime.ts`: event-driven runtime that produces a minimal plan, trace events, approval gates, and a final report.
- Create `packages/core/src/index.ts`: public exports.
- Create `packages/core/src/**/*.test.ts`: behavior-first tests for core modules.
- Create `packages/tui/package.json`: TUI package entrypoints.
- Create `packages/tui/src/App.tsx`: interactive Ink UI.
- Create `packages/tui/src/main.tsx`: executable bootstrap.
- Create `packages/tui/src/App.test.tsx`: rendering tests for the TUI shell.
- Create `README.md`: startup instructions and current MVP scope.

## Task 1: Bootstrap Testable TypeScript Workspace

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `packages/core/package.json`
- Create: `packages/tui/package.json`

- [ ] **Step 1: Create workspace configuration**

Add npm workspace scripts for build, test, typecheck, and TUI development.

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: lockfile created and dependencies installed.

- [ ] **Step 3: Verify empty test baseline**

Run: `npm test -- --run`
Expected: Vitest starts successfully and reports no test files or exits without failures once test files exist.

## Task 2: Define Core Domain Protocols With Tests

**Files:**
- Create: `packages/core/src/domain.test.ts`
- Create: `packages/core/src/domain.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing schema tests**

Tests cover cross-repo project registry parsing, trace event parsing, and subagent result parsing.

- [ ] **Step 2: Run failing tests**

Run: `npm test -- packages/core/src/domain.test.ts --run`
Expected: fails because `domain.ts` does not exist yet.

- [ ] **Step 3: Implement minimal schemas**

Define zod schemas for `AgentMode`, `RepoConfig`, `ProjectRegistry`, `TraceEvent`, `TaskNode`, `AgentResult`, and `SubagentResult`.

- [ ] **Step 4: Run passing tests**

Run: `npm test -- packages/core/src/domain.test.ts --run`
Expected: all domain tests pass.

## Task 3: Implement JSONL Trace Store With Tests

**Files:**
- Create: `packages/core/src/trace/traceStore.test.ts`
- Create: `packages/core/src/trace/traceStore.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing trace tests**

Tests cover appending events, reading them back in order, and creating run directories automatically.

- [ ] **Step 2: Run failing tests**

Run: `npm test -- packages/core/src/trace/traceStore.test.ts --run`
Expected: fails because `JsonlTraceStore` is missing.

- [ ] **Step 3: Implement trace store**

Use Node `fs/promises` and zod validation to persist one event per JSONL line.

- [ ] **Step 4: Run passing tests**

Run: `npm test -- packages/core/src/trace/traceStore.test.ts --run`
Expected: trace tests pass.

## Task 4: Implement Mode Detection With Tests

**Files:**
- Create: `packages/core/src/modes/modeDetector.test.ts`
- Create: `packages/core/src/modes/modeDetector.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing mode tests**

Tests cover explicit mode preservation, auto detection for front/back/admin linkage, and normal fallback.

- [ ] **Step 2: Run failing tests**

Run: `npm test -- packages/core/src/modes/modeDetector.test.ts --run`
Expected: fails because `detectMode` is missing.

- [ ] **Step 3: Implement detector**

Use lightweight keyword heuristics first; keep the return type structured so an LLM planner can replace it later.

- [ ] **Step 4: Run passing tests**

Run: `npm test -- packages/core/src/modes/modeDetector.test.ts --run`
Expected: mode tests pass.

## Task 5: Implement Minimal Agent Runtime With Tests

**Files:**
- Create: `packages/core/src/runtime/agentRuntime.test.ts`
- Create: `packages/core/src/runtime/agentRuntime.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing runtime tests**

Tests cover normal run event ordering, cross-repo run emitting an impact-map placeholder, and approval-required events before execution.

- [ ] **Step 2: Run failing tests**

Run: `npm test -- packages/core/src/runtime/agentRuntime.test.ts --run`
Expected: fails because `AgentRuntime` is missing.

- [ ] **Step 3: Implement runtime**

Implement an event emitter based runtime that accepts user input, detects mode, emits trace events, records them, and returns a structured report.

- [ ] **Step 4: Run passing tests**

Run: `npm test -- packages/core/src/runtime/agentRuntime.test.ts --run`
Expected: runtime tests pass.

## Task 6: Implement Interactive TUI Shell With Tests

**Files:**
- Create: `packages/tui/src/App.test.tsx`
- Create: `packages/tui/src/App.tsx`
- Create: `packages/tui/src/main.tsx`

- [ ] **Step 1: Write failing TUI tests**

Tests cover initial shell rendering, command hint visibility, and a submitted message appearing in conversation history.

- [ ] **Step 2: Run failing tests**

Run: `npm test -- packages/tui/src/App.test.tsx --run`
Expected: fails because TUI files are missing.

- [ ] **Step 3: Implement TUI shell**

Use Ink components for header, task tree placeholder, conversation panel, status line, and text input.

- [ ] **Step 4: Run passing tests**

Run: `npm test -- packages/tui/src/App.test.tsx --run`
Expected: TUI tests pass.

## Task 7: Document Current MVP

**Files:**
- Create: `README.md`

- [ ] **Step 1: Document install and run commands**

Explain `npm install`, `npm test`, `npm run typecheck`, and `npm run dev`.

- [ ] **Step 2: Document architecture boundaries**

Explain normal mode, cross-repo mode, trace, and planned codegraph adapter.

- [ ] **Step 3: Run final verification**

Run: `npm test -- --run && npm run typecheck`
Expected: all tests and typechecks pass.
