import { z } from 'zod';

import { isOperationAborted } from '../../abort';
import { formatSubagentToolContent } from '../../runtime/subagentFormat';
import type {
  SubagentMode,
  SubagentRunner,
  SubagentRunOutcome
} from '../../runtime/subagentTypes';
import type { ToolDefinition } from '../toolGateway';

export interface CreateTaskToolOptions {
  /** Depth of the runtime that owns this Task tool (0 = main). */
  parentDepth?: number;
  run: SubagentRunner;
  /**
   * Resolve registry repo id → absolute workspace path.
   * When set, Task accepts optional `repoId` for multi-repo spawn.
   */
  resolveRepoPath?: (repoId: string) => string | undefined;
  /** Override tool content formatting (defaults to formatSubagentToolContent). */
  formatOutcome?: (outcome: SubagentRunOutcome) => string;
}

/** Short title shown in task progress. */
const TITLE_MAX = 48;

const taskInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title is required')
    .max(TITLE_MAX),
  goal: z.string().min(1),
  /** Explore is read-only by policy; general may use read+edit tools. */
  mode: z.enum(['explore', 'general']).optional(),
  /**
   * Optional project-registry repo id. Subagent tools bind to that repo's path
   * (must be in the runtime allowlist). Prefer this over inventing absolute paths.
   */
  repoId: z.string().min(1).optional(),
  /** Optional configured Kross model profile id. */
  modelProfileId: z.string().trim().min(1).optional()
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
  const formatOutcome = options.formatOutcome ?? formatSubagentToolContent;

  return {
    name: 'Task',
    description:
      '派生子代理在独立上下文中完成聚焦工作并返回产物、证据和未完成项。' +
      '调用时必须同时提供 title（极短标题）与 goal（完整目标）。' +
      '可选 repoId：在跨仓项目中指定 project registry 中的仓库 id，子代理将绑定该仓库路径。' +
      '可选 modelProfileId：指定已配置的 Kross 模型档案；不填则继承当前模型。' +
      '子代理基础可用 Read/Glob/Grep/Rg/List/Stat；' +
      'mode=explore 时只读调查，mode=general 时额外允许 Edit/Write 完成任务范围内的修改；' +
      '不可用 Bash/Delete/Move/Task 等高危工具，子代理内无需用户审批。' +
      '子代理不能再派生子代理。',
    risk: 'read',
    resolveRisk: (input) => (input.mode === 'general' ? 'write' : 'read'),
    category: 'agent',
    timeoutMs: 300_000,
    retry: false,
    inputSchema: taskInputSchema,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            '必填。极短任务标题（建议 4–20 字，最多 48 字符）。'
        },
        goal: {
          type: 'string',
          description: '必填。交给子代理的完整目标、范围、期望产物与约束。'
        },
        mode: {
          type: 'string',
          enum: ['explore', 'general'],
          description:
            '可选，默认 explore。explore=只读调查；general=可使用允许的编辑工具完成修改。两者均无 Bash/Delete/Move/Task。'
        },
        repoId: {
          type: 'string',
          description:
            '可选。project registry 中的仓库 id；指定后子代理在该仓库根目录下读写，' +
            '用于多目录/指挥家编排（/add-dir 的 id 或 registry repo id）。不填则使用主工作区。'
        },
        modelProfileId: {
          type: 'string',
          description:
            '可选。已配置模型档案的 id，例如 economy、imported-codex；' +
            '必须使用运行时模型档案列表中的 id。' +
            '不填时继承当前模型。'
        }
      },
      required: ['title', 'goal'],
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
      const title = input.title.trim();
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
          goal: input.goal,
          mode,
          title,
          parentRunId: runId,
          parentDepth,
          signal,
          repoId,
          workspaceRoot,
          modelProfileId: input.modelProfileId?.trim()
        });

        const content = formatOutcome(outcome);
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
            modelProfileId: outcome.modelProfileId,
            modelProfileName: outcome.modelProfileName,
            model: outcome.model,
            status: outcome.result.status,
            evidence: outcome.result.evidence,
            artifacts: outcome.result.artifacts,
            incompleteItems: outcome.result.incompleteItems
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

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
