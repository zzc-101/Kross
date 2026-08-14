import { catalogs, type MessageKey } from './catalog';
import { getLocale } from './locale';
import type { MessageParams } from './types';

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Translate a UI message key for the current locale.
 * Missing keys fall back to zh, then to the key string itself.
 * Placeholders use `{name}` syntax.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const locale = getLocale();
  const template =
    catalogs[locale][key] ?? catalogs.zh[key] ?? (key as string);
  return interpolate(template, params);
}

export function interpolate(
  template: string,
  params?: MessageParams
): string {
  if (!params) {
    return template;
  }
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      return match;
    }
    return String(value);
  });
}

export type { MessageKey };
