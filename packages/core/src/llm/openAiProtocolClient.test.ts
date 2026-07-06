import { describe, expect, it } from 'vitest';

import { OpenAiProtocolClient } from './openAiProtocolClient';

describe('OpenAiProtocolClient', () => {
  it('sends chat completions using the OpenAI-compatible protocol', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new OpenAiProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      model: 'gpt-test',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          id: 'chatcmpl-1',
          choices: [{ message: { content: '计划完成' } }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
        });
      }
    });

    const result = await client.complete({
      messages: [{ role: 'user', content: '规划一下' }],
      maxTokens: 128,
      temperature: 0.2
    });

    expect(result.text).toBe('计划完成');
    expect(result.provider).toBe('openai');
    expect(result.usage?.totalTokens).toBe(10);
    expect(calls[0]?.url).toBe('https://llm.example/v1/chat/completions');
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: 'gpt-test',
      messages: [{ role: 'user', content: '规划一下' }],
      max_tokens: 128,
      temperature: 0.2,
      stream: false
    });
  });

  it('streams text deltas from OpenAI-compatible SSE responses', async () => {
    const client = new OpenAiProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      model: 'gpt-test',
      fetch: async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"你"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"好"}}]}',
            '',
            'data: [DONE]',
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

  it('sends tool definitions and parses OpenAI tool calls', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new OpenAiProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      model: 'gpt-test',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          model: 'gpt-test',
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'math.add',
                      arguments: '{"a":1,"b":2}'
                    }
                  }
                ]
              }
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
          toolCallId: 'previous-call',
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
          type: 'function',
          function: {
            name: 'math.add',
            description: '加法',
            parameters: expect.objectContaining({ type: 'object' })
          }
        }
      ],
      messages: expect.arrayContaining([
        {
          role: 'tool',
          tool_call_id: 'previous-call',
          name: 'math.add',
          content: '3'
        }
      ])
    });
    expect(result.toolCalls).toEqual([
      {
        id: 'call-1',
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
