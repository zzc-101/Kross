import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SessionSettingsStore } from './sessionSettingsStore';

describe('SessionSettingsStore', () => {
  it('persists model settings independently for each session', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-settings-'));
    const store = new SessionSettingsStore(root);
    store.update('session-a', {
      model: 'gpt-test',
      thinkingEffort: 'medium'
    });

    expect(new SessionSettingsStore(root).load('session-a')).toEqual({
      model: 'gpt-test',
      thinkingEffort: 'medium'
    });
    expect(store.load('session-b')).toEqual({});
  });
});
