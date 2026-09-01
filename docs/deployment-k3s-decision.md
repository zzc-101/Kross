# 多机部署方案对比与选型声明

状态：执行中（自研节点层已删除，集群安装为 k3s + Helm + JuiceFS CSI）
日期：2026-08-24
关联：[review-2026-08-24](./review-2026-08-24.md)、[cloud-agent-deployment](./cloud-agent-deployment.md)

## 1. 声明

本项目采用双路线部署形态：

- **单机（local）**：Docker Compose，保持现状不变；
- **多机（cluster）**：k3s + Kubernetes；自研节点层
  （`node/`、NodeFleetBackend、JuiceFS sidecar 编排）已删除。

两条路线共用同一控制面镜像与业务代码，仅编排层实现不同。

## 2. 三种部署形态对比

### 2.1 总览

| 维度 | local（compose） | cluster（现有自研） | cluster（k3s 目标） |
|---|---|---|---|
| 定位 | 单机、个人/小团队 | 多机（过渡形态） | 多机（标准形态） |
| 容器编排者 | Java 进程直调 Docker API | Go 节点经 WS 接指令操作本机 Docker | kubelet（K8s 原生） |
| 工作区存储 | Docker named volume（单机私有） | JuiceFS sidecar + rshared 共享 | JuiceFS CSI + PVC（RWX） |
| 跨机迁移 | 不支持 | 支持（有双活风险） | 支持（Pod 唯一性由 API server 保证） |
| 节点接入方式 | 无 | 每台部署 kross-node + 手动配 token | 一条 agent join 命令 |
| 入口 | Nginx 容器 :8787 | 同左 + 内部口 8788 | Ingress（Traefik 内置）+ cert-manager |
| Worker 存活保障 | 自研 reconcile 轮询 | 同左 | liveness probe 原生 |
| 部署文件 | `deploy/local` Compose ×1 | compose ×4 叠加（已删除） | `deploy/cluster` Helm chart ×1 |

### 2.2 现有 cluster 方案的结构性问题

2026-08-24 审查确认以下高危项均出自自研编排层：

- 换节点 stop 为 best-effort → 双活脑裂（`NodeFleetBackend`）；
- `NodeHub.detach` 重连竞态 → 节点假离线、重复分配；
- 并发 wake 无互斥；JuiceFS 重启触发全量 Worker 回收；
- 控制面隐含单实例假设，横向扩容即脑裂。

结论：这些是「自研不完整编排器」的结构性缺陷，修补成本高于引入成熟编排器。

## 3. 为什么选 k3s

| 考量 | 结论 |
|---|---|
| API 兼容性 | CNCF 认证发行版，与上游 K8s 100% 兼容，chart 可无缝迁移至客户的标准 K8s / 托管集群 |
| 资源门槛 | 单二进制 <100MB，server ~512MB 内存起，一条命令安装 |
| 数据存储 | 默认 SQLite；HA 可外接 PostgreSQL（kine），与项目已有 PG 栈契合 |
| 内置能力 | Traefik ingress、Service LB、Helm controller 开箱即用 |
| 规模上限 | HA 形态约 1200 agent，远超目标场景 |

### 3.1 k3s 与标准 K8s 的关键差异

| 维度 | 标准 K8s | k3s |
|---|---|---|
| 形态 | 多组件独立部署 | 全部合并进单二进制单进程 |
| 数据存储 | 强制 etcd | SQLite / 外部 PG / 内嵌 etcd 可选 |
| 运行时/CNI/Ingress | 分别自装 | containerd、Flannel、Traefik 内置 |
| 内存开销 | 控制面 ≥2GB | server ~512MB 起 |
| 规模 | 数千节点 | ~1200 agent |
| API 兼容 | 参考实现 | 100% 兼容（CNCF 认证） |

### 3.2 落选方案

- **Nomad/Swarm**：仍需自研或适配存储与调度语义，维护成本问题不变；
- **标准 K8s**：门槛与运维成本不符合自托管定位；同一 chart 可作为规模化退出路径；
- **保留并修补自研节点层**：需补 fencing、幂等协议、负载调度等，工作量接近重写半个编排器。

## 4. 组件去向

| 现有组件 | 去向 |
|---|---|
| postgres / minio | Deployment/StatefulSet 或外部托管服务 |
| server 控制面 | Deployment（`KubernetesContainerBackend`，默认可单副本，事件总线已外置后可水平扩展） |
| web（Nginx 容器） | Ingress 指向 web Service |
| worker-image 构建容器 | 概念消失，镜像推 registry 或 `k3s ctr images import` |
| juicefs sidecar / vm-shared-mounts / rshared 脚本 | JuiceFS CSI driver + StorageClass |
| kross-node（Go 节点进程） | 已删除，kubelet 即节点代理 |
| node token / 8788 内部端口 / per-node compose | 已删除，RBAC ServiceAccount + Service DNS |

Worker 本身零改动：仍是连回控制面的长驻容器，仅连接地址变为 Service DNS。

## 5. 能力边界声明

K8s 提供的是**调度与存活**，「多副本」不等于「集群化」：

- **Worker**：工作区在 JuiceFS PVC（RWX），上 k3s 可换节点；必须保持每个 agent 唯一 Pod 以防双挂载；
- **Java 控制面**：SSE 与 Worker job offer 已走 Redis Pub/Sub（故障降级为进程内扇出），`replicaCount` 可大于 1；调度器仍每副本执行，租约回收依赖 `SKIP LOCKED`，尚未做 advisory lock 选主。工作区文件 RPC 仍要求打到持有该 Worker WebSocket 的副本；
- **PostgreSQL**：装入集群不会自动 HA，需 CloudNativePG operator 或外部 RDS；
  且不建议 kine 数据与业务库共用实例（故障域耦合）。
