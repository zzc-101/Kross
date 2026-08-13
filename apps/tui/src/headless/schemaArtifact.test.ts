import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { HEADLESS_EVENT_TYPES, HEADLESS_SCHEMA_VERSION } from './contract';

describe('headless JSON Schema artifact', () => {
  it('tracks the runtime event version and complete event type set', () => {
    const schemaUrl = new URL(
      '../../../../docs/schemas/kross-headless-event-v1.schema.json',
      import.meta.url
    );
    const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as {
      properties?: {
        schemaVersion?: { const?: number };
        type?: { enum?: string[] };
      };
      required?: string[];
    };

    expect(schema.properties?.schemaVersion?.const).toBe(
      HEADLESS_SCHEMA_VERSION
    );
    expect(schema.properties?.type?.enum).toEqual([
      ...HEADLESS_EVENT_TYPES
    ]);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'schemaVersion',
        'type',
        'timestamp',
        'runId',
        'sessionId',
        'sequence',
        'data'
      ])
    );
  });
});
