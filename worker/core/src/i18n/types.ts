/** Supported UI locales for Kross. Default is `zh`. */
export type AppLocale = 'zh' | 'en';

export const APP_LOCALES = ['zh', 'en'] as const satisfies readonly AppLocale[];

export type MessageParams = Record<string, string | number | boolean | undefined | null>;

export type MessageCatalog = Record<string, string>;
