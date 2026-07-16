# Project Instructions MVP Implementation Plan

> **状态：实施完成。** 2026-07-16 按 Task 1-5 落地并通过全量验证。

**Goal:** 让 Kross 的主 agent、Task 子代理和 conductor worker 自动发现并遵守工作区级项目指令，避免用户每次重复说明仓库规范、验证命令和行为边界。

**Architecture:** 在 `workspace` 层新增纯指令加载器，负责真实路径校验、确定性优先级、大小预算和诊断。`SessionServices` 将结果同步为 pinned `SessionContext` sources；subagent 按自己的执行 root 独立加载。TUI 增加 `/instructions` 只读命令，展示来源、优先级、截断和跳过原因。

**Tech Stack:** TypeScript、Node `fs`/`path`、现有 `WorkspaceRoots`、`SessionContext`、`AgentRuntime`、Vitest、Ink TUI。

---

## Scope

### 本计划实现

- 自动发现每个已授权 workspace root 下的 `CLAUDE.md`、`AGENTS.md`、`KROSS.md`。
- 主 workspace 与 `/add-dir` roots 分别加载、分别标注作用域。
- 使用 `realpath` 校验，拒绝 symlink 越出所属 root。
- 对单文件、文件数和总字节数设置硬上限，超限时安全截断并产生诊断。
- 主 agent 每轮构建 context 前刷新项目指令。
- Task 子代理和 conductor worker 只加载自身执行 root 的指令。
- `/instructions` 查看当前加载状态；`/context` 继续展示 source/token 占用。
- README、架构文档、层边界测试同步。

### Out of scope

- 不实现 Skills 发现、触发和正文加载。
- 不递归扫描任意嵌套目录中的 `AGENTS.md`。
- 不实现按目标文件动态激活嵌套规则的 per-file scope。
- 不增加自定义文件名、ignore glob 或配置项。
- 不实现 ApplyPatch、Undo、Todo 持久化、Headless CLI、MCP resources/prompts。
- 不扩大 workspace 边界，不为了读取父级规则自动提升到 Git 根目录。

> MVP 只加载每个 workspace root 的根级指令。嵌套目录规则留给 Project Instructions P1，避免第一版引入“目标文件尚未确定时该注入哪份规则”的歧义。

---

## Product Semantics

### 优先级

低优先级先注入，高优先级后注入；同一个 root 内发生冲突时，后出现的规则覆盖前面的规则：

```text
CLAUDE.md < AGENTS.md < KROSS.md
```

- `CLAUDE.md` 是兼容来源。
- `AGENTS.md` 是跨 agent 的通用仓库约定。
- `KROSS.md` 是 Kross 专属覆盖层。

### 多 workspace

- 主 root 优先，额外 roots 保持 `WorkspaceRoots.list()` 顺序。
- 每份指令写明 `rootId`、root path 和 filename。
- 额外 root 的规则明确声明只适用于该 `rootId`。
- 主 agent 可以看到所有 root 的带作用域规则。
- Task/conductor worker 只看到实际执行 root 的规则，禁止跨仓库污染。

### 固定安全预算

| 限制 | 默认值 | 行为 |
|---|---:|---|
| 最大文件数 | 16 | 超出后按 root/优先级确定性保留 |
| 单文件最大字节 | 32 KiB | 保留 head + tail，中间插入截断标记 |
| 全部最大字节 | 64 KiB | 主 root、高优先级文件优先占用预算 |
| 编码 | UTF-8 | 无法安全读取时跳过并记录诊断 |

细则：

- 使用字节数执行硬限制，截断不能产生 `�`。
- 空文件不注入，但在 `/instructions` 中显示 skipped/empty。
- 文件不存在是正常状态，不产生 warning。
- symlink 越界、非普通文件和读取失败产生 warning。
- 总量分配按高优先级保留，最终渲染再恢复为低到高覆盖顺序。

### 刷新与持久化

- Runtime 构造时加载一次。
- 每个主 agent turn、`/context`、`/instructions` 前刷新。
- `/add-dir`、`/remove-dir` 成功后立即刷新。
- 使用内容 signature；无变化时不重复重建 sources。
- 项目指令不写入 `SessionContextState`，恢复历史会话时始终读取磁盘当前版本。

---

## Target Files

| Path | Responsibility |
|---|---|
| `packages/core/src/workspace/projectInstructions.ts` | 纯 loader、types、priority、budget、source formatter |
| `packages/core/src/workspace/projectInstructions.test.ts` | 路径、顺序、预算、多 root 测试 |
| `packages/core/src/runtime/sessionServices.ts` | 主 runtime refresh、source lifecycle、snapshot cache |
| `packages/core/src/runtime/agentRuntime.ts` | 公开只读/刷新委托 |
| `packages/core/src/runtime/subagentRunner.ts` | child root 指令注入 |
| `packages/core/src/runtime/subagentRunner.test.ts` | 子代理 root 隔离测试 |
| `packages/core/src/index.ts` | 公共 types/functions 导出 |
| `packages/tui/src/app/appCommands.ts` | `/instructions` 命令 |
| `packages/tui/src/app/appCommands.instructions.test.ts` | 状态格式化测试 |
| `packages/tui/src/ui/slashCommands.ts` | slash 注册 |
| `packages/core/src/i18n/catalog.ts` | 中英文文案 |
| `README.md` | 能力、限制和命令说明 |

依赖方向：

```text
workspace/projectInstructions (fs/path + plain types)
       ↑                         ↑
SessionServices             subagentRunner
       ↑
AgentRuntime
       ↑
TUI /instructions
```

`projectInstructions.ts` 禁止 import `runtime`、`tui` 或 `SessionContext`。

---

## Proposed API

```ts
export const PROJECT_INSTRUCTION_FILENAMES = [
  'CLAUDE.md',
  'AGENTS.md',
  'KROSS.md'
] as const;

export interface ProjectInstructionRoot {
  id: string;
  path: string;
  primary: boolean;
}

export interface ProjectInstructionFile {
  sourceId: string;
  rootId: string;
  rootPath: string;
  filename: (typeof PROJECT_INSTRUCTION_FILENAMES)[number];
  path: string;
  relativePath: string;
  precedence: number;
  content: string;
  originalBytes: number;
  injectedBytes: number;
  truncated: boolean;
}

export interface ProjectInstructionDiagnostic {
  rootId: string;
  path: string;
  code:
    | 'outside-root'
    | 'not-file'
    | 'read-failed'
    | 'empty'
    | 'file-limit'
    | 'total-limit';
  message: string;
}

export interface ProjectInstructionsSnapshot {
  files: ProjectInstructionFile[];
  diagnostics: ProjectInstructionDiagnostic[];
  totalOriginalBytes: number;
  totalInjectedBytes: number;
  signature: string;
}

export function loadProjectInstructions(input: {
  roots: ProjectInstructionRoot[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}): ProjectInstructionsSnapshot;

export function formatProjectInstructionSource(
  file: ProjectInstructionFile
): string;
```

Runtime public API：

```ts
refreshProjectInstructions(): ProjectInstructionsSnapshot;
getProjectInstructions(): ProjectInstructionsSnapshot;
```

`getProjectInstructions()` 纯读；只有 `refreshProjectInstructions()` 读取磁盘并同步 sources。

---

## Execution Order

```text
Task 1 纯 loader
  → Task 2 主 runtime 注入
    → Task 3 subagent/worker 注入
      → Task 4 TUI 可观测性与多目录刷新
        → Task 5 文档、边界守护、全量验证
```

---

## Task 1: 纯 Project Instructions Loader

**Files:**

- Create: `packages/core/src/workspace/projectInstructions.ts`
- Create: `packages/core/src/workspace/projectInstructions.test.ts`
- Modify: `packages/core/src/index.ts`

- [x] **Step 1: 先写失败测试**

覆盖：

1. 无文件返回空 snapshot。
2. 单个 `AGENTS.md` 的 rootId/path/content 正确。
3. 三文件最终渲染顺序为 CLAUDE、AGENTS、KROSS。
4. 多 roots 的 sourceId 唯一且主 root 在前。
5. 空文件、目录候选分别产生 `empty`、`not-file`。
6. symlink 指向 root 外产生 `outside-root`。
7. symlink 指向 root 内普通文件允许加载。
8. 单文件超限时 head/tail 均保留。
9. 总量超限时主 root/高优先级文件优先。
10. 中文在截断边界不出现 `�`。

```bash
npm test -- --run packages/core/src/workspace/projectInstructions.test.ts
```

Expected: FAIL（模块不存在）。

- [x] **Step 2: 实现候选发现和真实路径边界**

- roots：primary 优先，added 保持输入顺序。
- 候选仅为 `<root>/<filename>`，不递归。
- canonical root 与 candidate realpath 做边界比较。
- 最终目标必须是普通文件。
- sourceId 示例：`project-instruction:<rootId>:AGENTS.md`。

- [x] **Step 3: 实现 UTF-8 安全预算**

实现内部 `truncateUtf8HeadTail(buffer, maxBytes)`。截断标记包含原始字节数，方便诊断。

- [x] **Step 4: 实现 source formatter**

每个 block 包含：root scope、source、precedence 和正文；额外 root 明确声明规则只适用于该 root。

- [x] **Step 5: 验证并提交**

```bash
npm test -- --run packages/core/src/workspace/projectInstructions.test.ts
npm run typecheck
git diff --check
git add packages/core/src/workspace/projectInstructions.ts \
  packages/core/src/workspace/projectInstructions.test.ts packages/core/src/index.ts
git commit -m "feat(context): add project instruction loader"
```

---

## Task 2: 注入主 AgentRuntime / SessionContext

**Files:**

- Modify: `packages/core/src/runtime/sessionServices.ts`
- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Modify: `packages/core/src/runtime/agentRuntime.test.ts`
- Create: `packages/core/src/runtime/sessionServices.test.ts`

- [x] **Step 1: 写 Runtime 注入测试**

覆盖：构造即加载、included/pinned sources、正文进入 system messages、修改后 refresh、删除后旧 source 消失、无文件行为不变、恢复 session 后使用磁盘当前规则。

- [x] **Step 2: SessionServices 管理 lifecycle**

新增 snapshot 和上一轮 sourceIds。Refresh 流程：

1. 从 `workspaceRoots.list()` 构造 roots；没有 roots 时回退 `options.workspaceRoot`。
2. 调用纯 loader。
3. signature 未变直接返回。
4. remove 旧 source ids。
5. 按覆盖顺序 addSource：`kind=repo`、`priority=99`、`pinned=true`。
6. 更新 snapshot/sourceIds。

- [x] **Step 3: AgentRuntime 只做委托**

新增 `refreshProjectInstructions()`、`getProjectInstructions()`；constructor、`buildPlannerContext()`、`resolveContextBuildInput()` 调用刷新。不得把 loader 逻辑写回 AgentRuntime。

- [x] **Step 4: ContextState schema 不变**

确认指令不写入 thread checkpoint；旧会话恢复后从磁盘重建。

- [x] **Step 5: 验证并提交**

```bash
npm test -- --run packages/core/src/runtime/agentRuntime.test.ts \
  packages/core/src/context/sessionContext.test.ts
npm run typecheck
git diff --check
git add packages/core/src/runtime/sessionServices.ts \
  packages/core/src/runtime/agentRuntime.ts \
  packages/core/src/runtime/agentRuntime.test.ts \
  packages/core/src/runtime/sessionServices.test.ts
git commit -m "feat(runtime): inject workspace project instructions"
```

---

## Task 3: Task 子代理和 Conductor Worker

**Files:**

- Modify: `packages/core/src/runtime/subagentRunner.ts`
- Modify: `packages/core/src/runtime/subagentRunner.test.ts`

- [x] **Step 1: 写 root 隔离测试**

覆盖：主 root Task、`/add-dir` worker、无指令 root、symlink escape、首次 complete messages 含规则、主 transcript 不泄漏正文、既有 abort/stall/soft-land 不变。

- [x] **Step 2: Child SessionContext 注入**

在最终 workspaceRoot 确定后调用同一 loader，只传当前 child root，复用 Task 1 formatter 和 limits。

- [x] **Step 3: Trace 只记录 provenance**

subagent lifecycle trace 增加 filename/rootId/truncated/injectedBytes 和诊断数量，不记录完整正文。

- [x] **Step 4: 验证并提交**

```bash
npm test -- --run packages/core/src/runtime/subagentRunner.test.ts \
  packages/core/src/runtime/completeToolLoop.test.ts
npm run typecheck
git diff --check
git add packages/core/src/runtime/subagentRunner.ts \
  packages/core/src/runtime/subagentRunner.test.ts
git commit -m "feat(subagent): load scoped project instructions"
```

---

## Task 4: `/instructions` 与多目录刷新

**Files:**

- Modify: `packages/tui/src/app/appCommands.ts`
- Create: `packages/tui/src/app/appCommands.instructions.test.ts`
- Modify: `packages/tui/src/ui/slashCommands.ts`
- Modify: `packages/tui/src/ui/slashCommands.test.ts`
- Modify: `packages/core/src/i18n/catalog.ts`
- Modify: `packages/tui/src/App.test.tsx`（仅必要集成用例）

- [x] **Step 1: 定义状态输出**

只展示文件 provenance、precedence、bytes、truncated 和 diagnostics，不打印正文。

```text
Project instructions
loaded: 2 files, 12.4K / 64K bytes
1. root=agent source=AGENTS.md precedence=20 bytes=8.1K
2. root=agent source=KROSS.md precedence=30 bytes=4.3K truncated
```

- [x] **Step 2: 注册 `/instructions` 和中英文文案**

补 slash help、suggestion 和 i18n 测试。

- [x] **Step 3: 命令前 refresh**

`/instructions` 调用 `runtime.refreshProjectInstructions()` 后格式化 snapshot。

- [x] **Step 4: add/remove-dir 后 refresh**

在现有 `runtime.syncProjectRegistrySource()` 成功分支旁调用 refresh；测试新增 root 立即出现、移除后立即消失、失败不改变 snapshot。

- [x] **Step 5: `/context` 回归**

确认 included/pinned sources 和 contributor tokens 出现指令 source，但不会复制完整正文到命令输出。

- [x] **Step 6: 验证并提交**

```bash
npm test -- --run packages/tui/src/app/appCommands.instructions.test.ts \
  packages/tui/src/ui/slashCommands.test.ts packages/tui/src/App.test.tsx
npm run typecheck
git diff --check
git add packages/tui/src/app/appCommands.ts \
  packages/tui/src/app/appCommands.instructions.test.ts \
  packages/tui/src/ui/slashCommands.ts packages/tui/src/ui/slashCommands.test.ts \
  packages/core/src/i18n/catalog.ts packages/tui/src/App.test.tsx
git commit -m "feat(tui): inspect loaded project instructions"
```

---

## Task 5: 边界守护、文档和最终验证

**Files:**

- Create: `packages/core/src/workspace/layerBoundaries.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-16-architecture-hardening-design.md`
- Modify: 本计划 checkbox（实施完成后）

- [x] **Step 1: 层边界测试**

确保 loader 不 import runtime/TUI/SessionContext；TUI 只通过 AgentRuntime public API 获取 snapshot。

- [x] **Step 2: README 校准**

- 新增 Project Instructions、三文件优先级、root-level scope、预算与 `/instructions`。
- 说明 multi-root/worker 隔离。
- 将当前“技能正文触发加载”描述校准为真实状态，不把尚未实现的 Skills loader 写成完成态。

- [x] **Step 3: 架构文档**

记录纯 loader、SessionServices source lifecycle、subagent root isolation，以及“指令不持久化、恢复时从磁盘重建”的不变量。

- [x] **Step 4: 全量验证**

```bash
npm test -- --run
npm run typecheck
npm run build
git diff --check
```

人工验收：无文件兼容、首次请求有规则、修改后下一轮生效、add-dir worker 隔离、`/instructions` 不显示正文、`/context` 可见 source、resume 使用磁盘最新规则。

- [x] **Step 5: 最终提交**

```bash
git add README.md docs/superpowers/specs/2026-07-16-architecture-hardening-design.md \
  docs/superpowers/plans/2026-07-16-project-instructions-mvp.md \
  packages/core/src/workspace/layerBoundaries.test.ts
git commit -m "docs: record project instruction loading semantics"
```

---

## Acceptance Criteria

- [x] 主 agent 首次请求收到主 root 指令。
- [x] 多 root 规则带明确 scope。
- [x] Task/conductor worker 只收到执行 root 指令。
- [x] `CLAUDE.md < AGENTS.md < KROSS.md` 有测试锁定。
- [x] symlink escape 无法把 root 外内容注入 prompt。
- [x] 文件数、单文件和总量限制均有测试。
- [x] UTF-8 截断不破坏中文。
- [x] 修改/删除文件后下一轮自动反映。
- [x] session checkpoint 不持久化旧指令正文。
- [x] `/instructions` 可解释 loaded/truncated/skipped，但不显示正文。
- [x] 无指令仓库完全兼容。
- [x] 全量 test/typecheck/build/diff-check 通过。

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| pinned 指令挤占 context | 64 KiB 总硬上限，命令展示占用 |
| 多 root 规则冲突 | block 带 root scope，worker 只加载执行 root |
| symlink 读取敏感文件 | canonical realpath + root boundary |
| refresh 后旧规则残留 | sourceIds diff，先 remove 再 add |
| 每轮刷新产生读盘 | 每个 root 仅 3 个固定候选、总文件数最多 16；signature 避免 source 重建，纯读 get 不触发 refresh |
| README 过度声明 Skills | 本轮同步校准为 metadata 容器 |
| 仓库指令含恶意 prompt | MVP 视为 workspace-owned 配置；网络/MCP 扩展前另做 untrusted-content guardrails |

---

## Follow-up After MVP

1. Project Instructions P1：嵌套 `AGENTS.md` per-file scope。
2. Skills MVP：`.agents/skills` / `~/.kross/skills` metadata discovery + `ReadSkill`。
3. Safe Mutation：ApplyPatch、preimage journal、`/undo <runId>`。
4. Durable Work State：Todo/pending execution 写入 session JSONL。
5. Process Tools：后台进程、poll、stdin、kill。
