import type { AppLocale } from '../i18n/types';
import enRaw from './catalog/en-US.json';
import zhRaw from './catalog/zh-CN.json';
import {
  promptCatalogSchema,
  type PromptTemplate
} from './promptSchema';

export type PromptKey = keyof typeof zhRaw;
export type PromptCatalog = Record<PromptKey, PromptTemplate>;

const zhCatalog = promptCatalogSchema.parse(zhRaw) as PromptCatalog;
const enCatalog = promptCatalogSchema.parse(enRaw) as PromptCatalog;

assertCatalogKeysAligned(zhCatalog, enCatalog);

export const promptCatalogs: Readonly<Record<AppLocale, PromptCatalog>> = {
  zh: zhCatalog,
  en: enCatalog
};

export function getPromptTemplate(
  key: PromptKey,
  locale: AppLocale
): PromptTemplate {
  return promptCatalogs[locale][key] ?? promptCatalogs.zh[key];
}

function assertCatalogKeysAligned(
  primary: PromptCatalog,
  secondary: PromptCatalog
): void {
  const primaryKeys = Object.keys(primary).sort();
  const secondaryKeys = Object.keys(secondary).sort();
  if (
    primaryKeys.length !== secondaryKeys.length ||
    primaryKeys.some((key, index) => key !== secondaryKeys[index])
  ) {
    throw new Error('Prompt catalogs must contain identical keys');
  }
}
