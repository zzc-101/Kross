import { describe, expect, it } from 'vitest';
import { parseWorkerMainConfig } from './main';

const required = {
  KROSS_RUN_ID: 'run1',
  KROSS_GENERATION: '2',
  KROSS_LEASE_ID: 'lease2',
  KROSS_RUN_TOKEN: 'short-token',
  KROSS_RUN_SPEC_URL: 'https://control.example.test/internal/v2/run-spec',
  KROSS_PHYSICAL_WORK_ROOT: '/work'
};

describe('Worker main config', () => {
  it('derives the control-plane origin from the RunSpec URL', () => {
    expect(parseWorkerMainConfig(required)).toEqual({
      workerId: 'worker_run1_2',
      runId: 'run1',
      generation: 2,
      leaseId: 'lease2',
      runToken: 'short-token',
      runSpecUrl: required.KROSS_RUN_SPEC_URL,
      controlPlaneUrl: 'https://control.example.test',
      physicalWorkRoot: '/work'
    });
  });

  it('accepts an explicit control-plane URL without any durable credential', () => {
    const config = parseWorkerMainConfig({ ...required, KROSS_CONTROL_PLANE_URL: 'http://server:8787' });
    expect(config.controlPlaneUrl).toBe('http://server:8787');
    expect(Object.keys(config)).not.toContain('refreshToken');
  });

  it('rejects missing Run Token and invalid generation', () => {
    expect(() => parseWorkerMainConfig({ ...required, KROSS_RUN_TOKEN: '' })).toThrow('KROSS_RUN_TOKEN is required');
    expect(() => parseWorkerMainConfig({ ...required, KROSS_GENERATION: '0' })).toThrow('positive integer');
  });
});
