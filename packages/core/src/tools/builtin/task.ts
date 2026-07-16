import { z } from 'zod';

import { isOperationAborted } from '../../abort';
import {
  formatSubagentToolContent,
  runSubagent,
  type SubagentMode,
  type SubagentRunDeps,
  type SubagentRunRequest
} from '../../runtime/subagentRunner';
import type { ToolDefinition } from '../toolGateway';

export interface CreateTaskToolOptions {
  /** Depth of the runtime that owns this Task tool (0 = main). */
  parentDepth?: number;
  run: (
    request: SubagentRunRequest
  ) => Promise<Awaited<ReturnType<typeof runSubagent>>>;
  /**
   * Resolve registry repo id → absolute workspace path.
   * When set, Task accepts optional `repoId` for multi-repo spawn.
   */
  resolveRepoPath?: (repoId: string) => string | undefined;
}

/** 短标题：必填，供 TUI 底栏单行展示；模型调用 Task 时必须传。 */
const TITLE_MAX = 48;

const taskInputSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, 'description (short title) is required')
    .max(TITLE_MAX),
  prompt: z.string().min(1),
  /** Optional label; tool allowlist is always read+edit (no Bash/Delete/Move). */
  mode: z.enum(['explore', 'general']).optional(),
  /**
   * Optional project-registry repo id. Subagent tools bind to that repo's path
   * (must be in the runtime allowlist). Prefer this over inventing absolute paths.
   */
  repoId: z.string().min(1).optional()
});

type TaskInput = z.infer<typeof taskInputSchema>;

/**
 * Spawn a subagent with basic read/edit tools only (no high-risk tools, no approval).
 * Nested Task is rejected via parentDepth / maxDepth.
 */
export function createTaskTool(
  options: CreateTaskToolOptions
): ToolDefinition<TaskInput> {
  const parentDepth = options.parentDepth ?? 0;

  return {
    name: 'Task',
    description:
      '派生子代理在独立上下文中完成聚焦任务并返回摘要。' +
      '调用时必须同时提供 description（极短标题，用于 UI 单行展示）与 prompt（完整任务说明）。' +
      '可选 repoId：在跨仓项目中指定 project registry 中的仓库 id，子代理将绑定该仓库路径。' +
      '子代理可用 Read/Glob/Grep/Rg/List/Stat/Git* 与 Edit/Write；' +
      '不可用 Bash/Delete/Move/Task 等高危工具，子代理内无需用户审批。' +
      '子代理不能再派生子代理。',
    risk: 'read',
    category: 'agent',
    timeoutMs: 300_000,
    retry: false,
    inputSchema: taskInputSchema,
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description:
            '必填。极短任务标题（建议 4–20 字，最多 48 字符），仅用于 UI 底栏单行展示，' +
            '例如「追加 test.txt」「扫描 auth 路由」。不要写完整指令。'
        },
        prompt: {
          type: 'string',
          description:
            '必填。交给子代理的完整任务说明（目标、范围、期望产出、约束）'
        },
        mode: {
          type: 'string',
          enum: ['explore', 'general'],
          description: '可选标签；工具集相同（read+edit，无高危工具）'
        },
        repoId: {
          type: 'string',
          description:
            '可选。project registry 中的仓库 id；指定后子代理在该仓库根目录下读写，' +
            '用于多目录/指挥家编排（/add-dir 的 id 或 registry repo id）。不填则使用主工作区。'
        }
      },
      required: ['description', 'prompt'],
      additionalProperties: false
    },
    execute: async ({ input, runId, signal }) => {
      if (parentDepth >= 1) {
        return {
          content:
            'Task denied: nested subagents are not allowed (maxDepth=1).',
          summary: 'nested Task denied'
        };
      }

      const mode = (input.mode ?? 'explore') as SubagentMode;
      const title = input.description.trim();
      const repoId = input.repoId?.trim();

      let workspaceRoot: string | undefined;
      if (repoId) {
        if (!options.resolveRepoPath) {
          return {
            content:
              `Task failed: repoId=${repoId} 需要 project registry，` +
              '请配置 ~/.kross/projects.json 后重试。',
            summary: `Task repoId unresolved: ${repoId}`
          };
        }
        const resolved = options.resolveRepoPath(repoId);
        if (!resolved) {
          return {
            content:
              `Task failed: unknown repoId "${repoId}"。` +
              '请使用 registry 中已声明的仓库 id。',
            summary: `unknown repoId: ${repoId}`
          };
        }
        workspaceRoot = resolved;
      }

      try {
        const outcome = await options.run({
          prompt: input.prompt,
          mode,
          title,
          parentRunId: runId,
          parentDepth,
          signal,
          repoId,
          workspaceRoot
        });

        const content = formatSubagentToolContent(outcome);
        const label = repoId ? `${title}@${repoId}` : title;
        return {
          content,
          summary: `Task(${label}) → ${outcome.result.status}: ${clip(
            outcome.result.summary,
            160
          )}`,
          data: {
            subRunId: outcome.subRunId,
            mode: outcome.mode,
            title,
            repoId,
            workspaceRoot,
            status: outcome.result.status,
            evidence: outcome.result.evidence,
            risks: outcome.result.risks,
            changedFiles: outcome.result.changedFiles
          }
        };
      } catch (error) {
        // 取消是正常终态：必须向上抛，让 tool batch / 父 run 走 cancelled，
        // 不能包装成成功的 tool observation，否则 Esc 后父循环会继续跑。
        if (isOperationAborted(error, signal)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: `Task failed: ${message}`,
          summary: `Task(${title}) failed: ${clip(message, 120)}`
        };
      }
    }
  };
}

/** Build a default Task runner bound to shared LLM/trace/workspace. */
export function createDefaultSubagentRunner(
  deps: SubagentRunDeps
): CreateTaskToolOptions['run'] {
  return (request) => runSubagent(request, deps);
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
