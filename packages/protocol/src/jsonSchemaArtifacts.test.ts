import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

const schemas = {
  command: loadJson('docs/schemas/kross-client-command-v1.schema.json'),
  event: loadJson('docs/schemas/kross-server-event-v1.schema.json'),
  envelope: loadJson('docs/schemas/kross-event-envelope-v1.schema.json')
};

describe('language-neutral Protocol schemas', () => {
  it('compile and accept representative v1 messages', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validateCommand = ajv.compile(schemas.command);
    const validateEvent = ajv.compile(schemas.event);
    const validateEnvelope = ajv.compile(schemas.envelope);

    expect(
      validateCommand({
        protocolVersion: 1,
        requestId: 'request-1',
        type: 'workspace.list'
      })
    ).toBe(true);
    expect(
      validateEvent({
        type: 'request.error',
        requestId: 'request-1',
        code: 'WORKSPACE_NOT_FOUND',
        message: 'workspace missing'
      })
    ).toBe(true);
    expect(
      validateEnvelope(
        loadJson('examples/protocol/event-envelope.json')
      )
    ).toBe(true);
  });

  it('rejects unsupported protocol versions', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validate = ajv.compile(schemas.command);

    expect(
      validate({
        protocolVersion: 2,
        requestId: 'request-1',
        type: 'workspace.list'
      })
    ).toBe(false);
  });
});

function loadJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as Record<
    string,
    unknown
  >;
}
