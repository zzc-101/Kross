import { z } from 'zod';

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
}

const taskInputSchema = z.object({
  prompt: z.string().min(1),
  /** Optional label; tool allowlist is always read+edit (no Bash/Delete/Move). */
  mode: z.enum(['explore', 'general']).optional(),
  description: z.string().optional()
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
      '子代理可用 Read/Glob/Grep/List/Stat/Git* 与 Edit/Write；' +
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
        prompt: {
          type: 'string',
          description: '交给子代理的具体任务说明（目标、范围、期望产出）'
        },
        mode: {
          type: 'string',
          enum: ['explore', 'general'],
          description: '可选标签；工具集相同（read+edit，无高危工具）'
        },
        description: {
          type: 'string',
          description: '短标题，便于 UI/trace 展示'
        }
      },
      required: ['prompt'],
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
      const outcome = await options.run({
        prompt: input.prompt,
        mode,
        parentRunId: runId,
        parentDepth,
        signal
      });

      const content = formatSubagentToolContent(outcome);
      const label = input.description?.trim() || mode;
      return {
        content,
        summary: `Task(${label}) → ${outcome.result.status}: ${clip(
          outcome.result.summary,
          160
        )}`,
        data: {
          subRunId: outcome.subRunId,
          mode: outcome.mode,
          modeForcedToExplore: outcome.modeForcedToExplore,
          status: outcome.result.status,
          evidence: outcome.result.evidence,
          risks: outcome.result.risks
        }
      };
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
