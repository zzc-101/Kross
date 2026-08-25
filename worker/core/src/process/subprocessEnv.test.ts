import { describe, expect, it } from 'vitest';

import { buildSubprocessEnv } from './subprocessEnv';

describe('buildSubprocessEnv', () => {
  it('inherits runtime basics without leaking credentials', () => {
    const env = buildSubprocessEnv({
      HOME: '/home/node',
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'secret',
      KROSS_AGENT_TOKEN: 'agent-secret'
    });

    expect(env).toEqual({ HOME: '/home/node', PATH: '/usr/bin' });
  });

  it('allows explicit validated command overrides', () => {
    expect(buildSubprocessEnv({ PATH: '/usr/bin' }, { NODE_ENV: 'test' })).toEqual({
      PATH: '/usr/bin',
      NODE_ENV: 'test'
    });
    expect(() => buildSubprocessEnv({}, { 'BAD=KEY': 'x' })).toThrow(
      'Invalid environment override key'
    );
  });
});
