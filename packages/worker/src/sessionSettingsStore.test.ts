import {
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
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
      thinkingEffort: 'medium',
      permissionMode: 'classifier'
    });

    expect(new SessionSettingsStore(root).load('session-a')).toEqual({
      model: 'gpt-test',
      thinkingEffort: 'medium',
      permissionMode: 'classifier'
    });
    expect(store.load('session-b')).toEqual({});
    expect(
      JSON.parse(readFileSync(join(root, 'session-a.json'), 'utf8'))
    ).toMatchObject({ version: 1 });
  });

  it('reads legacy settings and rejects future versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-settings-version-'));
    const path = join(root, 'session-a.json');
    writeFileSync(path, JSON.stringify({ model: 'legacy-model' }));
    expect(new SessionSettingsStore(root).load('session-a')).toEqual({
      model: 'legacy-model'
    });

    writeFileSync(path, JSON.stringify({ version: 2, settings: {} }));
    expect(() => new SessionSettingsStore(root).load('session-a')).toThrow(
      'Worker session settings 使用不受支持的数据版本 2'
    );
  });
});
