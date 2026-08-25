import { describe, expect, it } from 'vitest';

import { AgentApiClient, ApiError, isUnauthorizedError } from './client';

describe('AgentApiClient.listModels', () => {
  it('读取用户可切换的模型及上下文窗口', async () => {
    const fetcher = async () => new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      data: {
        items: [{
          id: 'model-1',
          name: 'Default',
          provider: 'openai',
          model: 'gpt-5',
          contextWindow: 256_000
        }]
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
    const api = new AgentApiClient({
      baseUrl: 'http://localhost:8787',
      fetch: fetcher as typeof fetch
    });

    await expect(api.listModels()).resolves.toEqual([expect.objectContaining({
      id: 'model-1',
      contextWindow: 256_000
    })]);
  });
});

describe('AgentApiClient.listMessages', () => {
  it('兼容历史消息的空上下文统计对象', async () => {
    const fetcher = async () => new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      data: {
        items: [{
          id: 'message-1',
          conversationId: 'conversation-1',
          role: 'agent',
          content: '历史消息',
          parts: [{ type: 'text', text: '历史消息' }],
          contextUsage: {},
          status: 'done',
          createdAt: '2026-08-23T00:00:00.000Z'
        }]
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
    const api = new AgentApiClient({
      baseUrl: 'http://localhost:8787',
      fetch: fetcher as typeof fetch
    });

    await expect(api.listMessages('conversation-1')).resolves.toEqual([expect.objectContaining({
      id: 'message-1',
      contextUsage: undefined
    })]);
  });
});

describe('isUnauthorizedError', () => {
  it('只把 401 API 错误识别为登录失效', () => {
    expect(isUnauthorizedError(new ApiError(401, 'unauthorized', '未登录'))).toBe(true);
    expect(isUnauthorizedError(new ApiError(500, 'server_error', '失败'))).toBe(false);
    expect(isUnauthorizedError(new Error('网络错误'))).toBe(false);
  });
});
