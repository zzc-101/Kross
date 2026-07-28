# Headless 自动化

`kross exec` 在不启动 Ink TUI 的情况下运行一次真实 Agent Runtime，适合 Shell
管道、CI 检查和自定义宿主。该命令与 TUI 使用同一套模型配置、工具、权限、
Session、Trace、Mutation、Process 和 MCP 生命周期。

## 基本用法

直接传入任务：

```bash
kross exec "检查当前改动并报告风险" --json
```

从标准输入读取任务：

```bash
printf '%s' "检查并修复当前测试" | kross exec --stdin --json
```

指定工作目录、模式、权限或已有会话：

```bash
kross exec "继续分析失败原因" \
  --json \
  --cwd /workspace/repo \
  --mode auto \
  --permission default \
  --session session-...
```

当前 `exec` 必须显式提供 `--json`。任务内容只能来自一个位置：位置参数或
`--stdin`。`--session` 会恢复相同 workspace 下的模型上下文、Todo、待执行模式
和 Run Checkpoint；不存在、属于其他 workspace 或损坏的会话会以配置错误退出。

## NDJSON 输出

`stdout` 只写一行一个 JSON 对象的 NDJSON 事件；日志、配置诊断和清理警告写到
`stderr`。每个事件都包含：

- `schemaVersion`：当前为 `1`；
- `type`：事件类型；
- `timestamp`：ISO 8601 时间；
- `runId`、`sessionId`：运行和会话标识；
- `sequence`：从 `0` 开始的本次命令内顺序；
- `data`：由事件类型决定的结构化数据。

事件类型包括 `run.started`、`turn.started`、`tools.started`、`text.delta`、
`thinking.delta`、`approval.required`、`run.completed` 和 `error`。完整机器契约
见 [Headless Event v1 JSON Schema](schemas/kross-headless-event-v1.schema.json)。
消费者必须按 `schemaVersion` 解析，并忽略自己不需要的事件，不能依赖自然语言
`summary` 的固定措辞。

使用 `jq` 只读取最终结果：

```bash
set -o pipefail
kross exec "检查项目" --json \
  | jq -c 'select(.type == "run.completed" or .type == "error")'
```

设置 `pipefail` 很重要，否则 Shell 可能只返回管道最后一个程序的退出码。

## 退出码

| 退出码 | 含义 |
|---:|---|
| `0` | Runtime 完成，且没有失败验证 |
| `2` | 参数或输入错误 |
| `3` | 模型、工作目录或会话配置错误 |
| `4` | 需要工具或计划审批，未在非交互命令中执行 |
| `5` | Runtime 失败或非审批类取消 |
| `6` | Verification Report 为 `failed`，即使模型文本声称成功 |
| `130` | SIGINT、SIGTERM 或用户中断 |

`not-run` 不等于 `failed`，因此可能仍返回 `0`；自动化应同时检查
`run.completed.data.verificationStatus` 和 `risks`，按自身质量门决定是否接受。

## 权限与审批

Headless 默认使用 `--permission default`，不会因为运行在 CI 中自动提升权限：

- `default`：只读调用自动执行，write / execute / network 在审批边界退出 `4`；
- `classifier`：工作区内常见写操作可自动执行，Shell 和网络通常仍需审批；
- `auto`：白名单内工具全部自动批准，只能在明确隔离、可信任务和可信仓库中使用。

第一版 Headless 不提供交互式审批。出现 `approval.required` 后，可以用事件中的
`sessionId` 在 TUI 中恢复并审阅。`plan` 和 `conductor` 模式同样会先持久化计划，
然后以退出码 `4` 停在确认门。

不要为了让 CI “跑过去”而默认添加 `--permission auto`。本机运行时，Agent 的
Bash 和后台进程使用当前用户权限；仓库中的提示词、配置和 Skills 也应按不可信
输入处理。Cloud Headless 任务则使用对应 Worker 容器作为执行边界。

## 密钥与日志

- 通过 CI Secret 或进程环境提供模型密钥，不要把密钥写进参数、任务或仓库。
- NDJSON、Trace、验证输出和会话可能包含源码、路径或工具参数，上传 Artifact
  前先确认保留范围。
- Headless 使用与 TUI 相同的 `~/.kross` 持久化目录；CI 若不需要跨任务恢复，
  应使用临时 HOME 并在 Job 结束后删除。
- `--cwd` 不改变工具安全边界的本质；批准 Bash 后，命令仍可能访问工作区外资源。

## GitHub Actions 示例

仓库提供一份只读审查示例：
[headless-github-action.yml](examples/headless-github-action.yml)。它从 Secret
读取模型密钥，将 NDJSON 保存为 Artifact，并保持默认权限，因此任何写入或执行
请求都会以 `4` 停止。

当前还没有稳定 npm 版本，示例从源码执行 `dist/kross.js`。发布后可以把安装和
构建步骤替换为固定版本的全局或项目依赖。

## 无模型 Smoke

安装包验证会在清空模型环境并使用临时 HOME 后执行：

```bash
kross exec "inspect the package" --json
```

命令必须快速返回退出码 `3`，且 `stdout` 只有一个
`error(category=configuration)` 事件，证明 Headless 不会进入 TUI onboarding
或等待交互输入。该检查包含在：

```bash
npm run package:check
```
