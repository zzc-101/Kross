import {
  createLlmClientForProvider,
  formatProvidersStatus
} from './createLlmClient';
import {
  getLlmProviderDefinition,
  isLlmProvider,
  type LlmProvider
} from './llmProviders';
import {
  cycleThinkingEffort,
  formatModelEffortLabel,
  formatThinkingEffortHelp,
  parseThinkingEffort,
  type ThinkingEffort
} from './thinkingEffort';
import type { LlmClient } from './types';
import type { ImportedLlmConfig } from '../config/configImport';

export type ModelCommandResult =
  | { kind: 'message'; text: string }
  | {
      kind: 'set-model';
      model: string;
      text: string;
      provider: LlmProvider;
    }
  | {
      kind: 'set-effort';
      effort: ThinkingEffort;
      text: string;
      provider: LlmProvider;
      model: string;
    }
  | {
      kind: 'replace-client';
      client: LlmClient;
      text: string;
      provider: LlmProvider;
      model: string;
    };

/**
 * Unified `/model` command:
 * - (empty|status) current status
 * - list|providers
 * - off|minimal|low|medium|high|xhigh|cycle  thinking effort
 * - <provider> <modelId>
 * - <modelId>
 */
export function handleModelCommand(
  argument: string | undefined,
  current: LlmClient | undefined,
  env: Record<string, string | undefined> = process.env,
  saved?: ImportedLlmConfig
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
          : undefined,
        saved
      )
    };
  }

  if (trimmed === 'think' || trimmed === 'effort') {
    return {
      kind: 'message',
      text: formatThinkingEffortHelp(current?.thinkingEffort)
    };
  }

  // /model cycle | next — cycle thinking effort
  if (trimmed === 'cycle' || trimmed === 'next') {
    return applyEffort(current, (effort) => cycleThinkingEffort(effort));
  }

  // /model off|minimal|low|medium|high|xhigh
  const effort = parseThinkingEffort(trimmed);
  if (effort) {
    return applyEffort(current, () => effort);
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && parts[0] && isLlmProvider(parts[0])) {
    const provider = parts[0];
    const model = parts.slice(1).join(' ');
    try {
      const client = createLlmClientForProvider(
        provider,
        model,
        env,
        undefined,
        saved
      );
      return {
        kind: 'replace-client',
        client,
        provider,
        model: client.model ?? model,
        text: [
          `已切换到 ${formatModelEffortLabel(client.model ?? model, client.thinkingEffort)}`,
          `provider: ${provider}`
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

function applyEffort(
  current: LlmClient | undefined,
  next: (current: ThinkingEffort) => ThinkingEffort
): ModelCommandResult {
  if (!current?.model) {
    return {
      kind: 'message',
      text: '当前未配置模型，无法切换思考强度。'
    };
  }
  if (!current.setThinkingEffort) {
    return {
      kind: 'message',
      text: '当前 LLM 客户端不支持切换思考强度。'
    };
  }

  const effort = next(current.thinkingEffort ?? 'medium');
  try {
    current.setThinkingEffort(effort);
    return {
      kind: 'set-effort',
      effort,
      provider: current.provider,
      model: current.model,
      text: `思考强度 → ${effort} · ${formatModelEffortLabel(current.model, effort)}`
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
      '用法：ctrl+p 打开面板 · /model list · /model <id> · /model <effort>'
    ].join('\n');
  }

  return [
    `当前: ${formatModelEffortLabel(current.model, current.thinkingEffort)}`,
    `provider: ${current.provider}`,
    `model: ${current.model}`,
    `thinking: ${current.thinkingEffort ?? 'medium'}`,
    '',
    '用法：ctrl+p · /model list · /model <modelId> · /model <provider> <model> · /model <effort>|cycle'
  ].join('\n');
}
