import { z } from 'zod';

import rawPublicModels from './publicModels.json';
import { llmProviderSchema } from './llmProviders';

export const publicModelDefinitionSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    provider: llmProviderSchema,
    model: z.string().trim().min(1),
    baseUrl: z.string().url(),
    apiKey: z.string().trim().min(1).optional(),
    authToken: z.string().trim().min(1).optional(),
    wireApi: z.enum(['responses', 'completions']).optional(),
    contextWindow: z.number().int().positive().optional(),
    reasoning: z.boolean().default(false),
    free: z.boolean().default(true),
    notice: z.string().trim().min(1)
  })
  .refine((model) => Boolean(model.apiKey || model.authToken), {
    message: 'public model requires apiKey or authToken'
  })
  .refine((model) => !model.wireApi || model.provider === 'openai', {
    message: 'wireApi is only supported for openai public models'
  });

export type PublicModelDefinition = z.infer<typeof publicModelDefinitionSchema>;

export const PUBLIC_MODELS: readonly PublicModelDefinition[] = parsePublicModels(
  rawPublicModels
);

export function listPublicModels(): readonly PublicModelDefinition[] {
  return PUBLIC_MODELS;
}

export function getPublicModel(
  id: string | undefined
): PublicModelDefinition | undefined {
  const normalized = id?.trim();
  if (!normalized) {
    return undefined;
  }
  return PUBLIC_MODELS.find((model) => model.id === normalized);
}

function parsePublicModels(value: unknown): readonly PublicModelDefinition[] {
  const models = z.array(publicModelDefinitionSchema).parse(value);
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) {
      throw new Error(`duplicate public model id: ${model.id}`);
    }
    ids.add(model.id);
  }
  return models;
}
