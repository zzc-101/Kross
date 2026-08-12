# Kross Terminal-Bench 2.0 Pilot

本目录把 Kross 的 Headless CLI 接入 Harbor 0.20.0，用固定的 10 个
Terminal-Bench 2.0 任务比较 Kross 与 Pi 基线。模型名从当前 Kross 活动档案读取，
两者必须使用同一个模型、Endpoint、
思考强度、任务版本和三次重复运行。该子集是工程接入 Pilot，不冒充完整 TB 2.0
Leaderboard 成绩。

## 任务选择

`tasks.txt` 固定 3 个 easy、4 个 medium、3 个 hard 任务，覆盖代码修改、Git、数据
处理、推理调度、内存调试、数据库恢复、终端操作、异步并发与安全修复。任务集在
正式模型运行前完成 Oracle 预注册；后续不得依据模型成绩换题。正式对外成绩应运行
完整数据集或预注册的新子集。

预注册时原候选题 `write-compressor` 的官方 Oracle 得分为 0，因评分环境不可作为
Agent 能力依据，已在任何模型正式运行前替换为 Oracle 得分 1 的 hard 任务
`llm-inference-batching-scheduler`。运行结果只保存在本机 `results/`，不进入版本库。

## 准备

要求 Docker、Node.js 22.19+、`uv` 和 Harbor 0.20.0：

```bash
uv tool install harbor==0.20.0
npm run package:check
mkdir -p /tmp/kross-pack
npm pack --ignore-scripts --pack-destination /tmp/kross-pack
node benchmarks/terminal_bench/prepare-env.mjs
```

环境文件包含模型密钥，只写到 `.benchmark-secrets/`，权限为 `0600`，不得提交。

## 运行

推荐使用预构建 Linux Runtime 的 10 题快速评测。Node、Kross 和 Linux 原生依赖
只在宿主机的构建容器中安装一次；每个任务容器只上传并解压 Runtime，不再分别访问
GitHub、nodejs.org 或 npm：

```bash
./benchmarks/terminal_bench/run-optimized-10.sh
```

默认每题 1 次、5 容器并发。可通过 `KROSS_TBENCH_CONCURRENCY` 和
`KROSS_TBENCH_ATTEMPTS` 调整。

以下命令保留用于 Kross/Pi 各 3 次的完整 Phase 1 对比；旧式 `package_path`
安装路径会在每个任务容器内联网安装 Node/npm，仅用于兼容：

```bash
./benchmarks/terminal_bench/run-phase1.sh \
  .benchmark-secrets/terminal-bench.env \
  benchmarks/terminal_bench/results \
  /tmp/kross-pack/zzc-101-kross-0.1.0.tgz
```

每个 Agent 执行 10×3 次任务。Harbor Verifier 是任务成功率的唯一事实源；Kross
自然语言结论只用于统计假成功和验证覆盖。原始 Trial、NDJSON、Trace、费用覆盖率
和汇总 JSON 保存在本机 `results/`。该目录默认忽略；需要长期保留或共享成绩时，
应把选定报告发布为独立构建产物。

Kross 与 Pi 都启用容器内停滞检测：20 秒采样一次，6 分钟宽限期；连续 6 分钟
没有非流式动作，或工作区无变化且 Agent 又循环至少 6 个回合时提前停止。提前停止
不会跳过 Verifier，结果中会记录 watchdog 原因。任务自身的 15/30 分钟 timeout
仍作为硬上限。
