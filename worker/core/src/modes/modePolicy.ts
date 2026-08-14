/**
 * Mode = 策略，不是运行时/输出管线。
 *
 * 不变量（由 AgentRuntime 执行）：
 * - 用户可见文本只能通过 stream text-delta / thinking-delta 出去
 * - client.complete() 仅用于内部短调用（分类 JSON、验收摘要等），不得直接当 chat 展示
 * - 所有 mode 共享同一套 agent tool loop / stream 原语
 */

import type { AgentMode } from '../domain';
import type { ModeDetectionResult } from './modeDetector';
import { detectMode } from './modeDetector';
import type { PendingModeExecution } from './pendingExecution';

/** Runner 入口动作：策略只决定「做什么」，不负责怎么输出。 */
export type ModeTurnAction =
  | {
      type: 'agent-loop';
      mode: AgentMode;
      /** 已批准的 plan 正文，注入 context */
      planText?: string;
    }
  | {
      type: 'plan-gate-flow';
      mode: 'plan';
    }
  | {
      type: 'conductor-gate-flow';
      mode: 'conductor';
    }
  | {
      type: 'conductor-execute';
      mode: 'conductor';
      pending: Extract<PendingModeExecution, { kind: 'conductor' }>;
    }
  | {
      type: 'no-llm';
      mode: AgentMode;
    };

export function resolveModeTurn(input: {
  requestedMode: AgentMode | string;
  userInput: string;
  planApproved: boolean;
  pending?: PendingModeExecution;
  hasLlm: boolean;
}): { detection: ModeDetectionResult; action: ModeTurnAction } {
  const detection = detectMode({
    requestedMode: input.requestedMode,
    input: input.userInput
  });

  // 恢复：用户 /approve 后按 pending 策略执行（仍走统一 runner）
  if (input.planApproved && input.pending) {
    if (input.pending.kind === 'plan') {
      return {
        detection: {
          mode: 'plan',
          reason: 'approved plan resume',
          requiresApproval: false,
          signals: []
        },
        action: input.hasLlm
          ? {
              type: 'agent-loop',
              mode: 'plan',
              planText: input.pending.planText
            }
          : { type: 'no-llm', mode: 'plan' }
      };
    }
    if (input.pending.kind === 'conductor') {
      return {
        detection: {
          mode: 'conductor',
          reason: 'approved conductor resume',
          requiresApproval: false,
          signals: []
        },
        action: {
          type: 'conductor-execute',
          mode: 'conductor',
          pending: input.pending
        }
      };
    }
  }

  // plan / conductor 的门控阶段即使无 LLM 也能用模板；auto 无 LLM 才走 no-llm
  switch (detection.mode) {
    case 'auto':
      return {
        detection,
        action: input.hasLlm
          ? { type: 'agent-loop', mode: 'auto' }
          : { type: 'no-llm', mode: 'auto' }
      };
    case 'plan':
      return {
        detection,
        action: { type: 'plan-gate-flow', mode: 'plan' }
      };
    case 'conductor':
      return {
        detection,
        action: { type: 'conductor-gate-flow', mode: 'conductor' }
      };
    default:
      return {
        detection,
        action: input.hasLlm
          ? { type: 'agent-loop', mode: 'auto' }
          : { type: 'no-llm', mode: 'auto' }
      };
  }
}
