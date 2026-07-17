import { z } from 'zod';

export const promptTemplateSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1)
]);

export const promptCatalogSchema = z.record(promptTemplateSchema);

export type PromptTemplate = z.infer<typeof promptTemplateSchema>;
