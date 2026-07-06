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
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
