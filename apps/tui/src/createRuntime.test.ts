import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bootstrapRuntimeTooling,
  createRuntimeOptionsFromEnv,
  type CreateRuntimeConfigOptions,
  type RuntimeTooling
} from './createRuntime';

describe('createRuntime re-export', () => {
  it('exposes createRuntimeOptionsFromEnv and returns a traceStore', () => {
    expect(typeof createRuntimeOptionsFromEnv).toBe('function');
    expect(typeof bootstrapRuntimeTooling).toBe('function');

    const homeDir = mkdtempSync(join(tmpdir(), 'kross-tui-runtime-'));
    try {
      const options = createRuntimeOptionsFromEnv(
        '/tmp/local-agent',
        {},
        undefined,
        { homeDir }
      );
      expect(options.traceStore).toBeDefined();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }

    // type-only smoke: aliases remain importable
    const _opts: CreateRuntimeConfigOptions = {};
    void _opts;
    type _Tooling = RuntimeTooling;
  });
});
