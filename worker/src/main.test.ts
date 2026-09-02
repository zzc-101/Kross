import { describe, expect, it } from 'vitest';
import { parseWorkerMainConfig } from './main';

const required = {
  APP_AGENT_ID: 'agent1',
  APP_AGENT_TOKEN: 'short-token',
  APP_CONTROL_PLANE_URL: 'https://control.example.test',
  APP_PHYSICAL_WORK_ROOT: '/work'
};

describe('Worker main config', () => {
  it('reads the persistent agent environment', () => {
    expect(parseWorkerMainConfig(required)).toEqual({
      agentId: 'agent1',
      agentToken: 'short-token',
      controlPlaneUrl: 'https://control.example.test',
      physicalWorkRoot: '/work'
    });
  });

  it('rejects a missing agent token', () => {
    expect(() => parseWorkerMainConfig({ ...required, APP_AGENT_TOKEN: '' })).toThrow('APP_AGENT_TOKEN is required');
  });
});
