import { z } from 'zod';

import type { AgentMode } from '../../domain';
import { agentModeSchema } from '../../domain';
import { normalizeAgentMode } from '../../modes/modeDetector';
import type { ToolDefinition } from '../toolGateway';

export interface CreateSetModeToolOptions {
  getMode: () => AgentMode;
  setMode: (mode: AgentMode) => void;
}

const inputSchema = z.object({
  mode: z.string().min(1),
  reason: z.string().optional()
});

type SetModeInput = z.infer<typeof inputSchema>;

/**
 * 让主 agent 在对话中切换会话 Mode（策略）。
 * 生效于**下一轮**用户消息；当前轮仍按进入时的 mode 跑完。
 */
export function createSetModeTool(
  options: CreateSetModeToolOptions
): ToolDefinition<SetModeInput> {
  return {
    name: 'SetMode',
    description:
      '切换当前会话的 Agent Mode（策略）。' +
      '当用户要求切换模式（如「切到指挥家」「用 plan 模式」）时必须调用本工具，不要声称无法切换。' +
      '可选值：auto（默认 agent）、plan（先计划后开发）、conductor（指挥家：高级模型拆任务+worker 执行+验收）。' +
      '多目录用 /add-dir，不要用本工具。切换后从下一轮用户消息生效。',
    risk: 'read',
    category: 'session',
    inputSchema,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['auto', 'plan', 'conductor'],
          description: '目标模式：auto | plan | conductor'
        },
        reason: {
          type: 'string',
          description: '简短说明为何切换（可选，便于日志）'
        }
      },
      required: ['mode'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const next = normalizeAgentMode(input.mode);
      if (!next || !agentModeSchema.safeParse(next).success) {
        return {
          content: `无效 mode「${input.mode}」。可选：auto、plan、conductor。`,
          summary: `SetMode failed: invalid ${input.mode}`
        };
      }
      const prev = options.getMode();
      if (prev === next) {
        return {
          content: `会话 Mode 已是 ${next}，无需切换。`,
          summary: `SetMode noop: ${next}`,
          data: { mode: next, previous: prev, changed: false }
        };
      }
      options.setMode(next);
      const reason = input.reason?.trim();
      return {
        content:
          `已切换会话 Mode：${prev} → ${next}` +
          (reason ? `（${reason}）` : '') +
          '。将从下一轮用户消息起按新策略运行；请用一句话告知用户已切换。',
        summary: `SetMode ${prev}→${next}`,
        data: { mode: next, previous: prev, changed: true, reason }
      };
    }
  };
}
