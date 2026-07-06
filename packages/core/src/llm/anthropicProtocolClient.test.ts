import { describe, expect, it } from 'vitest';

import { AnthropicProtocolClient } from './anthropicProtocolClient';

describe('AnthropicProtocolClient', () => {
  it('sends messages using the Anthropic protocol', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new AnthropicProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://anthropic.example/v1',
      model: 'claude-test',
      anthropicVersion: '2023-06-01',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          id: 'msg-1',
          content: [{ type: 'text', text: '可以执行' }],
          usage: { input_tokens: 11, output_tokens: 4 }
        });
      }
    });

    const result = await client.complete({
      messages: [
        { role: 'system', content: '你是规划器' },
        { role: 'user', content: '拆任务' }
      ],
      maxTokens: 256
    });

    expect(result.text).toBe('可以执行');
    expect(result.provider).toBe('anthropic');
    expect(result.usage?.totalTokens).toBe(15);
    expect(calls[0]?.url).toBe('https://anthropic.example/v1/messages');
    expect(calls[0]?.init.headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': 'test-key'
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: 'claude-test',
      system: '你是规划器',
      messages: [{ role: 'user', content: '拆任务' }],
      max_tokens: 256,
      stream: false
    });
  });

  it('streams text deltas from Anthropic SSE responses', async () => {
    const client = new AnthropicProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://anthropic.example/v1',
      model: 'claude-test',
      fetch: async () =>
        new Response(
          [
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            ''
          ].join('\n')
        )
    });

    const chunks: string[] = [];
    for await (const chunk of client.stream({
      messages: [{ role: 'user', content: '打招呼' }]
    })) {
      if (chunk.type === 'text-delta') {
        chunks.push(chunk.text);
      }
    }

    expect(chunks).toEqual(['你', '好']);
  });

  it('sends tool definitions and parses Anthropic tool_use blocks', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new AnthropicProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://anthropic.example/v1',
      model: 'claude-test',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          model: 'claude-test',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-1',
              name: 'math.add',
              input: { a: 1, b: 2 }
            }
          ]
        });
      }
    });

    const result = await client.complete({
      messages: [
        { role: 'user', content: '计算 1 + 2' },
        {
          role: 'tool',
          toolCallId: 'toolu-prev',
          name: 'math.add',
          content: '3'
        }
      ],
      tools: [
        {
          name: 'math.add',
          description: '加法',
          parameters: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
            required: ['a', 'b']
          }
        }
      ]
    });

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      tools: [
        {
          name: 'math.add',
          description: '加法',
          input_schema: expect.objectContaining({ type: 'object' })
        }
      ],
      messages: expect.arrayContaining([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-prev',
              content: '3'
            }
          ]
        }
      ])
    });
    expect(result.toolCalls).toEqual([
      {
        id: 'toolu-1',
        name: 'math.add',
        input: { a: 1, b: 2 }
      }
    ]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
