import enRaw from './catalog/en-US.json';
import {
  promptCatalogSchema,
  type PromptTemplate
} from './promptSchema';

export type PromptKey = keyof typeof enRaw;
export type PromptCatalog = Record<PromptKey, PromptTemplate>;

const catalog = promptCatalogSchema.parse(enRaw) as PromptCatalog;

export function getPromptTemplate(key: PromptKey): PromptTemplate {
  return catalog[key];
}
