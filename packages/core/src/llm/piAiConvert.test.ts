import { describe, expect, it } from 'vitest';

import {
  fromPiAssistantMessage,
  mapPiStreamEvent,
  toPiContext,
  toPiTool
} from './piAiConvert';

describe('piAiConvert', () => {
  it('extracts system prompts and maps tool turns', () => {
    const context = toPiContext(
      [
        { role: 'system', content: 'You are Kross.' },
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: 'I will use Glob',
          toolCalls: [
            {
              id: 'call_1',
              name: 'Glob',
              input: { pattern: '**/*.ts' }
            }
          ]
        },
        {
          role: 'tool',
          toolCallId: 'call_1',
          name: 'Glob',
          content: 'packages/core/src/index.ts'
        }
      ],
      [
        {
          name: 'Glob',
          description: 'Find files',
          parameters: {
            type: 'object',
            properties: { pattern: { type: 'string' } },
            required: ['pattern']
          }
        }
      ],
      {
        provider: 'openai',
        model: 'gpt-test',
        api: 'openai-completions'
      }
    );

    expect(context.systemPrompt).toBe('You are Kross.');
    expect(context.messages).toHaveLength(3);
    expect(context.messages[0]).toMatchObject({
      role: 'user',
      content: 'list files'
    });
    expect(context.messages[1]).toMatchObject({
      role: 'assistant',
      stopReason: 'toolUse'
    });
    const assistant = context.messages[1];
    if (assistant?.role !== 'assistant') {
      throw new Error('expected assistant message');
    }
    expect(assistant.content).toEqual([
      { type: 'text', text: 'I will use Glob' },
      {
        type: 'toolCall',
        id: 'call_1',
        name: 'Glob',
        arguments: { pattern: '**/*.ts' }
      }
    ]);
    expect(context.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'Glob'
    });
    expect(context.tools?.[0]?.name).toBe('Glob');
    expect(context.tools?.[0]?.parameters).toMatchObject({
      type: 'object',
      properties: { pattern: { type: 'string' } }
    });
  });

  it('converts JSON Schema tools via Type.Unsafe', () => {
    const tool = toPiTool({
      name: 'Read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    });

    expect(tool.name).toBe('Read');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    });
  });

  it('maps assistant messages back to LlmResponse', () => {
    const response = fromPiAssistantMessage(
      {
        provider: 'openai',
        model: 'gpt-test',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'hello' },
          {
            type: 'toolCall',
            id: 'c1',
            name: 'Read',
            arguments: { path: 'a.ts' }
          }
        ],
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      },
      'openai'
    );

    expect(response).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      text: 'hello',
      thinking: 'plan',
      toolCalls: [{ id: 'c1', name: 'Read', input: { path: 'a.ts' } }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    });
  });

  it('maps stream events to LlmStreamChunk', () => {
    expect(mapPiStreamEvent({ type: 'text_delta', delta: 'hi' })).toEqual({
      type: 'text-delta',
      text: 'hi'
    });
    expect(
      mapPiStreamEvent({ type: 'thinking_delta', delta: 'think' })
    ).toEqual({
      type: 'thinking-delta',
      text: 'think'
    });
    expect(
      mapPiStreamEvent({
        type: 'toolcall_end',
        toolCall: { id: '1', name: 'Glob', arguments: { pattern: '*' } }
      })
    ).toEqual({
      type: 'tool-call',
      call: { id: '1', name: 'Glob', input: { pattern: '*' } }
    });
    expect(mapPiStreamEvent({ type: 'done' })).toEqual({ type: 'done' });
    expect(
      mapPiStreamEvent({
        type: 'error',
        error: { errorMessage: 'boom' }
      })
    ).toEqual({ type: 'error', message: 'boom' });
    expect(mapPiStreamEvent({ type: 'start' })).toBeUndefined();
  });
});
