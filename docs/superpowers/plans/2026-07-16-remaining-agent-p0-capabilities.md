# Remaining Agent P0 Capabilities Implementation Plan

> **状态：已完成。** Phase A-D 已实现；最终全量门禁通过（107 个测试文件、601 个测试，typecheck、build、diff-check 全部成功）。

**Goal:** 补齐 Kross 作为日常本地开发 agent 仍缺少的四个基础闭环：可发现并按需加载 Skills、安全且可撤销的文件修改、可跨重启恢复的工作状态、可管理的后台进程。

**Baseline:** Project Instructions、主/子 agent 工具环、审批、中断、会话 JSONL、Todo 内存态、文件/Git/Bash 工具均已实现。当前基线为 `main@9a305ca`，98 个测试文件、567 个测试通过。

---

## 1. P0 范围与优先级

| 顺序 | 能力 | 当前缺口 | P0 完成态 |
|---:|---|---|---|
| 1 | Skills MVP | `SessionContext` 只有 skills 容器，没有发现、触发和正文读取 | 项目/个人 Skills 可发现，metadata 常驻，正文按需安全读取 |
| 2 | Safe Mutation | Write/Edit/Delete/Move 无统一变更事务，不能可靠撤销 | 新增 ApplyPatch；所有文件写工具记录 pre/post image；支持冲突安全 `/undo` |
| 3 | Durable Work State | Todo、等待确认的 plan/conductor 只活在内存 | Todo 与 pending execution 写入 session JSONL，重启后恢复 |
| 4 | Process Tools | Bash 只能前台等待完整结果 | 后台启动、poll、stdin、kill、进程列表形成完整生命周期 |

推荐按表中顺序实施。四项之间没有强耦合，但 Safe Mutation 会影响所有写工具，Durable Work State 会扩展 session schema，均应在 Process Tools 之前完成，减少后续交叉改造。

### 本轮明确不做

- Project Instructions P1：嵌套 `AGENTS.md` 与 per-file scope。
- Headless/non-interactive CLI 与 CI runner。
- OS 级 Bash/进程沙箱、容器隔离和网络隔离。
- MCP resources/prompts、HTTP/SSE transport、MCP 热重载。
- 跨 session memory、embedding/FTS 检索。
- 自动下载安装第三方 Skills 或执行未审批的 skill scripts。
- 强制覆盖式 undo、跨 workspace undo、Git commit/rebase undo。
- 后台进程跨 Kross 重启重连。

---

## 2. 统一架构约束

```text
discovery / storage / process primitives
            ↓
core host composition root
            ↓
AgentRuntime public APIs + ToolGateway tools
            ↓
TUI commands / panels
```

必须保持以下不变量：

1. 纯 loader/store 不依赖 `AgentRuntime` 或 TUI。
2. TUI 只通过 core public API 读写状态，不直接解析 Skills、mutation journal 或 process internals。
3. 所有文件路径继续使用 canonical `realpath` 与 workspace allowlist；新增能力不能绕过现有边界。
4. 高风险行为仍经过 Tool Gateway：文件修改为 `write`，启动/写入/终止进程为 `execute`。
5. trace 只保存 provenance、摘要和有限 preview；skill 正文、完整文件 preimage、进程完整输出不得进入 trace。
6. 所有长操作接收 `AbortSignal`；中断必须有明确终态，不能遗留 open turn 或失控子进程。
7. JSONL 是持久化事实源；SQLite 继续只做可重建投影。

---

# P0-A: Skills MVP

## 3. 产品语义

### 3.1 发现位置

按低到高优先级发现：

```text
~/.kross/skills/<skill-id>/SKILL.md
<workspace-root>/.agents/skills/<skill-id>/SKILL.md
```

- 个人 Skills 对所有 workspace 可见。
- 项目 Skills 只作用于所属 root；同 id 时项目 Skill 覆盖个人 Skill。
- 主 agent 看到个人 Skills 和所有 workspace roots 的带 scope metadata。
- Task/conductor worker 只看到个人 Skills 与自己的执行 root Skills。
- MVP 不递归扫描任意深度，只接受 `<skills-dir>/<id>/SKILL.md`。

### 3.2 Metadata 与正文

- `SKILL.md` 可使用 YAML frontmatter：`name`、`description`。
- `id` 来自目录名；`name` 缺失时回退为 id。
- `description` 缺失时使用正文首个非空段落的安全截断版本。
- system prompt 只注入 id/name/description/location/scope，不常驻正文。
- 模型需要使用 Skill 时调用 `ReadSkill`；用户明确点名 Skill 时，system metadata 要求模型优先读取。
- `ReadSkill` 支持 `id` 和可选 `resource`：默认读 `SKILL.md`，resource 只能是 Skill 目录内相对路径。

### 3.3 安全与预算

| 限制 | 默认值 |
|---|---:|
| metadata 数量 | 64 |
| 单 metadata description | 1 KiB |
| 单次正文/资源读取 | 64 KiB |
| 单轮累计 Skill 内容 | 128 KiB |

- personal Skill 虽位于 workspace 外，也只能由专用 `ReadSkill` 读取。
- canonical target 必须位于已登记的 Skill root 内；拒绝 symlink escape、目录和非 UTF-8 文件。
- `ReadSkill` 是 `read` 风险，不执行脚本、不安装依赖、不访问网络。
- Skill 中的 scripts/assets 只是资源；需要执行脚本时仍必须显式调用 Bash 并走 `execute` 审批。

## 4. Proposed API

```ts
interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  rootId: string | 'personal';
  scope: 'personal' | 'workspace';
  directory: string;
  entryPath: string;
  precedence: number;
}

interface SkillsSnapshot {
  skills: SkillDescriptor[];
  diagnostics: SkillDiagnostic[];
  signature: string;
}

discoverSkills(input: {
  roots: ProjectInstructionRoot[];
  personalSkillsDir?: string;
}): SkillsSnapshot;
```

`ReadSkill` input：

```ts
{ id: string; rootId?: string; resource?: string; offset?: number; limit?: number }
```

## 5. Target Files

- Create `packages/core/src/skills/skillDiscovery.ts`
- Create `packages/core/src/skills/skillDiscovery.test.ts`
- Create `packages/core/src/skills/skillRegistry.ts`
- Create `packages/core/src/tools/builtin/readSkill.ts`
- Modify `packages/core/src/context/sessionContext.ts`
- Modify `packages/core/src/runtime/sessionServices.ts`
- Modify `packages/core/src/runtime/subagentRunner.ts`
- Modify `packages/core/src/host/createAgentHost.ts`
- Modify `packages/core/src/index.ts`
- Add TUI `/skills` provenance command and i18n

## 6. Acceptance Criteria

- [x] personal/project Skill 发现、覆盖顺序和多 root scope 有测试。
- [x] metadata 进入主 agent 首次 system message，正文不进入。
- [x] `ReadSkill` 读取正文与资源，offset/limit 和 UTF-8 预算有效。
- [x] personal Skill 可由专用工具读取，但普通 Read 仍不能越出 workspace。
- [x] symlink escape、非法编码、重复 id、缺 metadata 产生可解释诊断。
- [x] subagent 只看到 personal + 当前 root Skills。
- [x] `/skills` 不打印正文。

---

# P0-B: Safe Mutation / ApplyPatch / Undo

## 7. 产品语义

### 7.1 ApplyPatch

新增原生 `ApplyPatch` 写工具，接受统一 patch 文本，支持：

- 新建文件。
- 修改现有文件。
- 删除文件。
- 单次 patch 跨多个文件。

处理流程固定为：解析全部 patch → 校验全部路径与 precondition → 生成全部 preimage → 内存中计算结果 → 原子落盘 → 写 mutation journal。任一步失败时不允许留下部分文件修改。

P0 不支持二进制 patch、Git rename metadata、文件权限修改和 fuzz 模糊匹配。hunk 上下文不匹配时明确失败，模型应重新 Read 后生成 patch。

### 7.2 统一 Mutation Journal

Undo 不能只覆盖 ApplyPatch；现有 `Write`、`Edit`、`Delete`、`Move` 也必须接入统一 recorder。

每个成功文件事务记录：

```ts
interface MutationRecord {
  transactionId: string;
  runId: string;
  toolCallId?: string;
  toolName: 'ApplyPatch' | 'Write' | 'Edit' | 'Delete' | 'Move';
  workspaceRoot: string;
  createdAt: string;
  files: Array<{
    path: string;
    operation: 'create' | 'modify' | 'delete' | 'move';
    preHash?: string;
    postHash?: string;
    preimageRef?: string;
    postimageRef?: string;
  }>;
}
```

- journal 位于 `~/.kross/mutations/<workspace-key>/`。
- 大正文使用 SHA-256 content-addressed blobs，记录只存 hash/ref。
- journal 与 blobs 不进入 trace 或模型 context。
- 默认保留最近 30 天或 500 个事务；GC 只能删除没有 journal 引用的 blob。

### 7.3 Undo

TUI 增加：

```text
/undo
/undo <runId|transactionId>
```

- 无参数撤销当前 workspace 最近一个尚未撤销的事务。
- 指定 runId 时按逆序撤销该 run 的全部文件事务。
- 执行前要求当前文件 hash 等于 journal 的 postHash；否则报告 conflict 并拒绝整次 undo。
- create 的逆操作是删除；delete 的逆操作是恢复；move 的逆操作恢复源/目标；modify 恢复 preimage。
- undo 本身也写 journal，允许审计，但 P0 不提供 redo。
- 不提供 `--force`；冲突必须由用户或 agent 显式解决。

## 8. 架构落点

```text
file tools / ApplyPatch
  -> MutationTransaction (validate + stage + commit/rollback)
    -> MutationJournal (records + blob store)

TUI /undo
  -> AgentRuntime.undoMutation()
    -> MutationService.undo()
```

Tool Gateway 继续负责审批、timeout、trace；文件事务和 preimage 不塞进 Gateway，避免 Gateway 感知不同工具的路径 schema。

## 9. Target Files

- Create `packages/core/src/mutations/mutationJournal.ts`
- Create `packages/core/src/mutations/mutationTransaction.ts`
- Create `packages/core/src/mutations/mutationService.ts`
- Create `packages/core/src/tools/builtin/applyPatch.ts`
- Modify `write.ts`、`edit.ts`、`delete.ts`、`move.ts`
- Modify builtin tool composition 与 host 注入
- Modify `AgentRuntime`，增加 list/undo public API
- Add TUI `/undo` 与只读确认输出
- Add mutation recovery、rollback、conflict、symlink boundary tests

## 10. Acceptance Criteria

- [x] ApplyPatch 的 create/modify/delete/multi-file 行为有测试。
- [x] 任一 hunk/path 失败时 multi-file patch 零部分写入。
- [x] Write/Edit/Delete/Move/ApplyPatch 均产生 journal。
- [x] preimage 不出现在 trace、TUI 普通输出和模型上下文。
- [x] `/undo` 能恢复五类工具产生的改动。
- [x] postHash 不一致时整次撤销拒绝且不部分回滚。
- [x] symlink escape、workspace 外路径、二进制/超大 patch 被拒绝。
- [x] journal 中断写入后可恢复或标记 incomplete，不把半事务视为可撤销成功项。

---

# P0-C: Durable Work State

## 11. 持久化范围

新增独立于 `SessionContextState` 的 `SessionWorkStateV1`：

```ts
interface SessionWorkStateV1 {
  version: 1;
  todos: TodoItem[];
  pendingModeExecution?: PendingModeExecution;
  sessionMode: AgentMode;
}
```

P0 明确不持久化：

- pending tool approval：其中包含进程内 continuation，重启后不安全。
- permission mode：重启后一律回到 `default`，避免静默恢复高权限。
- LLM client/API key、Skill 正文、Project Instructions 正文。
- 后台进程 handle。

### 11.1 JSONL 事件

扩展 session 事实源：

```text
work-state.updated
```

payload 包含完整、已校验的 `SessionWorkStateV1` 与可选 `contextMessageId`。与 `context.updated` 一样使用 signature 去重；SQLite 不需要新增业务状态列。

### 11.2 保存时机

- TodoWrite 成功后。
- Todo clear/replace 后。
- plan/conductor 进入等待确认、批准、拒绝、清除后。
- `/mode` 或 SetMode 成功后。
- session 切换/退出前做一次 best-effort flush。

### 11.3 恢复语义

恢复顺序：创建 Runtime/Store → 恢复 `SessionContextState` → 恢复 `SessionWorkState` → 同步 todo/mode sources → 恢复 TUI waiting-plan 状态。

- pending plan/conductor 恢复后仍需用户 `/approve`，不能自动执行。
- 恢复的 conductor plan 必须重新校验 workspace roots；缺失 root 时展示风险并阻止批准。
- 损坏或未知版本 work state 降级为空状态，不能阻断消息历史恢复。
- 已完成/已拒绝的 pending execution 必须及时清除，避免下次启动幽灵计划。

## 12. Target Files

- Create `packages/core/src/session/sessionWorkState.ts`
- Modify `packages/core/src/session/sessionStore.ts` 与 tests
- Modify `TodoStore`，增加 hydrate/replace 与变更原因
- Modify `SessionServices`，增加 export/restore 与 change event
- Modify `AgentRuntime` public state API
- Modify `packages/tui/src/app/useAppSession.ts`
- Modify pending plan/conductor TUI 状态恢复测试

## 13. Acceptance Criteria

- [x] Todo、session mode、pending plan/conductor 写入 append-only JSONL。
- [x] 重启恢复后 todo header、context source、mode footer 一致。
- [x] pending execution 恢复后仍等待显式确认，不自动运行。
- [x] approve/reject 后持久化清除，不产生幽灵 pending。
- [x] permission mode 和 pending tool approval 不被恢复。
- [x] 旧 session 与损坏 work-state event 可兼容降级。
- [x] 重复 snapshot 不重复追加 JSONL event。

---

# P0-D: Managed Process Tools

## 14. 工具模型

不扩展现有 Bash 的返回协议，新增 session-scoped `ProcessManager` 和四个工具：

| Tool | Risk | 作用 |
|---|---|---|
| `ProcessStart` | execute | 在 workspace cwd 启动后台命令，立即返回 opaque processId |
| `ProcessPoll` | read | 读取自上次 cursor 之后的 bounded stdout/stderr 与状态 |
| `ProcessWrite` | execute | 向 stdin 写入文本，可选发送 EOF |
| `ProcessKill` | execute | 发送 TERM，超时后升级 KILL |

另提供 `ProcessList`（read）列出当前 session handles；TUI 增加 `/processes` 只读诊断命令。

### 14.1 ProcessStart

```ts
{
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: 'pipe' | 'ignore';
}
```

- cwd 必须在 workspace 内。
- env 只允许在当前进程环境上覆盖显式键；输出/trace 不打印 secret value。
- processId 是随机 opaque id，不暴露或接受任意系统 PID。
- 启动成功不代表命令成功；最终 exit code 由 Poll 返回。

### 14.2 输出与生命周期

- stdout/stderr 分开保存，每个 handle 使用 bounded ring buffer，默认各 1 MiB。
- Poll 使用单调 cursor，返回增量、truncated 标记、exitCode/signal/status。
- 单次 Poll 最多返回 64 KiB，避免污染 context。
- handle 终止后保留摘要 10 分钟，再由 manager GC。
- Kross 正常退出时 TERM 全部活跃进程，等待短 grace period 后 KILL。
- 当前 agent turn 被 ESC 中断不会默认杀死已成功返回 handle 的后台进程；用户或 agent 必须调用 ProcessKill。仍处于启动阶段的 ProcessStart 随 signal 取消。

### 14.3 安全边界

- 与 Bash 一样，P0 只有 cwd 边界，没有 OS sandbox；README 和审批文案必须明确这一点。
- subagent P0 默认不暴露 Process*，避免 worker 留下无人管理的进程。
- ProcessWrite/ProcessKill 必须验证 processId 属于当前 session manager。
- 进程输出按 untrusted tool output 处理，不解析为控制指令。
- trace 记录 command preview、cwd、processId、status、exitCode 和有限 output preview，不记录完整 env/output。

## 15. Target Files

- Create `packages/core/src/process/processManager.ts`
- Create `packages/core/src/process/processManager.test.ts`
- Create `packages/core/src/tools/builtin/processTools.ts`
- Modify builtin registration、permission policy 与 host lifecycle
- Modify trace/TUI tool display summaries
- Add `/processes`、slash help 与 i18n
- Update README Bash/process 安全说明

## 16. Acceptance Criteria

- [x] start → poll → exit 完整链路有真实 child process 测试。
- [x] stdin write/EOF、TERM/KILL、非零退出码有测试。
- [x] cursor 增量读取、ring-buffer 截断和单次返回预算有效。
- [x] workspace cwd 越界和未知 processId 被拒绝。
- [x] env value、完整输出不进入 trace。
- [x] Runtime/host close 能清理全部活跃进程。
- [x] ESC 不误杀已脱离当前 turn 的 managed process。
- [x] subagent 工具列表默认不包含 Process*。

---

## 17. 分阶段执行与提交建议

每个 P0 独立审核、独立提交，避免形成一个无法定位回归的大 patch。

### Phase A: Skills MVP

1. loader + diagnostics + precedence tests。
2. registry + ReadSkill + boundary tests。
3. main/subagent 注入与 `/skills`。
4. README、全量验证。

建议提交：

```text
feat(skills): discover scoped skill metadata
feat(tools): add safe on-demand skill reader
feat(runtime): inject skills into main and child agents
docs: record skills loading semantics
```

### Phase B: Safe Mutation

1. journal/blob store。
2. transaction primitive + ApplyPatch。
3. 既有文件工具接入 recorder。
4. undo service + `/undo`。
5. crash/conflict/security tests。

建议提交：

```text
feat(mutations): add durable mutation journal
feat(tools): add transactional apply patch
refactor(tools): journal builtin file mutations
feat(tui): add conflict-safe undo
```

### Phase C: Durable Work State

1. schema + session JSONL replay。
2. Todo/SessionServices export/restore。
3. TUI save/restore wiring。
4. compatibility and recovery tests。

建议提交：

```text
feat(session): persist agent work state
feat(runtime): restore todos and pending executions
feat(tui): resume durable work state
```

### Phase D: Process Tools

1. ProcessManager lifecycle/ring buffer。
2. five process tools + permission/trace。
3. host close + `/processes`。
4. real-process integration tests 与文档。

建议提交：

```text
feat(process): add managed background process lifecycle
feat(tools): expose process control tools
feat(tui): inspect managed processes
```

---

## 18. 最终门禁

每个 Phase 都必须执行：

```bash
npm test -- --run <target tests>
npm run typecheck
npm run build
git diff --check
```

四个 P0 全部完成后再执行一次全量：

```bash
npm test -- --run
npm run typecheck
npm run build
git diff --check
```

最终人工验收场景：

1. 项目 Skill metadata 首轮可见，正文只在 `ReadSkill` 后进入工具结果。
2. agent 用 ApplyPatch 修改多个文件，`/undo` 完整恢复；人工改动冲突时拒绝撤销。
3. 写入 Todo、生成待确认 plan，退出并重启后仍可见且仍需确认。
4. 启动 dev server，连续 poll 输出、写 stdin、kill，TUI/trace 中无 secret 与无限输出。

---

## 19. P0 完成定义

只有同时满足以下条件，才认为“Agent 基础能力 P0”完成：

- [x] Project Instructions 已实现并保持全量回归通过。
- [x] Skills 具备真实 discovery + scoped metadata + safe on-demand read。
- [x] 所有内置文件修改均可审计，ApplyPatch 原子化，Undo 有 hash conflict guard。
- [x] Todo 与 pending execution 可跨重启恢复，且不恢复高风险权限/审批 continuation。
- [x] 后台进程具备 start/poll/stdin/kill/list/cleanup 全生命周期。
- [x] README 与架构文档只声明真实能力，不把 P1 写成已完成。
- [x] 全量 test/typecheck/build/diff-check 通过。
