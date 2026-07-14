import type { AppLocale } from './types';
import { APP_LOCALES } from './types';

let currentLocale: AppLocale = 'zh';
const listeners = new Set<(locale: AppLocale) => void>();

export function isAppLocale(value: string | undefined | null): value is AppLocale {
  return value === 'zh' || value === 'en';
}

/**
 * Normalize free-form language tags to a supported AppLocale.
 * Accepts: zh, en, zh-CN, en_US, zh_CN.UTF-8, etc.
 */
export function normalizeLocale(value: string | undefined | null): AppLocale | undefined {
  if (!value) {
    return undefined;
  }
  const raw = value.trim().toLowerCase().replace(/_/g, '-');
  if (!raw) {
    return undefined;
  }
  if (raw === 'zh' || raw.startsWith('zh-') || raw.startsWith('zh.')) {
    return 'zh';
  }
  if (raw === 'en' || raw.startsWith('en-') || raw.startsWith('en.')) {
    return 'en';
  }
  // LANG=C / POSIX → leave unset so caller falls back
  return undefined;
}

/**
 * Resolve UI locale.
 * Priority: explicit → AGENT_LANG → KROSS_LANG → config.locale → LANG → zh
 */
export function resolveLocale(input: {
  explicit?: string;
  env?: Record<string, string | undefined>;
  configLocale?: string;
} = {}): AppLocale {
  const env = input.env ?? {};
  const candidates = [
    input.explicit,
    env.AGENT_LANG,
    env.KROSS_LANG,
    input.configLocale,
    env.LANG
  ];
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) {
      return locale;
    }
  }
  return 'zh';
}

export function getLocale(): AppLocale {
  return currentLocale;
}

export function setLocale(locale: AppLocale): void {
  if (!APP_LOCALES.includes(locale) || locale === currentLocale) {
    return;
  }
  currentLocale = locale;
  for (const listener of listeners) {
    listener(locale);
  }
}

/** Initialize locale once at process start. Prefer over setLocale when bootstrapping. */
export function initI18n(locale: AppLocale): void {
  currentLocale = locale;
}

export function onLocaleChange(listener: (locale: AppLocale) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function listLocales(): readonly AppLocale[] {
  return APP_LOCALES;
}
