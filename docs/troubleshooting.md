# 故障排查

## TUI 无法启动

先确认 Node.js：

```bash
node --version
```

Kross 要求 Node.js `>= 22.19`。然后重新安装依赖并运行：

```bash
npm install
npm run dev --workspace @kross/tui
```

## TUI 中无法复制文本

全屏模式下直接按住左键拖选；松开后，Kross 会自动复制选中的文本。本地终端优先使用系统剪贴板，SSH 终端会尝试通过 OSC 52 把内容交给客户端终端。

如果当前终端、跳板机或安全策略禁止剪贴板转发，可关闭 Kross 的鼠标接管，改用终端自身的拖选与复制：

```bash
KROSS_DISABLE_MOUSE=1 kross
```

关闭后，TUI 内的鼠标滚动和点击也会停用，键盘操作不受影响。

## 能进入 TUI，但没有真实模型回复

运行：

```text
/status
/model
```

在模型面板中确认可用模型；环境变量示例：

```bash
export AGENT_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-5
```

也可以执行 `/import claude` 或 `/import codex`。如果环境变量只配置了一部分，Kross 会尝试回退到 `~/.kross/config.json` 中可用的同 Provider 配置。

## `/import` 没有可导入配置

导入只在检测到对应工具配置且能解析出模型时可用。检查：

- Codex：`~/.codex/config.toml`、`~/.codex/auth.json` 或相关环境变量。
- Claude Code：`~/.claude/settings.json`、`~/.claude.json` 或相关环境变量。

也可以跳过导入，直接使用环境变量或手动维护 `~/.kross/config.json`。

## 计划一直等待确认

`plan` 和 `conductor` 模式会在执行前暂停。输入：

```text
/approve
```

或取消：

```text
/reject
```

按 `Esc` 也会取消待确认计划，并清除持久化 pending 状态。

## 提示缺少 workspace root

恢复的 conductor 计划可能引用当前会话尚未恢复的 repo id。先重新加入目录：

```text
/add-dir /absolute/path/to/repo
/dirs
/approve
```

计划会保留，目录恢复后可再次批准。

## `/undo` 报 conflict

这表示目标事务执行后，相关文件又发生了变化。Kross 会拒绝强制覆盖。

建议：

1. 用 `/diff` 和 Git 检查当前改动。
2. 手工保存需要保留的内容。
3. 明确解决冲突后再决定是否人工恢复。

Kross 当前不提供 `--force` undo。

## `/resume` 找不到会话

- 不带参数执行 `/resume`，从当前 workspace 的最近会话中选择。
- 会话按 workspace 隔离；确认你从正确目录启动。
- 会话事实源位于 `~/.kross/sessions`，`~/.kross/session-store.db` 只是可重建索引。

## 恢复会话后工具审批面板没有出现

只有“尚未执行且证据完整”的工具审批可以恢复。以下情况会 fail-closed，并把上次轮次标记为 interrupted：

- 保存的 assistant tool call 或已完成 tool result 缺失；
- 工具已被移除或输入不再符合当前 schema；
- 动态风险或当前审批策略与保存时不一致；
- 上次进程在普通 LLM / 工具执行中间点退出，而不是停在审批边界。

Kross 不会为了恢复界面而猜测性重放 write / execute 操作。先用 Git、`/diff` 或 `/trace` 确认已有结果，再发送一条新任务继续。

## `/processes` 看不到之前的进程

managed process 按持久化会话隔离。切换到其他会话后不可查看或控制原会话进程；恢复原 session 后会重新可见。

后台进程不会跨 Kross 进程重启重连。若 Kross 异常退出，应使用系统工具确认是否仍有遗留进程。

## MCP server 没有加载

检查 `~/.kross/mcp.json` 或 `config.json`：

- `command` 必须存在且可执行。
- `args` 必须是字符串数组。
- `cwd` 必须有效。
- `disabled` 不能为 `true`。
- 可增加 `connectTimeoutMs`。

单个 MCP server 失败不会阻止 Kross 启动，错误会输出到 stderr。修改配置后需要重启 Kross；当前没有热重载。

## 上下文过大或回答遗忘旧信息

先查看：

```text
/context
```

再按需压缩：

```text
/compact 保留精确文件路径、命令、错误文本和所有未完成事项
```

也可以在 `~/.kross/config.json` 调整 `context.preserveRecentTokens`、`preserveFullTurns` 和 `compactionInstructions`。

## 测试似乎运行了旧代码

该仓库的 TypeScript build 会刷新源码旁的 ignored JavaScript 产物。开发中如果测试表现与 TypeScript 源码不一致，先执行：

```bash
npm run build
npm test -- --run
```
完整验证：

```bash
npm run check
```
