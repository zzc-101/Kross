# Kross Cloud Agent 架构评审

> 评审时间：2026-07-23。评审范围：`packages/protocol`、`packages/server`、
> `packages/worker`、`packages/web`、`docker/`、`docker-compose.yml`、
> `scripts/start-cloud.sh`，对应提交 `aab820c`（P0 workflow）至
> `1863c6e`（一键启动脚本）。

## 一、总体判断

整体架构选型是正确的，几个关键决策我都认同：

- **worker 进程跑在容器内、core 零改动**：相比「Runtime 在网关 + docker exec 桥接」，当前方案让容器成为唯一执行边界，core 的文件/Git/进程工具无需任何跨容器改造。这是本方案最重要的决策，做对了。
- **protocol 包不依赖 core**：避免 Node/SQLite 运行时进入浏览器构建，线协议独立用 Zod 维护并双端校验，为原生 App 复用打好了基础。
- **每工作区一容器 + 命名卷**：生命周期清晰，删除语义明确（容器可随时重建，卷才是数据）。启动时的注册表对账（接管、重建、清理孤儿容器）考虑周到。
- 安全基线不错：CapDrop ALL、no-new-privileges、资源限额、环境变量白名单注入、凭证不落网关日志、timingSafeEqual 比较 token、克隆用一次性 helper 容器而非网关直接执行 git、所有状态文件原子写（tmp + rename、0600）。

主要问题集中在三个层面：**多工作区之间的网络隔离不足**（安全）、**网关到 worker 的连接没有保活与自动重连**（可靠性）、**事件日志把所有 wire 事件全量落盘且每次全文件扫描**（可扩展性）。此外协议的请求-响应关联方式存在并发串扰，Web 端有一个对中文用户很致命的输入法 bug。下文按严重程度展开。

## 二、高优先级问题（建议尽快处理）

### 1. 所有 worker 共享一个 bridge 网络，工作区之间互相可达

`DockerOrchestrator` 把所有 worker 和 gateway 放在同一个 `kross-cloud`
bridge 网络（`packages/server/src/containerOrchestrator.ts` 的
`ensureNetwork` / `createWorkerContainer`）。Cloud Agent 的威胁模型里，
worker 内运行的是不可信仓库代码（Agent 会执行仓库里的构建脚本、测试
等），而当前拓扑下：

- 工作区 A 的代码可以直接访问工作区 B 容器的 8788 端口，唯一防线是每个
  worker 的随机 token；
- 所有 worker 都能访问 gateway 的 8787 端口。

单用户自托管下风险可控，但「容器即安全边界」的设计意图被共享 L2 网络
打了折扣。建议之一（成本从低到高）：

1. 每个工作区创建独立 bridge 网络，gateway 同时接入所有网络（Docker
   支持一容器多网络），worker 之间彻底二层隔离；
2. 或在共享网络上启用 `enable_icc=false` 一类的容器间通信限制；
3. 更长期：把「出站白名单」（LLM API、npm registry、GitHub）做成可配置
   的 egress 策略，文档中已经预留了这个方向。

方案 1 与现有 `workerUrl()`（按容器名解析）完全兼容，改动集中在
orchestrator 内部，建议优先做。

### 2. 网关到 worker 的 WS 没有心跳，也不主动重连

`WorkerClient`（`packages/server/src/workerClient.ts`）只在下一次 `send`
时惰性重连。这带来一个真实的功能性缺口：

- worker 容器因 OOM、宿主机重启或 `RestartPolicy: unless-stopped` 自动
  重启后，gateway 侧连接断开且**不会重建**；
- 审批 Push 通知依赖 gateway 对 worker 事件的常驻订阅
  （`GatewayService.client()` 中的 `approval.pending` 分支），连接断开
  期间产生的审批请求**不会推送到手机**，这恰好是移动端锁屏审批这个核心
  场景最需要的链路；
- 客户端 WS 同样没有 ping/pong，移动端网络切换产生的半开连接要等 TCP
  超时才能被发现，期间界面看似在线实则收不到事件。

建议：

- gateway→worker 连接加心跳（ws 库自带 ping/pong）+ 断线指数退避重连，
  只要 workspace 状态是 ready 就保持订阅；
- gateway→浏览器同样加 ping，或让客户端定期发轻量命令探活；
- 更彻底的替代方案：把连接方向反过来，worker 启动后**主动出站连接
  gateway 注册**。好处是 worker 重启后自愈、gateway 不需要知道 worker
  地址、也为未来 worker 跑在别的机器上留了口子。改动量中等，值得在
  P3 里认真考虑。

### 3. EventJournal 全量落盘 + 全文件扫描，会话变长后必然劣化

`packages/worker/src/eventJournal.ts` 存在三个叠加的问题：

- **写入面**：`WorkerService.emit()` 把所有 wire 事件都追加进 JSONL，
  包括每个 token 的 `text-delta`/`thinking-delta`、`session.list` 查询
  响应、`request.accepted` 等。一次长回复就是数千行日志；查询类命令也
  在污染 append-only 日志。
- **读取面**：`findAcceptedRequest`（每条带 sessionId 的命令处理前都要
  调用做幂等检查）、`replay`、未命中缓存的 `lastSeq` 都是**全文件读取
  加逐行 Zod 解析**。命令处理成本随历史事件数线性增长，长会话下每条
  消息的前置开销会到秒级。
- **回放语义**：客户端 resume 时其实主要依赖 `session.snapshot` 重建
  UI（见问题 7），全量回放的增量事件大多被客户端 seq 去重直接丢弃，
  日志里存的海量 delta 没有产生对应价值。

建议的方向（一个比较干净的组合）：

- journal 只记「领域事件」：`approval.pending`、`result`、`git.result`、
  `session.updated` 等低频事件 + 每次 run 结束的 snapshot 标记；
  `text-delta` 这类高频瞬态事件不落盘，断线重连的补齐由
  「snapshot + snapshot 之后的增量」承担；
- `findAcceptedRequest` 的幂等检查改为独立的小型 requestId 索引（内存
  Map + 定期持久化，或一个单独的 recent-requests 文件），不要靠扫全量
  日志；
- 日志分段与截断：每次成功 persist snapshot 后即可截断该会话早于此的
  journal 段。
- 也可以考虑设计文档中最初的思路——直接复用 core `HybridSessionStore`
  已有的带 `seq` 事件日志，避免维护两套并行的持久化（当前消息既写
  sessionStore 又以 delta 形式写 journal，属于双写）。

### 4. 请求-响应靠「事件类型匹配」关联，并发下会串扰

`GatewayService.requestWorker()`（REST 的 `listSessions` /
`inspectSession` 使用）用谓词匹配响应事件，例如「类型是
`session.list`」或「类型是 `inspection.result` 且 kind 相同」，**不校验
requestId，甚至不校验 workspaceId**。两个并发请求（比如两个标签页同时
打开 Diff，或同时列出两个工作区的会话）会拿到彼此的响应。同样地，WS
路径上 `session.list`、`inspection.result` 等响应事件本身不携带
requestId，客户端也无法关联。

建议在协议层统一解决：给 `eventEnvelope` 增加可选的
`correlationId`（等于触发命令的 requestId），worker 对查询类响应统一
填充；gateway 和 web 端全部按 correlationId 关联。这是纯增量字段，
protocolVersion 不需要 break。

顺带一提：这类查询响应目前会经 `emit()` 广播给**所有** sink（所有已
连接的浏览器都会收到别人触发的 `inspection.result`），改为 correlationId
定向回复后也自然解决。

### 5. 中文输入法下 Enter 会误发送消息

`packages/web/src/App.tsx` 的 composer `onKeyDown` 判断
`Enter && !shiftKey` 就提交，没有检查输入法组合状态。中文用户用拼音
输入、按 Enter 确认候选词时会直接把半截拼音发送出去。修复很简单：

```tsx
if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
```

对以中文为主要输入语言的用户来说这是 P0 级体验问题。

## 三、中优先级问题

### 6. 幂等语义是「至多一次」：accepted 先于执行落盘

`WorkerService.runInput()` 在**开始执行前**就 emit `request.accepted`
（写入 journal）。如果 worker 在运行途中崩溃重启，客户端重发同一
requestId 的命令会命中 `findAcceptedRequest` 被直接吞掉，任务实际没有
完成，用户看到的是「已接受但永远没有结果」。对话式任务这样取舍可以
接受（用户重新输入即可），但建议：要么把 accepted 的落盘时机移到 run
结束（journal 里以 `result` 作为幂等凭据），要么在 resume 的 snapshot
里能看出「该请求被接受但没有对应 result」的状态并提示用户。

### 7. replay 与 snapshot 双机制并存，实际只有 snapshot 在起作用

客户端 resume 流程（`packages/web/src/useCloud.ts` +
`cloudClient.ts`）中：手动打开会话发 `lastSeq: 0` 请求全量回放，但
`handledSeq` 已被初始化为 localStorage 里的水位，回放事件绝大多数因
`seq <= previous` 被丢弃，UI 状态实际由随后到达的 `session.snapshot`
重建。也就是说回放机制在正常路径上是空转的，只有「localStorage 水位
之后、snapshot 之前」这个窄窗口的事件真正被消费。

这不是 bug（结果正确），但它说明状态同步模型可以大幅简化：**以
snapshot 为唯一权威 + 断线期间只补 snapshot 之后的实时事件**。这样
问题 3 的 journal 也可以随之瘦身。当前一个可见的副作用是：resume 后
工具卡片全部消失（traces 只存在于内存、回放又被去重丢弃），界面上
执行历史不完整。若希望恢复后仍能看到工具执行记录，应把工具卡片数据
放进 snapshot（或者持久化 trace 摘要），而不是依赖回放。

### 8. 每会话一个常驻 Runtime，无淘汰、加载无并发保护

`WorkerService.sessions` 只增不减：worker 长期运行后，每个被访问过的
会话都保有完整的 `AgentRuntime` + tooling（含 LLM 客户端、trace store、
进程管理器）。2 GiB 内存限额下会话多了会 OOM。另外 `loadRuntime` 没有
并发去重：同一新会话的两条命令同时到达会各自 `createDefaultRuntime()`，
后者覆盖 map，前者的 tooling 泄漏。建议：

- 加 LRU / 空闲超时淘汰（runtime 本身有 checkpoint 恢复，淘汰是安全的，
  注意跳过有 pendingApproval 或正在运行的会话）；
- `loadRuntime` 按 sessionId 缓存 in-flight Promise，消除竞态。

### 9. 每次 `session.input` 前全量 `du` 扫描工作区

磁盘配额检查（`runInput` 开头 + `measureWorkspaceDiskUsage`）对
`/workspace` 全量 `du -sk`。node_modules 展开后的大仓库上这是每条消息
前的秒级延迟。建议改为后台周期性统计（比如每 60 秒或每次 run 结束后
更新缓存值），命令路径只读缓存。

### 10. 空闲回收可能打断长时间静默的运行

`IdleWorkspaceReaper` 依据 `lastActiveAt` 判断空闲，而 `lastActiveAt`
由 worker 事件驱动更新（`touchWorkspace`，30 秒节流）。如果一次 run
中某个工具静默执行超过空闲阈值（大型构建、长测试），期间没有任何协议
事件，容器会被判定空闲直接 `stop`，run 被杀。建议 reaper 在停止前询问
worker 是否有活跃 run（一个轻量的 status 查询，或 worker 定期上报
心跳事件），有则跳过。

### 11. 断线重发队列在极端情况下会顺序反转

`CloudClient.sendNow()` 失败时 `unshift` 回队列；`open` 事件里
`splice(0)` 后逐个 `sendNow`。若发送途中 socket 再次断开，多个元素被
依次 `unshift`，恢复后顺序变成**逆序**（`[a,b,c]` 变 `[c,b,a]`）。
对「先 input 后 approval」这类有顺序依赖的队列是错的。修法：失败时把
剩余未发送部分整体放回队首，而不是逐个 unshift。

### 12. 流式渲染的性能隐患

`useCloud` 的 reducer 每个 `text-delta` 都重建整个 messages 数组，
`App` 里每条消息都走 `ReactMarkdown` 全量重解析，没有 memo。长回复
（数千 delta）时移动端会明显卡顿。另外 `state.traces` 无上限累积。
建议：`Message` 组件 `React.memo`（流式中的最后一条单独处理）、delta
先在 ref 里攒批再以 `requestAnimationFrame` 节奏刷入 state、traces 保留
上限（比如 200 条）。

## 四、协议与界面的改进建议

### 协议层

- **`inspection.result` 用纯文本 + `--- KROSS PATCH ---` marker 传结构化
  数据**（`gitInspection.ts` 拼接、web 端 `inspection.ts` 再解析），
  脆弱且限制了前端展示能力。建议改成结构化 payload：
  `{ summary: string, patches: { staged: boolean, patch: string }[] }`，
  前端可以做按文件折叠的 diff 视图。
- **协议版本没有协商**：`protocolVersion` 是 literal 1，双端不一致时
  safeParse 失败、事件被静默丢弃，旧的 PWA 缓存客户端升级后会「看起来
  在线但收不到任何事件」。建议 WS 握手后先交换 hello/version 事件，
  不兼容时给用户明确的「请刷新更新」提示（PWA 更新提示已有，缺的是
  协议不匹配时的强制触达）。
- **模型列表没有暴露**：TUI 有 pi-ai model catalog，云端协议里
  `session.settings.model` 却是自由文本，web 端只能手输模型名。建议加
  `models.list` 查询命令，前端做成下拉选择。
- **缺会话删除**：协议只有 rename，没有 `session.delete`。会话会无限
  累积。
- `storedMessageSchema.tool` 仍是 `z.unknown()`——计划文档里明确说过
  要给它定稳定 schema，目前还没做，web 端也因此没有渲染历史工具卡片。

### 网关与传输

- WS 用 `Sec-WebSocket-Protocol` 传长期 token 的做法（浏览器限制下的
  妥协）已文档化，但更稳妥的是 REST 用 Bearer 换**一次性短期 ticket**，
  WS 握手只带 ticket。反向代理日志里即使记录了握手头，泄漏的也只是
  已消费的 ticket。改动小，收益明确。（注：若按第七章迁移到 SSE +
  POST，客户端全链路回到标准 Bearer 头，本条自然作废。）
- `httpServer.connect()` 的订阅过滤依赖「客户端发过的命令里出现过的
  workspaceId/sessionId」集合，且 `awaitingSessionCreate` 用「下一个该
  workspace 的 snapshot」认领新会话——两个标签页同时创建会话会认领错。
  单用户下影响小，但更干净的模型是显式的 `subscribe`/`unsubscribe`
  命令，语义清晰也便于将来做多设备。（注：第七章方案改为服务端全量
  下发、客户端按 active session 过滤，该逻辑整体移除。）
- 克隆 helper 容器通过 `Env` 传 Git token / SSH 私钥，凭证在容器存活
  期间对 `docker inspect` 可见（gateway 本身有 socket 权限，属于同一
  信任域，但宿主机上其他有 docker 权限的进程也能看到）。可以改为通过
  stdin 或 tmpfs 挂载传入。

### 界面

界面整体是合格的移动优先布局，登录、环境自检（SetupPanel）、工作区
创建进度、审批卡片、PWA 安装/更新这些关键流程都齐了。除上面提到的
输入法和渲染性能问题外，还有几个建议：

- **审批卡片信息量不足**：只有 `inputPreview` 纯文本。对 Bash 类高危
  工具，建议展示完整命令、工作目录，并提供「拒绝并附理由」（协议上
  `session.approval` 加可选 `reason`，反馈给 Agent 作为修正提示），
  这是 TUI 对齐云端时最值得补的能力。
- **`session.approval` 后 UI 没有乐观反馈**：点批准后到流恢复前界面
  没有中间态（卡片仍在，容易重复点击；重复点击会触发 SESSION_BUSY
  错误 toast）。建议点击后立刻把卡片置为「处理中」并禁用按钮。
- 错误提示只有一个全局 `error` 字段，多个错误会互相覆盖；且
  `request.error` 不区分是哪个操作失败的（关联问题 4 解决后可以把错误
  定位到具体消息/操作上）。
- 工具活动面板只显示 `slice(-12)` 且 resume 后清空（见问题 7），
  「Agent 到底做了什么」的可审计性目前主要靠 Trace 下钻，主界面信息
  偏少。

## 五、部署与运维

- `docker-compose.yml`、多阶段镜像、一键脚本整体质量不错。worker 镜像
  同时用作克隆 helper（root 运行）是个聪明的复用。
- Docker socket 风险已在文档中充分披露，判断正确：单机自托管这是合理
  取舍，文档同时给出了「替换 Orchestrator 为受限调度服务」的演进方向。
- `start-cloud.sh` 生成 token 后写入 `.env` 并 chmod 600，正确。一个
  小问题：`wait_for_gateway` 用 `curl /`（静态页）探活而不是
  `/healthz`，如果将来静态资源目录缺失会误判。
- gateway 事件信封统一 `seq: 0`（`GatewayService.envelope`），与 worker
  journal 的 seq 语义混用一个字段。目前客户端靠 `seq > 0` 区分，能
  工作，但建议显式化（比如 gateway 事件 `seq` 缺省/为 null），避免
  未来有人给 gateway 事件也编号时破坏客户端去重假设。

## 六、优先级路线建议

| 优先级 | 事项 | 对应章节 |
|---|---|---|
| P0 | 输入法 Enter 误发送（一行修复） | 问题 5 |
| P0 | gateway→worker 心跳 + 自动重连（修复 Push 通知链路） | 问题 2 |
| P0 | 每工作区独立 Docker 网络 | 问题 1 |
| P1 | journal 瘦身：只存领域事件 + requestId 索引 + 截断 | 问题 3、7 |
| P1 | envelope 增加 correlationId，消除并发串扰 | 问题 4 |
| P1 | 重发队列顺序修复；审批按钮乐观反馈 | 问题 11、界面 |
| P1 | Runtime LRU 淘汰 + loadRuntime 并发保护 | 问题 8 |
| P2 | 磁盘检查改后台缓存；reaper 感知活跃 run | 问题 9、10 |
| P2 | inspection 结构化、模型列表、会话删除、审批理由 | 协议/界面 |
| P2 | 流式渲染性能（memo + 攒批） | 问题 12 |
| P1 | 客户端 ↔ gateway 传输层迁移为 SSE + POST（专项方案见第七章） | 第七章 |
| P3 | worker 反向注册连接方向；egress 白名单 | 问题 2、网关 |

## 七、专项改造方案：客户端 ↔ Gateway 迁移为 SSE + POST

> 本章是可直接交付实施的工作说明。目标：把浏览器与 gateway 之间的
> WebSocket 双工通道，替换为「下行 SSE 事件流 + 上行 HTTP POST 命令」。
> 该改造同时消解本文第 2 节问题 4（请求-响应串扰）、问题 11（重发队列
> 顺序反转），并移除 `Sec-WebSocket-Protocol` 传 token 的 hack、补上
> 客户端链路心跳。

### 7.1 改造范围与明确不做的事

**改动范围**：`packages/protocol`（一个增量字段）、`packages/server`
（httpServer 与 gatewayService）、`packages/worker`（emit 透传
correlationId）、`packages/web`（cloudClient 重写、useCloud 小改、
main.tsx 登录端点迁移）、`docs/cloud-agent-deployment.md`（部署说明）。

**明确不做**（越界即视为验收不通过）：

- gateway ↔ worker 之间的 WS 协议与 `WorkerClient`/`WorkerWsServer`
  的传输方式**保持不变**（心跳/重连是另一个独立任务）；
- `packages/core` 零改动；
- EventJournal 的存储结构不动（journal 瘦身是另一个独立任务）；
- 不引入任何新的运行时依赖（SSE 解析自己写，见 7.5，双端格式我们
  自己控制）；
- 不删除现有 REST GET 端点（`/api/workspaces`、`/api/setup`、
  `/api/config`、sessions/trace/diff 查询），行为保持兼容。

### 7.2 协议层改动（packages/protocol）

1. `eventEnvelopeSchema` 增加可选字段
   `correlationId: identifierSchema.optional()`，语义：该事件是对哪个
   客户端命令（`requestId`）的直接响应。纯增量，`PROTOCOL_VERSION`
   保持 1，不做 breaking 变更。
2. `schemas.test.ts` 补用例：带与不带 `correlationId` 的信封都能通过
   解析；旧信封（无该字段）不受影响。

### 7.3 Worker 改动（packages/worker）

`WorkerService.handle()` 把 `command.requestId` 向下透传：处理某条命令
期间产生的所有 `emit`（`request.accepted`、`request.error`、
`session.list`、`session.snapshot`、`inspection.result`、`git.result`、
`replay.complete` 等）都在信封上带 `correlationId = command.requestId`。
实现方式：给 `emit` / `emitError` 增加可选 `correlationId` 参数，各命令
处理函数传入。运行中由回调产生的事件（trace、todo.snapshot、
`consumeStream` 的 stream 事件）**不带** correlationId（它们不是对单条
命令的直接响应）。journal 落盘的信封随 schema 自然包含该字段。

### 7.4 Gateway 改动（packages/server）

#### 7.4.1 新增 `GET /api/events`（SSE 下行流）

- 认证：标准 `Authorization: Bearer`（fetch 可以自定义头，不再需要
  子协议 hack）。校验失败返回 401。
- 响应头：`content-type: text/event-stream`、`cache-control: no-cache`、
  `x-accel-buffering: no`。连接建立后先写 `retry: 3000\n\n`。
- 帧格式（服务端保证，客户端据此解析）：每个事件一行
  `data: <EventEnvelope 的单行 JSON>\n\n`；心跳为注释帧 `: ping\n\n`，
  每 25 秒一次。JSON 内不允许出现裸换行（`JSON.stringify` 天然满足）。
- 流内容：**该用户的全部事件**，不做服务端订阅过滤——单用户系统，
  过滤下沉到客户端（见 7.5）。连接建立后立即推送一条
  `workspace.list` 信封作为初始状态（替代现在 WS open 后客户端主动发
  `workspace.list` 命令的握手）。
- 删除 httpServer 中面向浏览器的 WebSocketServer：`connect()` 及其
  `workspaceIds` / `sessionIds` / `awaitingSessionCreate` 订阅过滤逻辑、
  `readWebSocketToken`、`handleProtocols` 全部移除。

#### 7.4.2 新增 `POST /api/commands`（上行命令）

- 请求体：完整 `ClientCommand` JSON（含 `protocolVersion` 与客户端生成
  的 `requestId`），用 `clientCommandSchema` 校验，失败返回 400 及
  zod 错误信息。请求体上限沿用 64 KiB（SSH 私钥在此限内）。
- 语义：**校验通过即分发、立即返回 202** `{ accepted: true, requestId }`。
  命令的执行结果（包括 `request.accepted` / `request.error` / 查询响应）
  一律经 SSE 流回到客户端，靠 `correlationId` 关联。HTTP 层的 2xx 只
  表示「命令已被接收且格式合法」——这给离线队列一个干净的重试判据。
- `GatewayService` 增加 `broadcast(event)`：`handle()` 中所有原来只发给
  per-connection sink 的本地响应（`workspace.list`、
  `workspace.updated`、`workspace.progress`、错误事件等）改为广播给
  所有订阅者，并带上 `correlationId = command.requestId`。worker 转发
  路径不变（worker 事件本来就经 `subscribe` 广播）。

#### 7.4.3 修复 `requestWorker` 的响应匹配

现有 REST GET（sessions 列表、trace/diff）内部的 `requestWorker`
谓词匹配改为：`candidate.correlationId === command.requestId`。
类型/kind 匹配可以保留作为二次断言，但关联判据必须是 correlationId。
超时与错误路径行为不变。

### 7.5 Web 客户端改动（packages/web）

`cloudClient.ts` 重写为两部分，`useCloud` 对外接口尽量保持不变
（`send` / `onEvent` / `onState` / `setActiveSession` 语义保留）：

1. **EventStream（SSE 读取器）**：用 `fetch` + `ReadableStream` 手写，
   约 40-60 行。按 `\n\n` 分帧、取 `data: ` 前缀行、`JSON.parse` 后过
   `eventEnvelopeSchema.safeParse`。要点：
   - 断线用现有的指数退避策略重连（600ms 起，上限 30s）；
   - **心跳超时检测**：任何帧（含 `: ping` 注释帧）都刷新计时器，
     60 秒无帧视为半开连接，主动断开重连并进入 offline 状态；
   - 重连成功后：SSE 首帧会带来 `workspace.list`；若有 activeSession，
     照现有逻辑用 localStorage 的 `lastSeq` 发送 `session.resume`；
   - 连续 3 条信封解析失败（多为协议版本不匹配）时，向 UI 抛出
     「客户端版本过旧，请更新」状态，并触发 PWA 更新检查。
2. **CommandSender（POST 发送器）**：
   - `send()` 生成 requestId 后入队，队列**串行 drain**：上一条 POST
     得到响应后才发下一条——顺序天然有保证，问题 11 随之消失；
   - POST 网络失败（fetch reject / 5xx）：命令留在队头，等重连后继续
     drain；4xx（校验失败）：出队并向 UI 报错，不重试；
   - 离线队列上限 100 条与现有提示文案保持不变；
   - `workspace.create` 不进离线队列：离线时直接向用户报错（与现有
     「创建过程实时看进度」的交互一致，也避免非幂等命令重复创建）。
3. **seq 去重逻辑保留**：per-session 的 `handledSeq` + localStorage
   水位照旧。
4. **reducer 增加会话过滤**（`useCloud.ts`）：带 `sessionId` 的信封若
   不等于当前 active session 则忽略（`session.updated` 例外，仍用于
   刷新会话列表）。这替代了原来服务端的订阅过滤，并顺带修掉双标签页
   互相污染 UI 的问题。
5. **登录端点迁移**（`main.tsx`）：存储的 endpoint 从
   `ws(s)://host/ws` 改为 `http(s)://host` 基地址。读取旧值时做一次性
   迁移：`wss:→https:`、`ws:→http:`、去掉尾部 `/ws`，回写 localStorage。
   登录表单的默认值与占位文本同步更新。
6. 删除 `encodeToken` 与子协议相关代码。

### 7.6 文档与部署说明

`docs/cloud-agent-deployment.md`：

- 删除「浏览器不能给 WebSocket 握手自定义 Authorization …
  `kross.token.*` 子协议」段落，替换为：客户端全部使用标准 Bearer
  认证；反向代理需要对 `/api/events` 关闭响应缓冲（nginx 需
  `proxy_buffering off`，gateway 已发送 `X-Accel-Buffering: no`），
  且不再需要为客户端路径配置 WebSocket upgrade（worker 内部链路仍为
  WS，但不经过公网反代）。

### 7.7 测试要求

- 更新 `httpServer.test.ts`：`POST /api/commands` 的认证、校验失败
  400、成功 202；`GET /api/events` 的认证、首帧 workspace.list、
  心跳帧、事件广播、correlationId 透传。
- 更新/替换 `cloudClient.test.ts`：SSE 分帧解析（含跨 chunk 边界的
  半帧）、心跳超时重连、队列串行与失败保序（构造「发送中途断线」
  用例，断言恢复后顺序为原顺序）、endpoint 旧值迁移。
- worker 侧补一个 correlationId 透传用例（handle 一条命令，断言产生
  的 accepted/结果信封带正确 correlationId，trace/todo 事件不带）。
- 全量 `vitest` 通过；`docker compose --profile build build` 通过。

### 7.8 验收清单（评审人执行）

功能回归（浏览器 DevTools Network 面板确认无任何 WS 连接）：

1. 登录（含旧 endpoint 值自动迁移）、环境面板、工作区创建全程进度、
   会话创建/恢复/重命名/搜索；
2. 流式对话、思考折叠、工具审批（批准与拒绝）、plan 确认、abort、
   模型与思考强度切换；
3. Diff/Trace 查看、git push、PR 创建、Push 订阅；
4. 断网 → 界面 60 秒内进入离线态；期间发送 3 条命令 → 恢复网络后
   按原顺序送达且只执行一次（seq 无重复事件）；
5. 双标签页各自打开不同会话同时点 Diff → 各自拿到自己的结果
   （问题 4 验收）；标签页 A 的会话流不再污染标签页 B；
6. SSE 心跳帧间隔不超过 30 秒；kill gateway 后客户端自动退避重连，
   重启 gateway 后无需刷新页面即恢复；
7. token 仅出现在 `Authorization` 头，任何 URL、子协议、query 中不得
   出现；
8. 全部测试与镜像构建通过；`packages/server`、`packages/web`、
   `packages/worker`、`packages/protocol` 无新增 lint 错误。

## 八、结语

这套 P0-P2 的实现完成度和工程质量高于「初具雏形」的自我评价：协议有
双端校验、状态有对账、安全有基线、文档诚实地披露了取舍。架构骨架
（protocol / server / worker / web 四包 + 容器边界）不需要推翻，上面
列出的问题全部可以在现有骨架内增量解决。最值得先投入的是三件事：
把 gateway↔worker 链路做可靠（心跳/重连）、把工作区网络真正隔离开、
把事件日志从「全量 wire 日志」收敛为「snapshot + 领域事件」。这三件
做完，这个系统才真正配得上「可长期跑在公网 VPS 上给手机用」的目标。
