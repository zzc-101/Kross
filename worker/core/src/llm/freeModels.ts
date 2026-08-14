import { z } from 'zod';

import rawFreeModels from './freeModels.json';
import { t } from '../i18n';
import { formatCompactCount } from './modelContextWindows';
import { llmProviderSchema } from './llmProviders';

export const unavailableFreeModelSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  provider: llmProviderSchema,
  models: z.array(z.string().trim().min(1)).min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().trim().min(1),
  wireApi: z.enum(['responses', 'completions']),
  contextWindow: z.number().int().positive(),
  limitation: z.literal('codex-cli-only')
});

export type UnavailableFreeModel = z.infer<
  typeof unavailableFreeModelSchema
>;

export const UNAVAILABLE_FREE_MODELS: readonly UnavailableFreeModel[] =
  parseUnavailableFreeModels(rawFreeModels);

export function listUnavailableFreeModels(): readonly UnavailableFreeModel[] {
  return UNAVAILABLE_FREE_MODELS;
}

export function formatUnavailableFreeModels(): string {
  const models = listUnavailableFreeModels();
  if (models.length === 0) {
    return t('cmd.free.empty');
  }

  const details = models
    .map((model) =>
      [
        `**${model.name}**`,
        ...model.models.map(
          (modelId) => `- ${t('cmd.free.model')}: \`${modelId}\``
        ),
        `- ${t('cmd.free.protocol')}: \`${model.provider}/${model.wireApi}\``,
        `- ${t('cmd.free.context')}: \`${formatCompactCount(model.contextWindow)}\``,
        `- ${t('cmd.free.endpoint')}: \`${model.baseUrl}\``,
        `- ${t('cmd.free.apiKey')}: \`${model.apiKey}\``,
        `- ${t('cmd.free.limit')}: ${t('cmd.free.codexOnly')}`
      ].join('\n')
    )
    .join('\n\n');

  return [
    t('cmd.free.title'),
    t('cmd.free.intro'),
    '',
    details,
    '',
    `**${t('cmd.free.disclaimerLabel')}** ${t('cmd.free.disclaimer')}`,
    `**${t('cmd.free.thanksLabel')}** ${t('cmd.free.thanks')}`
  ].join('\n');
}

function parseUnavailableFreeModels(
  value: unknown
): readonly UnavailableFreeModel[] {
  const models = z.array(unavailableFreeModelSchema).parse(value);
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) {
      throw new Error(`duplicate unavailable free model id: ${model.id}`);
    }
    ids.add(model.id);
  }
  return models;
}
