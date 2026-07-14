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

  it('uses bearer authorization when an Anthropic auth token is configured', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new AnthropicProtocolClient({
      authToken: 'test-token',
      baseUrl: 'https://anthropic.example/v1',
      model: 'claude-test',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          id: 'msg-1',
          content: [{ type: 'text', text: 'ok' }]
        });
      }
    });

    await client.complete({
      messages: [{ role: 'user', content: '打招呼' }]
    });

    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer test-token'
    });
    expect(calls[0]?.init.headers).not.toMatchObject({
      'x-api-key': expect.any(String)
    });
  });

  it('adds the Anthropic v1 path when baseUrl omits it', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new AnthropicProtocolClient({
      authToken: 'test-token',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      model: 'glm-test',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          id: 'msg-1',
          content: [{ type: 'text', text: 'ok' }]
        });
      }
    });

    await client.complete({
      messages: [{ role: 'user', content: '打招呼' }]
    });

    expect(calls[0]?.url).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v1/messages'
    );
  });

  it('parses thinking content blocks from complete responses', async () => {
    const client = new AnthropicProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://anthropic.example/v1',
      model: 'claude-test',
      fetch: async () =>
        jsonResponse({
          content: [
            { type: 'thinking', thinking: '先推理' },
            { type: 'text', text: '结论' }
          ]
        })
    });

    const result = await client.complete({
      messages: [{ role: 'user', content: 'hi' }]
    });

    expect(result.thinking).toBe('先推理');
    expect(result.text).toBe('结论');
  });

  it('streams thinking_delta as thinking-delta chunks', async () => {
    const client = new AnthropicProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://anthropic.example/v1',
      model: 'claude-test',
      fetch: async () =>
        new Response(
          [
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"推"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"理"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"答"}}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            ''
          ].join('\n')
        )
    });

    const chunks = [];
    for await (const chunk of client.stream({
      messages: [{ role: 'user', content: 'hi' }]
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'thinking-delta', text: '推' },
      { type: 'thinking-delta', text: '理' },
      { type: 'text-delta', text: '答' },
      { type: 'done' }
    ]);
  });

  it('streams text deltas from Anthropic SSE responses', async () => {
    const client = new AnthropicProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://anthropic.example/v1',
      model: 'claude-test',
      fetch: async () =>
        new Response(
          [
            'event: message_start',
            'data: {"type":"message_start","message":{"usage":{"input_tokens":31,"output_tokens":0}}}',
            '',
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
    expect(client.lastUsage?.inputTokens).toBe(31);
  });

  it('parses streamed tool_use blocks into complete tool-call chunks', async () => {
    const client = new AnthropicProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://anthropic.example/v1',
      model: 'claude-test',
      fetch: async () =>
        new Response(
          [
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"先算一下"}}',
            '',
            'event: content_block_start',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu-1","name":"math.add"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1,"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"b\\":2}"}}',
            '',
            'event: content_block_stop',
            'data: {"type":"content_block_stop","index":1}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            ''
          ].join('\n')
        )
    });

    const chunks = [];
    for await (const chunk of client.stream({
      messages: [{ role: 'user', content: '计算 1 + 2' }]
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'text-delta', text: '先算一下' },
      {
        type: 'tool-call',
        call: { id: 'toolu-1', name: 'math.add', input: { a: 1, b: 2 } }
      },
      { type: 'done' }
    ]);
  });

  it('surfaces streamed Anthropic error events instead of silently ending', async () => {
    const client = new AnthropicProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://anthropic.example/v1',
      model: 'claude-test',
      fetch: async () =>
        new Response(
          [
            'event: error',
            'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
            ''
          ].join('\n')
        )
    });

    await expect(async () => {
      for await (const chunk of client.stream({
        messages: [{ role: 'user', content: '打招呼' }]
      })) {
        void chunk;
      }
    }).rejects.toThrow('Overloaded');
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
