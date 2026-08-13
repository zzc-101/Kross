import { describe, expect, it } from 'vitest';

import { formatSessionStoreInitializationError } from './sessionStartup';

describe('formatSessionStoreInitializationError', () => {
  it('turns native ABI mismatches into an actionable Node version message', () => {
    const message = formatSessionStoreInitializationError(
      new Error(
        'The module was compiled using NODE_MODULE_VERSION 127. This version requires NODE_MODULE_VERSION 115.'
      ),
      { version: 'v20.19.0', modules: '115' }
    );

    expect(message).toContain('Node.js v20.19.0（ABI 115）');
    expect(message).toContain('Node.js >=22.19');
    expect(message).toContain('nvm use');
    expect(message).toContain('npm rebuild better-sqlite3');
    expect(message).toContain('当前内容不会保存');
  });

  it('keeps unexpected initialization errors visible', () => {
    expect(
      formatSessionStoreInitializationError(new Error('disk is read-only'))
    ).toContain('disk is read-only');
  });
});
