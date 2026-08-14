# 持久 Agent 工作区 Implementation Plan

> **For agentic workers:** 本计划正在当前仓库直接实施。破坏性重做，不做旧 Cloud / Run 沙箱兼容，不迁移旧库。
>
> 日期：2026-08-13
>
> 产品目标：开源、企业私有化部署，给组织里的每个人配备一个长期 Agent。

**Goal:** 把 Cloud 从「每次任务起一个一次性沙箱」改成「每人一个带持久卷的长期 Agent」。

**Architecture:** 人是租户边界。Docker volume 长期保存 `/work`，容器按需启停。控制面管生命周期、对话和渠道扇出；Worker 只在容器运行时与控制面保持 WebSocket，用 Core 在 `/work` 里执行。

**Tech Stack:** Java 21 Spring Boot 控制面、PostgreSQL、Docker SDK、`apps/worker` + `@kross/core`。

## Global Constraints

- 本地 TUI / `kross exec` / `packages/core` 产品行为不改。
- Worker 内部协议保持原始 JSON，不包 `Res`。
- Java 空值用 `Optional` 或专属工具，不随意删注释，不用 emoji。
- 不做旧版兼容：删除 Project / Task / Run / Source / Artifact / lease。
- 本地 Postgres 卷 `kross-postgres-v3`，旧数据丢弃。
- 本阶段不跑测试套件；控制面以 `./mvnw -DskipTests compile` 能过为准。

---

## 产品

Kross Cloud 不再是「来一个任务起一个容器、跑完销毁」的工单系统。

它是：企业给每个成员发一台 Agent 工作区。记忆、文件、技能住在这块盘上。容器像虚拟机电源，有人用就开，闲了就关，盘留下。

## 原则

1. **人是租户边界。** 默认每组织每用户一个 Agent。
2. **长期的是卷，不是进程。** 删除容器不得删卷。
3. **任务在自己家里执行。** 不再为一条消息新开沙箱。
4. **空闲必须能睡。** 默认 15 分钟无用户活动后 `stop`。
5. **镜像和数据分开。**
6. **密钥不长期躺在容器环境变量里。** wake 时签发短时 Token；模型 Key 由 Worker 向控制面现取。
7. **不做旧版兼容。**

## 运行逻辑

```text
成员首次进入组织
  -> 控制面确保有一条 agents 记录
  -> 如无卷则创建 kross-agent-vol-{hash}

用户发一条消息
  -> 写入 agent_messages (queued)
  -> 若容器未运行：签发 Token，recreate+start，挂同一块卷
  -> Worker 连上控制面 WebSocket 后被推送任务，用 Core 在 /work 里执行
  -> 直播事件经内存扇出到浏览器 SSE；回合结束把 parts 快照写入 agent_messages

闲置超过阈值且没有 processing 消息
  -> 控制面 stop 容器
  -> volume 保留
```

工作区目录约定（容器内 `/work`）：

```text
/work/
  USER.md
  MEMORY.md
  memory/YYYY-MM-DD.md
  files/
  skills/
```

P0 先约定目录，P1 再注入 Core。

## 控制面 API

前缀 `/api/v2`，成功包 `Res<T>`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/me` | 身份 |
| GET | `/agent` | 自己的 Agent（没有则创建记录，不立刻起容器） |
| GET | `/agent/conversations` | 对话列表 |
| POST | `/agent/conversations` | 新建对话 |
| POST | `/agent/conversations/{id}/messages` | 追加用户消息；必要时唤醒容器 |
| GET | `/agent/conversations/{id}/messages` | 对话历史 |
| GET | `/agent/conversations/{id}/events` | 对话 SSE（文本 / 思考 / 工具直播） |
| POST | `/agent/sleep` | 立即休眠 |

内部 Worker（原始 JSON，WebSocket `/internal/v2/agents/ws`）：

| 方向 | 类型 | 作用 |
|---|---|---|
| 控制面 → Worker | `agent.registered` | 握手鉴权后登记，下发心跳间隔 |
| 控制面 → Worker | `agent.job` | 空闲时推送一条 queued 用户消息 |
| 控制面 → Worker | `agent.heartbeat_ack` | 是否应休眠 |
| 控制面 → Worker | `agent.model_environment` | 短时下发模型环境变量 |
| Worker → 控制面 | `agent.heartbeat` | 汇报存活 |
| Worker → 控制面 | `agent.events` | 推送 text-delta / thinking-delta / tool-call / tool-result |
| Worker → 控制面 | `agent.message` | 回写完整 parts 快照并完成用户消息 |
| Worker → 控制面 | `agent.sleep` | Worker 请求休眠 |
| Worker → 控制面 | `agent.model_environment` | 索取模型环境变量 |

## P0 文件地图

新建：

- `com.kross.agent.AgentService`
- `com.kross.agent.AgentScheduler`
- `com.kross.agent.dto.AgentProtocol`
- `com.kross.controller.AgentController`
- `com.kross.channel.AgentWebSocketHandler` / `AgentSocketHub`
- `com.kross.support.Tokens`
- `apps/worker` 常驻循环（`main.ts` / `transport.ts` / `agentLoop.ts`）

删除：

- `com.kross.work`、`com.kross.execution`
- 旧 Worker HTTP、`RunScheduler`
- Project / Task / Run / Source / Artifact / Approval / Connector 控制器
- Worker 里 RunExecutor / artifact / checkpoint / source materializer

## 本阶段明确不做

- 一人多个 Agent、按任务再套沙箱、K8s
- 旧数据迁移、SSE 事件落库（直播只走内存扇出，回合结束写快照）
- 对外副作用审批、Connector、定时任务
- 用户工作台 / 管理端 UI（本轮不改；后续重构或替换开源 UI）

## 本地验证（由维护者执行）

1. 使用 `kross-postgres-v3` 后 `./scripts/start-cloud.sh`
2. 管理端 bootstrap 组织并配置模型 Key
3. `POST /api/v2/agent/messages` 发一条消息
4. `docker ps` 出现 `kross-agent-*`，`docker volume ls` 有对应卷
5. 容器 stop 后再发消息，应挂回同一块卷
