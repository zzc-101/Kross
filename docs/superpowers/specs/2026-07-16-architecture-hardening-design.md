# Core Architecture Hardening

本轮重构解决两个问题：`AgentRuntime` 过重，以及 modes/tools/TUI 对 runtime 实现细节的反向依赖。对外行为、公开 `AgentRuntime` API、主 agent 审批语义和 subagent auto-allow 语义保持不变。

## 分层

- `modes`：mode policy、conductor plan schema、pending execution 类型。禁止依赖 `runtime`。
- `tools`：Tool Gateway 与 builtin tools。`Task` 只依赖 `SubagentRunner` 类型和纯格式化函数。
- `host`：core composition root，负责模型、context、tooling、MCP、workspace roots 的装配。
- `workspace`：workspace roots、项目注册、diff 与 Project Instructions 纯加载器；不得反向依赖 runtime、SessionContext 或 TUI。
- `runtime`：运行协调层，由薄门面 `AgentRuntime` 组合以下协作对象：
  - `SessionServices`：mode、permission、pending execution、todo/registry/project-instruction context source lifecycle。
  - `ModelSession`：LLM client、model、thinking effort 绑定。
  - `ModeFlows`：plan gate、conductor gate、worker fan-out 与验收。
  - `RuntimeToolLoop`：主 agent 流式工具环和审批恢复。
  - `completeToolLoop`：subagent 非流式工具环。

## 不变量

1. `AgentRuntime.run` / `runStreaming`、审批、context inspect/compact 等公开方法保持兼容。
2. mode 只决定执行策略，不拥有另一套用户可见输出管线。
3. 主 agent 保持 streaming + approval；subagent 保持 complete + auto-allow。
4. 两种工具环共享 tool metadata 转换、顺序 tool execution 和重复调用 stall detection。
5. TUI 不再拥有 runtime composition root，只消费 core host。
6. `ConversationThread` 继续作为模型对话上下文的单一事实源。
7. 项目指令不写入 `SessionContextState`；构造、请求和恢复后的下一次 context 构建均读取磁盘当前内容。
8. 主 agent 按带 scope 的多 root sources 注入；subagent/conductor worker 只加载实际执行 root。

## Project Instructions 数据流

```text
workspace roots
  -> workspace/projectInstructions (realpath、优先级、UTF-8 预算、诊断)
    -> SessionServices (signature cache、旧 source 清理、pinned source 注入)
      -> AgentRuntime public refresh/get API
        -> TUI /instructions（只展示 provenance，不展示正文）

selected subagent root
  -> 同一纯 loader
    -> child SessionContext（独立 pinned sources）
```

固定语义：root-level only；`CLAUDE.md < AGENTS.md < KROSS.md`；最多 16 文件、单文件 32 KiB、总计 64 KiB；symlink 的 canonical target 必须仍在所属 root 内。

## Skills 数据流

`SkillRegistry` 动态发现 personal 与 workspace Skills；`SessionServices` 只把 metadata 注册到 `SessionContext`，`ReadSkill` 才读取正文或资源。主 agent 使用多 root registry，subagent 为自己的执行 root 建立独立 registry。TUI `/skills` 只消费 `AgentRuntime.refreshSkills()` 返回的 snapshot。

## 刻意保留的边界

- 本轮不收紧 `@kross/core` 全部 public exports。
- 不重构 TUI command bus。
- 不引入 OS sandbox、MCP 热重载或 todo 持久化。
- 不强迫 subagent 采用主 agent 的 streaming/approval 控制流。
