import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  chunkTextForStream,
  isCasualChatInput,
  parsePlanIntentKind
} from './agentRuntime';
import { InMemoryContextManager, type SessionContext } from '../context/sessionContext';
import type { LlmMessage } from '../llm/types';
import type { TraceEvent } from '../domain';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk
} from '../llm/types';
import { ToolGateway } from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';
import { WorkspaceRoots } from '../workspace/workspaceRoots';
import { z } from 'zod';

/** Adapt complete()-style fakes for run() which now drains the streaming tool loop. */
export async function* streamFromComplete(
  response: LlmResponse
): AsyncIterable<LlmStreamChunk> {
  if (response.thinking) {
    yield { type: 'thinking-delta', text: response.thinking };
  }
  if (response.text) {
    yield { type: 'text-delta', text: response.text };
  }
  for (const call of response.toolCalls ?? []) {
    yield { type: 'tool-call', call };
  }
  yield { type: 'done' };
}

export function getStoredConversation(
  sessionContext: SessionContext
): LlmMessage[] {
  return sessionContext.getCommittedDialog();
}

export class InMemoryTraceStore implements TraceStore {
  readonly events: TraceEvent[] = [];

  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }

  async listRunIds(): Promise<string[]> {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const runId = this.events[index]?.runId;
      if (!runId || seen.has(runId)) {
        continue;
      }
      seen.add(runId);
      ids.push(runId);
    }
    return ids;
  }
}

export class FakeLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];
  readonly contextWindow = 512_000;
  lastUsage = undefined as LlmResponse['usage'];

  constructor(public text = '1. 探索测试入口\n2. 补充断言') {}

  clearLastUsage(): void {
    this.lastUsage = undefined;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const response: LlmResponse = {
      provider: this.provider,
      model: 'fake-model',
      text: this.text,
      raw: { ok: true },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }
    };
    this.lastUsage = response.usage;
    return response;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    const response: LlmResponse = {
      provider: this.provider,
      model: 'fake-model',
      text: this.text,
      raw: { ok: true },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }
    };
    this.lastUsage = response.usage;
    yield* streamFromComplete(response);
  }
}

export class FailingLlmClient implements LlmClient {
  readonly provider = 'anthropic' as const;

  constructor(private readonly message: string) {}

  async complete(): Promise<LlmResponse> {
    throw new Error(this.message);
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    throw new Error(this.message);
  }
}

export class StreamingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly streamRequests: LlmRequest[] = [];
  completeCalls = 0;

  constructor(private readonly chunks: string[]) {}

  async complete(): Promise<LlmResponse> {
    this.completeCalls += 1;
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.streamRequests.push(request);
    for (const text of this.chunks) {
      yield { type: 'text-delta', text };
    }
    yield { type: 'done' };
  }
}

export class ThinkingStreamingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'thinking-delta', text: '先推理' };
    yield { type: 'text-delta', text: '结论' };
    yield { type: 'done' };
  }
}

export class MultiTurnStreamingToolClient implements LlmClient {
  readonly provider = 'openai' as const;
  private phase: 'tool' | 'final' = 'tool';

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    if (this.phase === 'tool') {
      this.phase = 'final';
      yield { type: 'thinking-delta', text: '想先读' };
      yield {
        type: 'tool-call',
        call: { id: 'read-1', name: 'Read', input: { path: 'a.ts' } }
      };
      yield { type: 'done' };
      return;
    }

    yield { type: 'text-delta', text: '读完了' };
    yield { type: 'done' };
  }
}

export class ToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [
          {
            id: 'call-1',
            name: 'math.add',
            input: { a: 1, b: 2 }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '结果是 3',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

export class BuiltinWriteToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [
          {
            id: 'write-builtin-1',
            name: 'Write',
            input: { path: 'src/demo.ts', content: 'hello' }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '写完了',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

export class MultiStepToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [{ id: 'call-1', name: 'math.add', input: { a: 1, b: 2 } }]
      };
    }
    if (this.requests.length === 2) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [{ id: 'call-2', name: 'math.double', input: { value: 3 } }]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '最终结果是 6',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

export class LoopingToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    // 软着陆请求不带 tools
    if (!request.tools || request.tools.length === 0) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '收尾：工具轮次已满，已停止继续读文件',
        raw: {}
      };
    }
    return {
      provider: this.provider,
      model: 'fake-model',
      text: '',
      raw: {},
      toolCalls: [
        {
          id: `read-${this.requests.length}`,
          name: 'fs.read',
          input: { path: 'README.md' }
        }
      ]
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

export class ReadThenWriteToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [{ id: 'read-1', name: 'fs.read', input: { path: 'README.md' } }]
      };
    }
    if (this.requests.length === 2) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [
          {
            id: 'write-1',
            name: 'fs.write',
            input: { path: 'README.md', content: 'new content' }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '改写完成',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

export class ParallelToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [
          { id: 'read-1', name: 'fs.read', input: { path: 'README.md' } },
          {
            id: 'write-1',
            name: 'fs.write',
            input: { path: 'README.md', content: 'new content' }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '读写完成',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

export class StreamingToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly streamRequests: LlmRequest[] = [];

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.streamRequests.push(request);
    if (this.streamRequests.length === 1) {
      yield { type: 'text-delta', text: '让我查一下' };
      yield {
        type: 'tool-call',
        call: { id: 'read-1', name: 'fs.read', input: { path: 'README.md' } }
      };
      yield { type: 'done' };
      return;
    }

    yield { type: 'text-delta', text: '文件内容已读取' };
    yield { type: 'done' };
  }
}

export class LoopingStreamingToolClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly streamRequests: LlmRequest[] = [];
  private count = 0;

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(request?: LlmRequest): AsyncIterable<LlmStreamChunk> {
    if (request) {
      this.streamRequests.push(request);
    }
    if (!request?.tools || request.tools.length === 0) {
      yield { type: 'text-delta', text: '收尾：工具轮次已满，已停止继续读文件' };
      yield { type: 'done' };
      return;
    }
    this.count += 1;
    yield {
      type: 'tool-call',
      call: {
        id: `read-${this.count}`,
        name: 'fs.read',
        input: { path: 'README.md' }
      }
    };
    yield { type: 'done' };
  }
}

export class WriteToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  constructor(private readonly finalText = '写入完成') {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [
          {
            id: 'write-1',
            name: 'fs.write',
            input: { path: 'README.md', content: 'hello' }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: this.finalText,
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

export class DoubleWriteApprovalLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [
          {
            id: 'write-1',
            name: 'fs.write',
            input: { path: 'a.txt', content: 'a' }
          }
        ]
      };
    }
    if (this.requests.length === 2) {
      return {
        provider: this.provider,
        model: 'fake-model',
        text: '',
        raw: {},
        toolCalls: [
          {
            id: 'write-2',
            name: 'fs.write',
            input: { path: 'b.txt', content: 'b' }
          }
        ]
      };
    }

    return {
      provider: this.provider,
      model: 'fake-model',
      text: '两次写入完成',
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

export class AbortableStreamingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly started: Promise<void>;
  private markStarted: (() => void) | undefined;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text-delta', text: '半截回复' };
    this.markStarted?.();
    await waitForAbort(request.signal);
  }
}

export class SingleToolStreamingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield {
      type: 'tool-call',
      call: { id: 'long-1', name: 'long.read', input: {} }
    };
    yield { type: 'done' };
  }
}

export function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error('missing signal'));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true
    });
  });
}
