# 确定性 Eval

Kross 使用独立的 `@kross/eval` workspace 验证 Agent Harness 的完成契约。当前
Eval 只运行仓库内的 Fixture LLM，不读取模型凭证、不访问模型服务，也不会进入
发布的 CLI 包。

## 运行方式

运行全部 Fixture Case：

```bash
npm run eval -- --fixture
```

只运行一个 Case：

```bash
npm run eval -- --fixture --case read-fixture
```

默认情况下，通过的临时工作区会被删除；失败的工作区和 `report.json` 会保留，
两个路径都会写到 `stderr`。排查通过用例时也可以保留工作区和报告：

```bash
npm run eval -- --fixture --case read-fixture --keep
```

生成逐案例报告和 Provider/模型聚合矩阵：

```bash
npm run eval -- --fixture --matrix
```

JSON 报告始终单独写到 `stdout`，便于 CI 或后续工具消费。只要有一个 Case
未通过，命令就以非零状态退出。未显式提供 `--fixture` 时命令会拒绝运行，防止
普通 CI 意外使用真实模型或产生费用。

## Case 契约

Case 位于 `packages/eval/cases/*.json`，使用版本化的 `schemaVersion`。每个
Case 定义：

- fixture 目录、用户 Prompt 和运行模式；
- 允许使用的工具；
- 最大工具迭代数和超时时间；
- 必须修改或不得修改的相对文件路径；
- 不通过 shell 执行的验证命令、参数及预期退出码；
- 预期结果状态、必需工具调用和禁止工具调用；
- 标签、能力和按顺序返回的 Fixture LLM 响应。

Runner 每次把初始 fixture 复制到新的系统临时目录，再创建独立的
Mutation Coordinator、Workspace Roots、Tool Gateway、Trace Store 和真实
`AgentRuntime`。工具白名单之外的调用会被策略拒绝，工具重试在 Eval 中关闭。

## 报告契约

报告同样使用版本化 schema，包含：

- 应用、Prompt、Provider 和模型版本；
- Case 状态、结构化断言得分及失败分类；
- 基于 SHA-256 快照得到的新增、修改和删除文件；
- 验证命令状态和规范化输出；
- 真实 Trace 中的工具调用与工具迭代；
- token 用量、估算成本和结果验证状态；
- Case 标签和能力。

`--matrix` 输出中的 `providerMatrix` 按 `provider/model` 聚合通过率、每项
capability 的通过/失败证据、token、总延迟/平均延迟/p95、限流和稳定错误类别。
费用缺失时 `pricingCoverage` 为 `partial` 或 `unavailable`，不会使用未经验证的
静态价格补零。

Fixture 模式使用固定时钟、固定 run id、脚本响应和零成本，`durationMs` 固定为
`0`，因此 JSON 可以稳定比较。断言依赖结构化结果、文件 hash、Trace 与命令退出
状态，不匹配模型自然语言的精确措辞。

每个产生结果的 Fixture Case 还必须通过 `trace-replay` 断言：Runner 只选择最终
结果对应的 run，严格验证事件 ID、run id、时间顺序、已知事件类型、起止边界与
工具生命周期，再派生状态。回放是纯函数，不会再次执行 Fixture 工具；该断言曾
直接发现 Runtime 与 Tool Gateway 使用不同确定性时钟导致的事件倒序。

## 当前 Case

| Case | 保护的契约 |
|---|---|
| `read-fixture` | 真实 Runtime/Trace 的最小只读闭环 |
| `typescript-fix` | 单文件 TypeScript 修复后由真实 `tsc` 验证 |
| `verification-failure` | 测试失败不能被模型的成功文案覆盖 |
| `stall-guard` | 相同调用与结果只恢复一次，随后失败收口 |
| `checkpoint-resume` | 审批边界跨 Runtime 恢复且不重放已完成调用 |
| `conductor-review` | Worker 变更必须经过最终 Git diff reviewer 验收 |

## 添加 Case

1. 在 `packages/eval/fixtures/<case-id>/` 创建最小输入项目。
2. 在 `packages/eval/cases/<case-id>.json` 定义版本化 Case。
3. 先单独运行该 Case，再运行全部 Fixture Eval。
4. 为 Runner 的新行为在 `packages/eval/src/` 添加 Vitest 测试。

Fixture 应尽量小、可跨平台且不包含依赖缓存。验证命令必须直接指定可执行文件和
参数，不能依赖 shell 展开。普通 Fixture Case 不应读取网络、用户主目录、真实
模型配置或仓库外部状态。

## 当前边界

- 当前只有确定性 Fixture 通道，还没有真实模型、方差和预算控制。
- Fixture LLM 用于验证 Harness 合约，不代表任何模型的实际任务质量。
- Fixture 矩阵只证明报告算法和 Runtime 契约；具体模型兼容结论必须来自相同 Case
  的真实 Provider 数据。
- Case 集保护关键完成与恢复契约，但不是通用编码能力 Benchmark。
