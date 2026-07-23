import { describe, expect, it } from 'vitest';

import { resolveLanguage } from './language';

describe('resolveLanguage', () => {
  it('prefers a supported saved language', () => {
    expect(resolveLanguage('en-US', 'zh-CN')).toBe('en-US');
    expect(resolveLanguage('zh-CN', 'en-US')).toBe('zh-CN');
  });

  it('falls back to the browser language', () => {
    expect(resolveLanguage(null, 'zh-TW')).toBe('zh-CN');
    expect(resolveLanguage(null, 'fr-FR')).toBe('en-US');
    expect(resolveLanguage('unsupported', 'en-GB')).toBe('en-US');
  });
});
