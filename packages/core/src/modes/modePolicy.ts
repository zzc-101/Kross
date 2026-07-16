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

/** Plan 分类 system prompt（仅内部 complete，输出不可直接展示） */
export const PLAN_INTENT_SYSTEM_PROMPT = [
  'Plan 模式路由。只判断用户是否需要「可执行开发计划」。',
  '- 问候/闲聊/感谢/不改代码的问答 → {"kind":"chat","reason":"..."}',
  '- 写代码/改代码/修 bug/加功能/重构/改仓库 → {"kind":"plan","reason":"..."}',
  '只输出上述 JSON，不要其它文字。'
].join('\n');

/** Plan 正文生成（流式展示给用户） */
export const PLAN_BODY_SYSTEM_PROMPT =
  '你是资深工程师。用户已确定需要开发计划。只输出可执行的开发计划（中文），' +
  '包含：目标、步骤、涉及文件/模块、风险与验证方式。不要调用工具，不要改代码，不要输出 JSON 外壳。';

/** Conductor 任务拆分（可先 complete 拿 JSON，再流式展示格式化计划） */
export const CONDUCTOR_PLAN_SYSTEM_PROMPT = [
  '你是指挥家（高级编排模型）。把用户目标拆成可由「经济/快速 worker 子代理」执行的任务。',
  '只输出 JSON（可包在 ```json 代码块中），schema:',
  '{"goal":string,"notes"?:string,"tasks":[{"id":string,"title":string,"prompt":string,"repoId"?:string}]}',
  '要求：tasks 至少 1 个；prompt 必须完整可独立执行；repoId 仅当需要绑定 /add-dir 的 root id 时填写。',
  '不要写代码实现，不要调用工具。'
].join('\n');

export const CONDUCTOR_REVIEW_SYSTEM_PROMPT =
  '你是指挥家高级模型，负责验收 worker 子代理的结果。' +
  '用中文给出：是否达标、遗漏、风险、建议的后续动作。简洁有条理。';
