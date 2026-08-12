import { describe, expect, it } from 'vitest';

import { findBreakingSchemaChanges } from './jsonSchemaCompatibility';

describe('findBreakingSchemaChanges', () => {
  it('accepts optional fields on open objects and new union variants', () => {
    const previous = {
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'run.progress' },
            requestId: { type: 'string' }
          },
          required: ['type', 'requestId']
        }
      ]
    };
    const next = {
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'run.progress' },
            requestId: { type: 'string' },
            limit: { type: 'number' }
          },
          required: ['type', 'requestId']
        },
        {
          type: 'object',
          properties: { type: { const: 'artifact.ready' } },
          required: ['type']
        }
      ]
    };

    expect(findBreakingSchemaChanges(previous, next)).toEqual([]);
  });

  it('rejects optional fields added to strict objects', () => {
    const previous = {
      type: 'object',
      properties: { type: { const: 'run.progress' } },
      required: ['type'],
      additionalProperties: false
    };
    const next = {
      type: 'object',
      properties: {
        type: { const: 'run.progress' },
        message: { type: 'string' }
      },
      required: ['type'],
      additionalProperties: false
    };
    expect(findBreakingSchemaChanges(previous, next)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'strict 对象新增字段' })
      ])
    );
  });

  it('rejects removed variants and enum values', () => {
    const previous = {
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'run.progress' },
            mode: { enum: ['auto', 'plan'] }
          }
        },
        {
          type: 'object',
          properties: { type: { const: 'artifact.ready' } }
        }
      ]
    };
    const next = {
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'run.progress' },
            mode: { enum: ['auto'] }
          }
        }
      ]
    };

    expect(findBreakingSchemaChanges(previous, next)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: '允许值被移除："plan"' }),
        expect.objectContaining({ message: '联合类型分支被移除' })
      ])
    );
  });

  it('rejects required-state changes and narrowed constraints', () => {
    const previous = {
      type: 'object',
      properties: {
        input: { type: 'string', minLength: 1, maxLength: 4000 }
      },
      required: ['input']
    };
    const next = {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          minLength: 2,
          maxLength: 2000,
          pattern: '^[a-z]+$'
        },
        mode: { type: 'string' }
      },
      required: ['input', 'mode']
    };

    expect(findBreakingSchemaChanges(previous, next)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'minLength 约束收紧：1 -> 2' }),
        expect.objectContaining({ message: 'maxLength 约束收紧：4000 -> 2000' }),
        expect.objectContaining({ message: '新增 pattern 约束：^[a-z]+$' }),
        expect.objectContaining({ message: '字段 required 状态发生变化' })
      ])
    );
  });

  it('rejects common numeric, collection, and object constraint tightening', () => {
    const previous = {
      type: 'object',
      properties: {
        value: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 100 },
        amount: { type: 'number', multipleOf: 1 },
        items: { type: 'array' },
        metadata: { type: 'object', minProperties: 0, maxProperties: 10 }
      }
    };
    const next = {
      type: 'object',
      properties: {
        value: { type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 99 },
        amount: { type: 'number', multipleOf: 2 },
        items: { type: 'array', uniqueItems: true },
        metadata: { type: 'object', minProperties: 1, maxProperties: 9 }
      }
    };
    expect(findBreakingSchemaChanges(previous, next)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'exclusiveMinimum 约束收紧：0 -> 1' }),
        expect.objectContaining({ message: 'exclusiveMaximum 约束收紧：100 -> 99' }),
        expect.objectContaining({ message: 'multipleOf 约束收紧：1 -> 2' }),
        expect.objectContaining({ message: '新增 uniqueItems 约束' }),
        expect.objectContaining({ message: 'minProperties 约束收紧：0 -> 1' }),
        expect.objectContaining({ message: 'maxProperties 约束收紧：10 -> 9' })
      ])
    );
  });
});
