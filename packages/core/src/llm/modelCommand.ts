import {
  createLlmClientForProvider,
  formatProvidersStatus
} from './createLlmClient';
import {
  formatProviderModelLabel,
  getLlmProviderDefinition,
  isLlmProvider,
  type LlmProvider
} from './llmProviders';
import type { LlmClient } from './types';

export type ModelCommandResult =
  | { kind: 'message'; text: string }
  | {
      kind: 'set-model';
      model: string;
      text: string;
      provider: LlmProvider;
    }
  | {
      kind: 'replace-client';
      client: LlmClient;
      text: string;
      provider: LlmProvider;
      model: string;
    };

/**
 * Parse `/model` arguments.
 * - (empty) current status
 * - list | providers
 * - <modelId>
 * - <provider> <modelId>
 */
export function handleModelCommand(
  argument: string | undefined,
  current: LlmClient | undefined,
  env: Record<string, string | undefined> = process.env
): ModelCommandResult {
  const trimmed = argument?.trim() ?? '';

  if (!trimmed || trimmed === 'status') {
    return {
      kind: 'message',
      text: formatCurrentModel(current)
    };
  }

  if (trimmed === 'list' || trimmed === 'providers') {
    return {
      kind: 'message',
      text: formatProvidersStatus(
        env,
        current
          ? { provider: current.provider, model: current.model }
          : undefined
      )
    };
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && parts[0] && isLlmProvider(parts[0])) {
    const provider = parts[0];
    const model = parts.slice(1).join(' ');
    try {
      const client = createLlmClientForProvider(provider, model, env);
      return {
        kind: 'replace-client',
        client,
        provider,
        model: client.model ?? model,
        text: [
          `已切换到 ${formatProviderModelLabel(provider, client.model ?? model)}`,
          `backend: pi（默认）或 AGENT_LLM_BACKEND`,
          `密钥来源: env ${getLlmProviderDefinition(provider).apiKeyEnv.join('/')}`
        ].join('\n')
      };
    } catch (error) {
      return {
        kind: 'message',
        text: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (parts.length === 1 && parts[0] && isLlmProvider(parts[0])) {
    return {
      kind: 'message',
      text: [
        `用法：/model ${parts[0]} <modelId>`,
        `示例：/model ${parts[0]} ${getLlmProviderDefinition(parts[0]).exampleModel}`
      ].join('\n')
    };
  }

  const modelId = trimmed;
  if (!current) {
    return {
      kind: 'message',
      text: [
        '当前未配置 LLM。',
        '请先设置 AGENT_LLM_PROVIDER 与对应密钥/模型，或 /import 导入配置。',
        '也可用 /model <provider> <model> 在 env 已有密钥时切换。'
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
      text: `已切换模型为 ${formatProviderModelLabel(current.provider, modelId)}`
    };
  } catch (error) {
    return {
      kind: 'message',
      text: error instanceof Error ? error.message : String(error)
    };
  }
}

function formatCurrentModel(current: LlmClient | undefined): string {
  if (!current?.model) {
    return [
      '当前: no model',
      '用法：/model list | /model <modelId> | /model <provider> <modelId>'
    ].join('\n');
  }

  return [
    `当前: ${formatProviderModelLabel(current.provider, current.model)}`,
    `provider: ${current.provider}`,
    `model: ${current.model}`,
    '',
    '用法：/model list | /model <modelId> | /model <provider> <modelId>'
  ].join('\n');
}
