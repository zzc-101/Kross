import { afterEach, describe, expect, it } from 'vitest';

import { catalogs } from './catalog';
import {
  getLocale,
  initI18n,
  isAppLocale,
  normalizeLocale,
  resolveLocale,
  setLocale
} from './locale';
import { t } from './t';

describe('i18n', () => {
  afterEach(() => {
    initI18n('zh');
  });

  it('defaults to zh and interpolates params', () => {
    initI18n('zh');
    expect(getLocale()).toBe('zh');
    expect(t('header.queue', { count: 3 })).toBe('队列：3');
    expect(t('welcome.headline')).toBe('随时可以开始');
  });

  it('switches to en', () => {
    setLocale('en');
    expect(t('welcome.headline')).toBe('Ready when you are');
    expect(t('header.queue', { count: 2 })).toBe('Queue: 2');
  });

  it('resolves locale from env and config priority', () => {
    expect(
      resolveLocale({
        env: { AGENT_LANG: 'en', KROSS_LANG: 'zh', LANG: 'zh_CN.UTF-8' }
      })
    ).toBe('en');
    expect(
      resolveLocale({
        env: { KROSS_LANG: 'en-US' },
        configLocale: 'zh'
      })
    ).toBe('en');
    expect(
      resolveLocale({
        env: {},
        configLocale: 'en'
      })
    ).toBe('en');
    expect(resolveLocale({ env: { LANG: 'zh_CN.UTF-8' } })).toBe('zh');
    expect(resolveLocale({ env: {} })).toBe('zh');
  });

  it('normalizes OS language tags', () => {
    expect(normalizeLocale('en_US.UTF-8')).toBe('en');
    expect(normalizeLocale('zh-Hans')).toBe('zh');
    expect(normalizeLocale('C')).toBeUndefined();
    expect(isAppLocale('zh')).toBe(true);
    expect(isAppLocale('fr')).toBe(false);
  });

  it('keeps zh and en catalogs key-aligned', () => {
    const zhKeys = Object.keys(catalogs.zh).sort();
    const enKeys = Object.keys(catalogs.en).sort();
    expect(enKeys).toEqual(zhKeys);
  });
});
