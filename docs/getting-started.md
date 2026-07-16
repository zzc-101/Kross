# 快速上手

本指南从源码启动 Kross，并完成第一个受审批保护的编程任务。

## 1. 准备环境

需要：

- Node.js `>= 22.19`
- npm
- 一个希望 Kross 操作的本地项目目录

确认版本：

```bash
node --version
npm --version
```

## 2. 安装

```bash
git clone https://github.com/zzc-101/Kross.git
cd Kross
npm install
```

Kross 当前从源码运行，尚未发布稳定的全局 CLI 包。仓库已经提供 `@zzc-101/kross` 的构建与安装冒烟测试；首个 npm 版本发布后可以全局安装并直接运行 `kross`。

## 3. 配置模型

### 从已有工具导入

首次启动若检测到 Claude Code 或 Codex 配置，Kross 会显示导入提示：

```text
/import claude
/import codex
/import skip
```

导入结果写入 `~/.kross/config.json`。

### 使用环境变量

OpenAI 示例：

```bash
export AGENT_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-5
```

Anthropic 示例：

```bash
export AGENT_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL=claude-sonnet-4-5
```

其他 Provider 和完整字段见 [配置参考](configuration.md)。

## 4. 启动

从 Kross 仓库启动：

```bash
npm run dev
```

没有模型配置时 TUI 仍会启动，但普通任务只会提示补充模型配置。要处理其他本地项目，可在启动后通过 `/add-dir` 授权对应目录。

## 5. 完成第一个任务

直接输入自然语言：

```text
检查当前分支的改动，找出最可能的回归并运行相关测试。
```

默认权限模式下：

1. 读取类工具自动执行。
2. 写文件、运行命令或访问网络前暂停。
3. 审批面板展示工具、风险类型和输入预览。
4. 选择 Approve 或 Reject 后继续运行。

审批时可使用方向键切换，按 Enter 确认，也可以按 `a` 批准或 `r` 拒绝。

## 6. 选择工作方式

### 自动模式

```text
/mode auto
```

适合大多数任务。Agent 直接工作，也可根据任务复杂度进入计划或编排流程。

### 计划模式

```text
/mode plan
重构配置模块，但先给我完整计划。
/approve
```

计划未批准前不会开始文件修改。

### 指挥家模式

```text
/mode conductor
把认证改造拆成独立任务，交给 worker 执行并统一验收。
```

指挥家模式用于任务编排；它与是否添加多个目录没有绑定关系。

## 7. 添加其他 workspace

```text
/add-dir ~/work/api
/add-dir ~/work/web
/dirs
```

文件工具只能访问主 workspace 和显式加入的 roots。移除目录：

```text
/remove-dir api
```

## 8. 检查与恢复

```text
/diff
/trace
/context
/undo
/resume
```

- `/diff` 查看 Agent 触达的文件和 Git 变更摘要。
- `/trace` 查看最近运行和工具事件。
- `/context` 查看上下文预算与来源。
- `/undo` 在文件未被后续修改时撤销最近事务。
- `/resume` 打开最近会话选择器。

下一步可阅读 [命令手册](command-reference.md) 和 [安全模型](security.md)。
