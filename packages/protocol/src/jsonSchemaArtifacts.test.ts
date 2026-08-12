import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemas = {
  task: loadJson('schemas/kross-task-snapshot-v2.schema.json'),
  run: loadJson('schemas/kross-run-snapshot-v2.schema.json'),
  source: loadJson('schemas/kross-source-snapshot-v2.schema.json'),
  artifact: loadJson('schemas/kross-artifact-snapshot-v2.schema.json'),
  approval: loadJson('schemas/kross-approval-snapshot-v2.schema.json'),
  publicEvent: loadJson('schemas/kross-public-event-envelope-v2.schema.json'),
  runSpec: loadJson('schemas/kross-run-spec-v2.schema.json'),
  workerEvent: loadJson('schemas/kross-worker-run-event-envelope-v2.schema.json'),
  workerMessage: loadJson('schemas/kross-internal-worker-message-v2.schema.json')
};
const now = '2026-08-12T08:00:00.000Z';

describe('language-neutral Protocol v2 schemas', () => {
  it('compiles every checked-in v2 artifact', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (const schema of Object.values(schemas)) {
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });

  it('compile and accept representative public and worker messages', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validatePublicEvent = ajv.compile(schemas.publicEvent);
    const validateWorkerEvent = ajv.compile(schemas.workerEvent);
    const validateWorkerMessage = ajv.compile(schemas.workerMessage);

    expect(validatePublicEvent(publicProgressEvent())).toBe(true);
    expect(validateWorkerEvent(workerProgressEvent())).toBe(true);
    expect(
      validateWorkerMessage({
        protocolVersion: 2,
        messageId: 'message_1',
        sentAt: now,
        type: 'worker.event',
        envelope: workerProgressEvent()
      })
    ).toBe(true);
  });

  it('rejects unsupported protocol versions and unknown event variants', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validate = ajv.compile(schemas.publicEvent);
    expect(validate({ ...publicProgressEvent(), protocolVersion: 1 })).toBe(false);
    expect(
      validate({
        ...publicProgressEvent(),
        event: { type: 'workspace.updated', data: {} }
      })
    ).toBe(false);
  });

  it('keeps RunSpec JSON schema browser/runtime neutral', () => {
    const serialized = JSON.stringify(schemas.runSpec);
    expect(serialized).not.toContain('node:');
    expect(serialized).not.toContain('Buffer');
    expect(serialized).toContain('resourceLimits');
  });
});

function publicProgressEvent() {
  return {
    protocolVersion: 2,
    eventId: 'cursor_1',
    timestamp: now,
    event: {
      type: 'run.progress',
      data: {
        organizationId: 'org_1',
        projectId: 'project_1',
        taskId: 'task_1',
        runId: 'run_1',
        phase: 'executing',
        message: 'Working'
      }
    }
  };
}

function workerProgressEvent() {
  return {
    protocolVersion: 2,
    runId: 'run_1',
    generation: 1,
    seq: 1,
    timestamp: now,
    event: { type: 'run.progress', phase: 'executing', message: 'Working' }
  };
}

function loadJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(packageRoot, path), 'utf8')) as Record<
    string,
    unknown
  >;
}
