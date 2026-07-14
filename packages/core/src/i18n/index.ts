export type { AppLocale, MessageCatalog, MessageParams } from './types';
export { APP_LOCALES } from './types';
export {
  getLocale,
  initI18n,
  isAppLocale,
  listLocales,
  normalizeLocale,
  onLocaleChange,
  resolveLocale,
  setLocale
} from './locale';
export { catalogs, enCatalog, zhCatalog, type MessageKey } from './catalog';
export { interpolate, t } from './t';
