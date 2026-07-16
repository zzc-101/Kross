import { describe, expect, it } from 'vitest';

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

    const options = createRuntimeOptionsFromEnv('/tmp/local-agent', {});
    expect(options.traceStore).toBeDefined();

    // type-only smoke: aliases remain importable
    const _opts: CreateRuntimeConfigOptions = {};
    void _opts;
    type _Tooling = RuntimeTooling;
  });
});
