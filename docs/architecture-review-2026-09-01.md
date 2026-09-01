# 2026-09-01 架构评审

范围：全仓库架构层面（backend / worker / frontend / knowledge / deploy），不含逐行代码审查。
规模基线：后端 Java 约 1.1 万行（189 文件），Worker TS 约 2.9 万行（172 文件），前端约 7 千行，
knowledge Python 服务 18 文件。结论来自结构梳理与关键文件抽查，按当前分支记录。

## 总体结论

控制面 / 执行面的拆分方向正确，模块边界清晰且有机制保障，文档诚实记录了已知负债。
主要短板集中在两点：控制面进程内事件扇出导致的单副本限制，以及后端核心链路的测试缺口。

## 当前架构设计

### 组件拆分

| 组件 | 技术栈 | 职责 |
|---|---|---|
| `backend` | Spring Boot（Java 21） | 身份、组织、持久化、SSE、Worker 租约与容器 / Pod 生命周期 |
| `worker` | Node.js | 成员容器内的控制面协议适配与会话宿主 |
| `worker/core` | TypeScript | Agent Runtime：上下文、工具、子任务、checkpoint 恢复 |
| `frontend/web` | React + Vite | 成员工作台：对话、Skill、记忆、文件 |
| `frontend/admin-web` | React + Vite | 平台与组织管理 |
| `knowledge` | Python（FastAPI） | 文档解析、嵌入与 pgvector 混合检索（可选模块） |

### 通信与数据流

- 浏览器只与控制面通信：HTTP 请求 + SSE 接收流式事件。
- Worker 不暴露端口，仅向控制面发起出站 WebSocket；job 认领走租约机制。
- 对话与最终 `parts` 持久化在 PostgreSQL；token delta 只做进程内内存扇出（`ChannelEventBus`）。
- 工作区文件位于 `/work`：单机 Docker volume，集群 JuiceFS CSI。
- Redis 定位为纯缓存（关闭持久化），故障自动回源 PostgreSQL（`FaultTolerantCacheManager`），TTL 即一致性边界。

### 部署形态

- 单机：Docker Compose，控制面挂载 `docker.sock` 管理 Worker 容器。
- 集群：k3s + Helm，控制面通过 Kubernetes API（Fabric8）创建 Worker Pod，不挂载 Docker Socket。
- 两种形态由 `ContainerBackend` 接口统一抽象（`DockerContainerBackend` / `KubernetesContainerBackend`）。

### 边界保障机制

- 依赖方向单向：Web 不引用 Core，Core 不依赖宿主与 UI；`worker/src/layerBoundaries.test.ts` 用测试扫描源码强制该规则。
- Runtime 工具面收敛：不注册 Shell / Git / 后台进程，外部副作用统一经 Tool Gateway 确认。
- 版本一致性与文档死链有脚本检查（`scripts/check-version-consistency.mjs`、`scripts/check-doc-links.mjs`）。

### 做得好的方面

- 控制面 / 执行面分离与每成员独立 Worker 的隔离模型和产品定位一致，攻击面小。
- 双部署路径考虑成熟，集群模式避开了 Docker Socket。
- 缓存设计务实，没有引入不必要的复杂度。
- Worker 侧测试密集（71 个测试文件对 172 个源文件），tool loop、checkpoint、stall detector、
  context governor 等易错点均有配套测试。
- 文档主动写明当前边界（Core 非稳定 SDK、附件上传未完成、单副本限制等）。

## 问题与风险

按严重度排列。

| 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|
| High | `backend/.../channel/ChannelEventBus.java` | SSE 扇出为进程内 `ConcurrentHashMap`，token delta 只在内存转发，集群被迫 `replicas: 1`（见 `deploy/cluster/values.yaml` 注释）。横向扩展受限，控制面发布必然中断所有在线会话的流式推送。 | 事件总线外置（如 Redis Pub/Sub 或 PostgreSQL LISTEN/NOTIFY），解除单副本限制后再考虑多副本发布策略 |
| High | `backend/.../agent/AgentService.java` | 1062 行聚合会话 CRUD、记忆、工作区读取、job 租约与心跳、事件摄入、SSE 订阅、唤醒调度等至少五类职责，是控制面的单点复杂度来源；租约恢复与事务后回调等并发敏感逻辑混在其中。 | 至少拆为会话/记忆、Worker 协议（register / heartbeat / claim / reply）、租约与调度三个服务 |
| High | `backend/src/test` | 189 个 Java 文件仅 11 个测试类，且集中在 channel / identity / orchestrator 外围；核心的 `AgentService`（租约、事务、多租户鉴权路径）无测试，与 Worker 侧覆盖形成反差。 | 优先补租约认领 / 恢复、事件摄入幂等、组织隔离三条路径的测试 |
| Medium | `deploy/local/docker-compose.yml` | 单机模式控制面容器直接挂载 `/var/run/docker.sock`，控制面被攻破等于宿主 root。文档已声明该边界，集群模式已解决。 | 评估 docker socket proxy（只放行容器生命周期所需 API）作为低成本缓解 |
| Medium | `knowledge/` | 第三种运行时（Python），使用独立的 `docker-compose.knowledge.yml`，集成深度落后于其他组件；小团队维护 Java + TS + Python 的依赖升级与安全补丁成本偏高。 | 保持其可选模块定位；明确其发布、监控与升级流程后再深化集成 |
| Medium | `worker/core/src/runtime/` | `toolLoop.ts`（1096 行）、`streamingToolLoop.ts`、`completeToolLoop.ts` 三份循环变体并存，虽有 `toolLoopShared.ts` 提取公共部分，长期存在逻辑漂移风险。 | 持续收敛循环变体，漂移敏感的行为（stall 判定、checkpoint 时机）统一到共享层 |
| Low | `frontend/web/src/app/screens.tsx` | 单文件承载路由与页面组合（340 行），当前规模尚可，页面增多后会成为修改热点。 | 页面增长时按路由拆分，无需立即处理 |

## 后续优先级建议

1. 事件总线外置，解除控制面单副本限制。
2. 拆分 `AgentService` 并补齐控制面核心路径测试（两项可合并推进，先测试后拆分更稳）。
3. 单机模式 Docker Socket 缓解与 knowledge 模块运维流程明确化。
