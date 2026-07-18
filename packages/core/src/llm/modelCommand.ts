import type { LlmProvider } from './llmProviders';
import { formatModelEffortLabel } from './thinkingEffort';
import type { LlmClient } from './types';

const REMOVED_MODEL_SUBCOMMANDS = new Set([
  'status',
  'think',
  'effort',
  'cycle',
  'next',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'list',
  'providers'
]);

export type ModelCommandResult =
  | { kind: 'message'; text: string }
  | {
      kind: 'set-model';
      model: string;
      text: string;
      provider: LlmProvider;
    };

/**
 * Direct model switch for `/model <modelId>`.
 * Bare `/model` is handled by the TUI and opens the settings panel.
 */
export function handleModelCommand(
  argument: string | undefined,
  current: LlmClient | undefined
): ModelCommandResult {
  const trimmed = argument?.trim() ?? '';

  if (!trimmed || /\s/.test(trimmed)) {
    return {
      kind: 'message',
      text: '用法：/model <modelId>（或输入 /model 打开模型面板）'
    };
  }

  if (REMOVED_MODEL_SUBCOMMANDS.has(trimmed.toLowerCase())) {
    return {
      kind: 'message',
      text: '该 /model 子命令已移除，请输入 /model 打开模型面板。'
    };
  }

  const modelId = trimmed;
  if (!current) {
    return {
      kind: 'message',
      text: [
        '当前未配置 LLM。',
        '请先 /import 导入配置，或设置 AGENT_LLM_PROVIDER 与密钥/模型。',
        '也可用 ctrl+p 打开设置面板。'
      ].join('\n')
    };
  }

  if (!current.setModel) {
    return {
      kind: 'message',
      text: '当前 LLM 客户端不支持会话内切换模型。'
    };
  }

  try {
    current.setModel(modelId);
    return {
      kind: 'set-model',
      model: modelId,
      provider: current.provider,
      text: `已切换模型为 ${formatModelEffortLabel(modelId, current.thinkingEffort)}`
    };
  } catch (error) {
    return {
      kind: 'message',
      text: error instanceof Error ? error.message : String(error)
    };
  }
}
