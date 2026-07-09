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

  it('parses reasoning_content as thinking from complete responses', async () => {
    const client = new OpenAiProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      model: 'r1-test',
      fetch: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                reasoning_content: '先分析一下问题',
                content: '最终答案'
              }
            }
          ]
        })
    });

    const result = await client.complete({
      messages: [{ role: 'user', content: 'hi' }]
    });

    expect(result.thinking).toBe('先分析一下问题');
    expect(result.text).toBe('最终答案');
  });

  it('streams thinking-delta from reasoning_content and text-delta from content', async () => {
    const client = new OpenAiProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      model: 'r1-test',
      fetch: async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}',
            '',
            'data: {"choices":[{"delta":{"reasoning_content":"一下"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"答"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"案"}}]}',
            '',
            'data: [DONE]',
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
      { type: 'thinking-delta', text: '想' },
      { type: 'thinking-delta', text: '一下' },
      { type: 'text-delta', text: '答' },
      { type: 'text-delta', text: '案' },
      { type: 'done' }
    ]);
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

  it('parses streamed tool call fragments into complete tool-call chunks', async () => {
    const client = new OpenAiProtocolClient({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      model: 'gpt-test',
      fetch: async () =>
        new Response(
          [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    content: '先算一下',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        function: { name: 'math.add', arguments: '{"a":' }
                      }
                    ]
                  }
                }
              ]
            })}`,
            '',
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: '1,"b":2}' } }
                    ]
                  }
                }
              ]
            })}`,
            '',
            'data: [DONE]',
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
        call: { id: 'call-1', name: 'math.add', input: { a: 1, b: 2 } }
      },
      { type: 'done' }
    ]);
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
