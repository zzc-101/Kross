import { describe, expect, it } from 'vitest';
import { parseWorkerMainConfig } from './main';

const required = {
  KROSS_AGENT_ID: 'agent1',
  KROSS_AGENT_TOKEN: 'short-token',
  KROSS_CONTROL_PLANE_URL: 'https://control.example.test',
  KROSS_PHYSICAL_WORK_ROOT: '/work'
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
    expect(() => parseWorkerMainConfig({ ...required, KROSS_AGENT_TOKEN: '' })).toThrow('KROSS_AGENT_TOKEN is required');
  });
});
