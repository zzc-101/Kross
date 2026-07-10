# Runtime 拆分与 TUI 流畅渲染设计

## 目标

在不改变 Kross 对外使用方式的前提下，拆分 `AgentRuntime` 与 `App` 的职责，并消除触摸板滚动、输入、thinking 动画和模型流式输出期间的整屏频闪。

## 已确认根因

1. `App` 的全屏根节点固定为终端总行数。Ink 5.2.1 在 `outputHeight >= stdout.rows` 时，每次更新都发送 `clearTerminal` 并重画整屏。
2. 触摸板输入在 `useMouseScroll` 和 `App.scrollBy` 中连续经过两次约 16ms 的帧调度，实测回调延迟由约 18ms 增至约 34ms。
3. `windowPaintRows` 每次改变 `scrollOffset` 都重新展平全部历史 paint items；缓存避免了重复 Markdown 解析，但没有避免 O(历史行数) 的扫描和临时对象分配。
4. 每个 SSE `text-delta` / `thinking-delta` 都立即更新 React 消息状态。Ink 自身以约 32ms 节流输出，因此更高频率的状态更新只会增加布局和重绘压力。

## 架构设计

### Core Runtime

`AgentRuntime` 继续作为唯一公开门面，保留现有构造函数和公开方法。内部拆成以下单元：

- `agentRuntimeTypes.ts`：运行输入、流式事件、上下文检查和依赖选项类型。
- `runtimeInspection.ts`：`/trace`、`/diff` 的读取、校验和格式化。
- `toolLoop.ts`：模型工具循环、批量工具调用、审批会话恢复和软着陆。
- `agentRuntime.ts`：模式检测、run 生命周期、流式事件编排、会话历史和 trace 记录。

拆分只改变内部依赖方向；`packages/core/src/index.ts` 的导出保持兼容。

### TUI

`App` 继续保留现有 `AppProps` 和 `AppTestApi`。内部拆成：

- `app/appCommands.ts`：斜杠命令、配置导入和上下文格式化。
- `app/traceMessages.ts`：trace 事件到工具消息的映射及审批结果展示。
- `app/useViewportScroll.ts`：scroll offset、边界钳制和新消息回底部。
- `app/messageUpdateBuffer.ts`：合并一帧内同一消息的多次文本更新。
- `app/AppShell.tsx`：全屏三区布局、footer/header 高度计算和根节点安全行数。
- `App.tsx`：组合运行时、会话状态和上述模块。

### 渲染数据流

触摸板事件只在 `useMouseScroll` 中合并一次，然后直接更新 viewport scroll state。消息内容或终端宽度变化时构建 `PaintLayout`；仅 scroll offset 变化时，基于稳定布局索引二分定位可见区域。流式增量以 32ms 为上限合并，工具调用、轮次切换和最终结果前强制 flush。

全屏根布局使用 `rows - 1` 的安全高度，确保 Ink 进入行擦除更新路径而不是 `clearTerminal` 整屏清空路径。预留行位于 alternate screen 内，不改变普通文档流模式。

## 错误与边界处理

- 终端高度最小为 1，所有计算都钳制为正数。
- resize 会重建 paint layout 并钳制当前 offset。
- 流式 buffer 在轮次切换、工具执行、结果返回、异常和组件卸载时 flush 或 cancel，不能丢失末尾文本。
- 工具卡仍作为完整组件进入视口，不从中间切断。
- 非 TTY 测试和文档流渲染保持现状。

## 验证设计

- 现有 220 个测试作为公共行为回归基线。
- 假 TTY 集成测试直接捕获 stdout ANSI，断言全屏 App 更新不包含 Ink 的 `clearTerminal`。
- 调度测试断言一次触摸板输入只经过一次 frame scheduler。
- paint layout 测试断言重复滚动复用同一布局，不再次 paint 全部消息。
- message buffer 测试断言同一帧多次增量只 flush 一次且保留完整最新文本。
- 最终运行全量 Vitest、TypeScript typecheck，并复查 `git diff --check`。

## 非目标

- 不替换 Ink，不引入新的状态管理库。
- 不改变 Markdown 视觉样式、工具审批语义或模型协议。
- 不在本次重构中实现 cross-repo、MCP、持久化 memory 或 OS 级沙箱。
