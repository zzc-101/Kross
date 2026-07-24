# 扩展 Kross

Kross 提供三层扩展方式。优先选择配置和文件约定；只有这些方式无法满足需求时，
再修改 Core 或 Cloud 协议。

## 扩展层级

| 层级 | 适合场景 | 当前兼容性 |
|---|---|---|
| 配置扩展 | 项目规则、Skills、MCP、兼容模型端点 | `0.x` 期间尽量保持向后兼容 |
| 源码扩展 | 自定义工具、审批策略、Runtime 宿主 | 预览接口，升级时需要跟随类型检查 |
| 协议扩展 | 自定义 Web、移动端或远程 Worker | 以 `PROTOCOL_VERSION` 和 Zod schema 为准 |

`packages/core` 和 `packages/protocol` 目前是 monorepo 私有 workspace，尚未作为稳定
SDK 单独发布。可以在 Fork 或同一仓库中复用它们，但不要假设所有导出都遵循稳定
语义化版本。

## Project Instructions

无需编写代码即可让 Agent 遵循项目约定。在每个授权 workspace 根目录放置以下
任一文件：

```text
CLAUDE.md
AGENTS.md
KROSS.md
```

同一目录中后者优先级更高。适合记录：

- 构建、测试和格式化命令；
- 目录职责与依赖方向；
- 禁止修改的生成文件；
- 安全限制和提交规范。

当前只扫描授权 root 顶层，不递归加载子目录规则。使用 `/instructions` 检查实际
加载来源和诊断信息。

## Skills

Skill 是带说明的按需知识包。支持两个位置：

```text
~/.kross/skills/<id>/SKILL.md
<workspace>/.agents/skills/<id>/SKILL.md
```

最小示例：

```markdown
---
name: release-check
description: 检查版本、变更记录和发布前验证结果
---

# Release Check

1. 读取 package.json 和 CHANGELOG.md。
2. 运行项目规定的类型检查与测试。
3. 报告版本不一致、未提交文件和验证失败。
```

Kross 启动时只把 Skill 的名称和描述加入上下文，需要时再通过 `ReadSkill` 读取
正文。Skill 中出现的命令不会自动获得执行权限，仍然经过正常工具审批。修改 Skill
后使用 `/skills` 刷新并检查发现结果。

## MCP 工具

无需修改 Kross 源码即可通过 stdio MCP server 增加工具。配置文件可以放在
`~/.kross/mcp.json`，也可以写入 `~/.kross/config.json` 的 `mcpServers`：

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": {
        "EXAMPLE_TOKEN": "replace-me"
      },
      "cwd": "/optional/working/directory",
      "risk": "network",
      "connectTimeoutMs": 12000,
      "disabled": false
    }
  }
}
```

注册后的名称格式为 `<serverId>__<toolName>`。服务器级 `risk` 可设置为 `read`、
`write`、`execute` 或 `network`；未设置时优先读取 MCP annotations，无法判断时
按 `network` 处理并要求审批。

当前边界：

- 只支持 stdio transport；
- 支持 tools，不支持 resources 和 prompts；
- 单个 MCP 连接失败不会阻止其他服务或 Kross 启动；
- 修改 MCP 配置后需要重启；
- MCP 子进程拥有当前用户权限，不能把审批等同于 OS 沙箱。

不要把真实密钥提交到仓库。公开 Issue 中的配置示例也应删除 token、绝对用户名
路径和私有仓库地址。

## 兼容模型端点

优先通过现有 Provider 的 `*_BASE_URL` 接入兼容服务，而不是直接增加 Provider：

```bash
export AGENT_LLM_PROVIDER=openai
export OPENAI_API_KEY=...
export OPENAI_MODEL=my-model
export OPENAI_BASE_URL=https://example.com/v1
```

Anthropic-compatible 服务使用对应的 `ANTHROPIC_*` 字段。兼容端点仍需正确实现
流式输出、工具调用和当前 Provider 的消息格式。只支持普通文本对话但不支持工具
调用的端点，无法完成完整 Agent 循环。

增加全新协议类型属于源码扩展，需要同时处理：

- 凭证和配置解析；
- 模型列表与上下文窗口；
- 流式文本、思考内容和工具调用转换；
- 错误分类、取消和重试；
- Core、TUI、Worker 与 Web 的相关测试。

## 源码级自定义工具

在 Fork 或 monorepo 内，可以向 `ToolGateway` 注册 `ToolDefinition`：

```ts
import { z } from 'zod';
import {
  AgentRuntime,
  bootstrapRuntimeTooling,
  createRuntimeOptionsFromEnv
} from '@kross/core';

export async function createCustomRuntime() {
  const cwd = process.cwd();
  const tooling = await bootstrapRuntimeTooling(cwd, process.env);

  tooling.toolGateway.register({
    name: 'ProjectMetadata',
    description: '读取当前项目的公开元数据',
    risk: 'read',
    inputSchema: z.object({}),
    async execute({ signal }) {
      signal.throwIfAborted();
      return {
        content: JSON.stringify({ cwd }),
        summary: 'project metadata loaded'
      };
    }
  });

  const runtime = new AgentRuntime(
    createRuntimeOptionsFromEnv(cwd, process.env, undefined, {}, tooling)
  );

  return {
    runtime,
    // 宿主退出时必须释放 MCP、进程和 trace 资源。
    close: () => tooling.close()
  };
}
```

自定义工具应满足以下约束：

1. `inputSchema` 必须拒绝未知或危险输入。
2. `risk` 和 `resolveRisk` 必须反映真实副作用。
3. 输入含密钥时实现 `redactInputForTrace`。
4. 长任务响应 `AbortSignal`，不要遗留子进程。
5. `summary` 保持简短，`content` 面向模型，`data` 保持可序列化。
6. 不要绕过 `ToolGateway` 直接执行需要审批的副作用。

内置宿主组合入口位于
[`packages/core/src/host/createAgentHost.ts`](../packages/core/src/host/createAgentHost.ts)；
工具契约位于
[`packages/core/src/tools/toolGateway.ts`](../packages/core/src/tools/toolGateway.ts)。
如果需要长期维护大量自定义工具，优先实现 MCP server，减少与 Core 内部结构的
耦合。

## 自定义客户端与 Cloud Protocol

Cloud 的线协议由 `packages/protocol` 中的 Zod schema 定义。客户端发送的每条
命令必须携带：

```ts
{
  protocolVersion: 1,
  requestId: 'client-generated-id'
}
```

扩展客户端时：

- 从 `clientCommandSchema` 和 `serverEventSchema` 推导类型，不复制手写接口；
- 按 `seq` 处理事件、断线重放和去重；
- 用 `requestId` / `correlationId` 关联命令与结果；
- 保留工具审批、计划审批和取消语义；
- 遇到不支持的 `PROTOCOL_VERSION` 时明确失败。

当前 HTTP 路由、容器名称、Worker 持久化目录和 Web 组件树属于内部实现，不是稳定
扩展 API。协议入口见
[`packages/protocol/src/schemas.ts`](../packages/protocol/src/schemas.ts)，现有 Web
客户端是首选参考实现。

## 不应依赖的内部细节

以下内容可能在 `0.x` 版本中直接调整：

- `~/.kross` 内 JSONL、SQLite 和 trace 的具体字段布局；
- Runtime 内部类的构造顺序；
- Gateway 私有 HTTP 路径；
- Docker 容器标签、网络名称和挂载细节；
- TUI/Web 组件层级和 CSS class；
- 未从 package `index.ts` 导出的源码文件。

需要这些能力时，请先创建 Feature Request，说明使用场景。更合适的处理通常是
新增一个窄而稳定的扩展接口，而不是把内部实现永久公开。

## 提交扩展

准备向上游贡献扩展时，请同时提供：

- 使用场景和不修改 Core 时为何无法实现；
- 权限风险与失败恢复策略；
- 最小测试；
- 配置和用户文档；
- 对 TUI、Cloud Worker 和协议兼容性的影响。

贡献流程见[参与贡献](../CONTRIBUTING.md)。
