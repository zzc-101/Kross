import { afterEach, describe, expect, it } from 'vitest';
import { initI18n, setLocale } from '@kross/core';

import { formatVerificationPresentation } from './verificationPresentation';

describe('verificationPresentation', () => {
  afterEach(() => initI18n('zh'));

  it('formats a concise Chinese success summary with command count', () => {
    const result = formatVerificationPresentation({
      status: 'passed',
      commands: ['npm test', 'npm run typecheck'],
      evidence: []
    });

    expect(result.tone).toBe('success');
    expect(result.text).toContain('验证通过 · 2 项检查');
    expect(result.text).toContain('npm test');
  });

  it('keeps failed and not-run conclusions explicit in English', () => {
    setLocale('en');
    const failed = formatVerificationPresentation({
      status: 'failed',
      commands: ['npm test'],
      evidence: [],
      reason: 'exit 1'
    });
    const notRun = formatVerificationPresentation({
      status: 'not-run',
      commands: [],
      evidence: [],
      reason: 'missing evidence'
    });

    expect(failed).toMatchObject({ tone: 'error' });
    expect(failed.text).toContain('Verification failed');
    expect(notRun).toMatchObject({ tone: 'warning' });
    expect(notRun.text).toContain('Verification not run');
  });
});
