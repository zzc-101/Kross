# 2026-08-24 Worker 审查

范围：`worker/` 全量（249 个 TS 文件，约 31k 行，不含测试），分三线审查：
LLM 与扩展子系统（llm / mcp / skills / mutations / verification）、工具子系统
（tools / process / workspace / transport）、会话运行时（session / runtime /
modes / context / agentLoop）。结论来自代码审查，按严重度排列。本轮仅记录，
暂不修改。

## 总体评价

全项目质量最高的模块：测试覆盖密集、边界防护设计成熟。词法 + realpath 双层
路径边界、有界输出缓冲、mutation journal 与回滚、三级 context governor 的
tool_call 配对保护、skill 发现的三级 symlink 校验、审批先缓存的传输细节都很
扎实。主要风险集中在：仓库内的真实密钥、git 工具注入面、失败路径的会话状态
一致性、WS 断线的脆弱性。

## 架构要点

- 运行模型：WS 连回控制面 → claimJob（含 40 条历史）→ context 组装 →
  streaming tool loop → 事件上报 → postReply；空闲时控制面下发 memory.extract
  再休眠容器。
- 权限模型：ToolGateway 动态风险定级 × 三种 permission mode
  （default/classifier/auto），`ask` 挂起等待控制面转发用户审批。
- 上下文治理：tool-aging → turn-compaction → hard-truncation 三级流水线，
  对 tool_call/tool_result 配对的保护到位。
- conductor 子代理模式代码完整但线上 profile `supportsConductor:false`，实际
  禁用回落 auto。

## 严重

| # | 位置 | 问题 | 状态 |
|---|---|---|---|
| S1 | `core/src/llm/publicModels.json:14`、`freeModels.json:12` | 真实 API key 硬编码提交进仓库并打包分发到每台机器，已进 git 历史；`freeModels.ts:47` 还将 key 渲染进展示文本随 UI/日志扩散。应立即轮换并移出仓库。 | 待修 |
| S2 | `core/src/mcp/jsonRpcStdio.ts:90`、`register.ts:538` | MCP stdio 子进程 `{...process.env}` 继承全部环境变量 → 模型 API key 全量泄露给任意 MCP 服务器；cwd 默认 workspaceRoot，`npx xxx-mcp` 可解析到用户可控包。应改 env 白名单。 | 待修 |
| S3 | `core/src/tools/builtin/git.ts:268` | `revision` 直接拼 argv 且不拒绝 `-` 开头。`show` 静态 risk 为 read 在所有模式自动放行，`revision: "--output=/tmp/x"` 即可在 /work 外写文件。同类：`remote` 可注 `--upload-pack=<命令>`，`branch` 可注 switch 选项。所有字符串字段需拒 `-` 开头。 | 待修 |
| S4 | `core/src/runtime/subagentRunner.ts:227` | 子代理按静态 `tool.risk==='read'` 过滤且 approvalPolicy 恒 allow，Git 的动态 resolveRisk 升级被忽略——主会话 default 模式下派 explore 子代理即可免审批执行 git push/checkout/stash pop。过滤应基于 resolveRisk 或显式排除 Git。 | 待修 |
| S5 | `core/src/session/streamingToolLoop.ts:409`、`agentRuntime.ts:1012` | LLM/工具中途失败只 abortTurn 不清悬空 tool call（removeUnmatchedToolCalls 仅在 interruptTurn 执行），aborted turn 参与 buildMessages 违反 provider 协议 → 后续所有请求失败；异常发生在 handler 外时 open turn 卡死，beginTurn 抛错 → 该 agent 所有 job 失败直到容器重启。 | 待修 |

## 高

| # | 位置 | 问题 | 状态 |
|---|---|---|---|
| H1 | `src/transport.ts:190-225,420-444`、`src/agentLoop.ts:150` | WS 断线无重连/ack/补发：emit 抛错 → catch 里 postReply('failed') 再抛 → 进程以 code 1 退出。一次网络抖动 = job 回复丢失 + worker 终止；断线窗口内到达的审批决策也被 rejectAll 清掉。claimJob 本有按需重连能力却未用于事件路径。 | 待修 |
| H2 | `src/agentLoop.ts:93-104` | 心跳协程不感知 in-flight job：控制面在长任务中途返回 shouldSleep 即拔 socket，落入 H1 失败路径。 | 待修 |
| H3 | `core/src/llm/sse.ts:13-39`、`streamableHttp.ts:399`、`jsonRpcStdio.ts:240,322` | SSE 缓冲无上限可 OOM；逐 chunk 全量正则 O(n²)；Content-Length 无上限；三处 JSON.parse 无 try/catch，一条非 JSON 心跳炸掉整条流且不可恢复。 | 待修 |
| H4 | `src/workspaceCommands.ts:272` | 控制面 workspace 命令仅词法校验无 realpath：agent 建 symlink 后用户在 Web 端浏览/编辑即可读写 /work 之外内容，两个信任域被打通。对比 builtin 工具有完整防护。 | 待修 |
| H5 | `core/src/session/verificationCommand.ts:53`、`verificationReport.ts:176` | 完成契约验证可伪造：引号内的 `;` 不被视为 masking 操作符，`bash -c 'npm test; exit 0'` 通过检查恒返回 0；更根本的 gate 只看退出码与命令形状，`"test": "echo ok"` 即满足 test/build 要求。 | 待修 |

## 中

| # | 位置 | 问题 | 状态 |
|---|---|---|---|
| M1 | `builtin/bash.ts:32-60` | 超时只 SIGTERM 直接 shell 子进程，孙进程孤儿化继续运行持 fd；无进程数/频率配额（fork 防护仅容器 pids limit + classifier 一条易绕正则）。建议 detached + 进程组信号。 | 待修 |
| M2 | 原 `permissionModes.ts` | TUI 权限模式和 classifier 黑名单不适合 Cloud 普通用户。 | **已修**：移除权限模式，固定 workspace 范围；普通本地操作自动执行，外部操作确认，已知破坏性命令直接拒绝 |
| M3 | `transport.ts:227-236` | waitForApproval 无超时：控制面丢消息或用户不响应则 job 永久挂起。另 pending 按 message type 匹配响应，同类型并发会错配（当前串行侥幸安全）。 | 待修 |
| M4 | `createAgentHost.ts:389`、`inMemoryTraceStore.ts:9` | InMemoryTraceStore 只进不出：长驻 worker 内存泄漏，attachChangedFiles/readRun 全量线性扫描越跑越慢。 | 待修 |
| M5 | `src/main.ts:31-44` | SIGTERM 只 close transport 不中止 run：runStreaming 未传 AbortSignal（接口支持），优雅关闭需等整个 turn 自然结束或被强杀留中间态。 | 待修 |
| M6 | `mcp/register.ts:446-470` | MCP 工具入参明文写 trace/events.jsonl（Bash/git/process 均做了脱敏，唯独 MCP 没有），可能含 token/连接串。 | 待修 |
| M7 | `src/agentLoop.ts:132,314` | host 跨 job 存活且 thread 不清空：所有 conversationId 混在同一线程，job 又全文注入控制面下发的 40 条 history——同一段历史双重注入，token 双倍消耗线性膨胀。 | 待修 |

## 低

| # | 位置 | 问题 | 状态 |
|---|---|---|---|
| L1 | `mutationJournal.ts:130` | pre/post 文件全文明文存 ~/.kross/mutations/blobs 无 TTL/GC，workspace 内 .env/私钥被复制到工作区之外。 | 待修 |
| L2 | `applyPatch.ts:81` | plan 全量预检后顺序写入非原子，磁盘满留下部分应用的补丁，与工具描述不符。建议临时文件 + rename。 | 待修 |
| L3 | `workspaceCommands.ts:327`、`write.ts:53` | runGit 输出无 maxBuffer 累积字符串；Write 工具 content 无大小上限。 | 待修 |
| L4 | `sessionContext.ts:683` | pinned context source 无总量上限，超 budget 既不 drop 也不告警，组装出的消息超窗每次 API 调用必败。 | 待修 |
| L5 | `toolLoop.ts:327,657,703,749` | 多处 `...this.activeCheckpoint!` 非空断言，checkpoint 已清空时 spread 出 `{}` 触发 ZodError。 | 待修 |
| L6 | `transport.ts:315` | agent token 经 WS 子协议握手头传输，可能进反代访问日志（低危，内网可接受）。 | 待修 |
| L7 | `git.ts:362`、`paths.ts:59` | git pathspec 词法校验跟随界外 symlink 的读取面；realpath 校验与 writeFile 间 TOCTOU 窗口（攻击者需已有容器执行能力，风险低）。 | 待修 |
| L8 | `agentRuntime.ts:1495`、`agentLoop.ts:121` | run 异常中断时 verificationPendingRuns 残留；host 重建先建新后关旧，新建抛错时旧 host（子进程/MCP 连接）泄漏。 | 待修 |
| L9 | `traceStore.ts:39` | append 前 `parseStoredTraceEvent(serialized)!` 强断言，不一致时以断言崩溃而非显式错误。 | 待修 |

## 未发现问题面（供参考）

- 文件工具路径边界的词法 + realpath 双层校验正常工作，system scope 之外无法逃逸；
- 三级 context governor 对 tool_call/tool_result 配对的保护正确，系统提示每轮重建；
- skill 发现/读取的三级 symlink 校验完整，资源读取有 64KB 截断；
- MCP HTTP 强制 https（localhost 除外）+ header 白名单 + authorization 仅允许 env 引用;
- mutation journal 的 capture/recover/undo 流程正确，hash 校验防冲突；
- ProcessManager 有界环形缓冲、进程组 TERM→KILL、句柄 GC 设计良好；
- Cloud 工具策略固定为 workspace scope，模型和用户都不能提权到 system scope。

## 与后端审查（review-2026-08-24.md）的关联

- H1/H2 的「断线即退出」放大了后端 stuck-processing 无看门狗的影响：
  worker 异常退出后容器仍 running，消息永久滞留；
- S1/S2 的密钥暴露与后端 CredentialVault 的加密努力相互抵消——链路最弱点
  决定整体安全水平；
- H4 打通的是 worker(容器) 与控制面(workspace 命令) 两个信任域，修复应在
  worker 侧 workspaceCommands 补 realpath。
