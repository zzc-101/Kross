import { describe, expect, it } from 'vitest';

import { findBreakingSchemaChanges } from './jsonSchemaCompatibility';

describe('findBreakingSchemaChanges', () => {
  it('accepts optional fields and union variants added in place', () => {
    const previous = {
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'session.list' },
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
            type: { const: 'session.list' },
            requestId: { type: 'string' },
            limit: { type: 'number' }
          },
          required: ['type', 'requestId']
        },
        {
          type: 'object',
          properties: { type: { const: 'session.create' } },
          required: ['type']
        }
      ]
    };

    expect(findBreakingSchemaChanges(previous, next)).toEqual([]);
  });

  it('rejects removed variants and enum values', () => {
    const previous = {
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'session.list' },
            mode: { enum: ['auto', 'plan'] }
          }
        },
        {
          type: 'object',
          properties: { type: { const: 'session.create' } }
        }
      ]
    };
    const next = {
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'session.list' },
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
});
