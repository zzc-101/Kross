import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { App, type AppTestApi } from './App';
import {
  AgentRuntime,
  createConfigImportController,
  HybridSessionStore,
  ObservableTraceStore,
  SessionContext,
  type ContextMaintenanceResult,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamChunk,
  type TraceEvent,
  type TraceStore,
  ToolGateway,
  WorkspaceRoots
} from '@kross/core';
import { z } from 'zod';

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
  model = 'fake-model';
  thinkingEffort: import('@kross/core').ThinkingEffort = 'medium';
  lastUsage: LlmResponse['usage'];

  constructor(private readonly text: string) {}

  setModel(model: string): void {
    this.model = model.trim();
  }

  setThinkingEffort(effort: import('@kross/core').ThinkingEffort): void {
    this.thinkingEffort = effort;
  }

  clearLastUsage(): void {
    this.lastUsage = undefined;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response: LlmResponse = {
      provider: this.provider,
      model: request.model ?? this.model,
      text: this.text,
      raw: {},
      usage: { inputTokens: 37, outputTokens: 5, totalTokens: 42 }
    };
    this.lastUsage = response.usage;
    return response;
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text-delta', text: this.text };
    const usage = { inputTokens: 37, outputTokens: 5, totalTokens: 42 };
    this.lastUsage = usage;
    yield { type: 'done', usage };
  }
}

export class ThinkingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;

  constructor(
    private readonly thinking: string,
    private readonly text: string
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    return {
      provider: this.provider,
      model: request.model ?? 'fake-model',
      text: this.text,
      thinking: this.thinking,
      raw: {}
    };
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'thinking-delta', text: this.thinking };
    yield { type: 'text-delta', text: this.text };
    yield { type: 'done' };
  }
}

export class ControlledStreamingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  private release: (() => void) | undefined;

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text-delta', text: '流' };
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    yield { type: 'text-delta', text: '式完成' };
    yield { type: 'done' };
  }

  releaseFinalChunk(): void {
    this.release?.();
  }
}

export class DelayedLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];
  private readonly pending: Array<{
    settled: boolean;
    resolve: (value: string) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  resolveNext(text: string): void {
    let entry = this.pending.shift();
    while (entry?.settled) {
      entry = this.pending.shift();
    }
    if (entry) {
      entry.settled = true;
      entry.resolve(text);
    }
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    const text = await new Promise<string>((resolve, reject) => {
      const entry = { settled: false, resolve, reject };
      this.pending.push(entry);
      request.signal?.addEventListener(
        'abort',
        () => {
          if (!entry.settled) {
            entry.settled = true;
            reject(request.signal?.reason);
          }
        },
        { once: true }
      );
    });
    yield { type: 'text-delta', text };
    yield { type: 'done' };
  }
}

export class MultiReadToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  private phase: 'tool' | 'final' = 'tool';

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    if (this.phase === 'tool') {
      this.phase = 'final';
      for (const [id, path] of [
        ['r1', 'a.ts'],
        ['r2', 'b.ts'],
        ['r3', 'c.ts']
      ] as const) {
        yield {
          type: 'tool-call',
          call: { id, name: 'Read', input: { path } }
        };
      }
      yield { type: 'done' };
      return;
    }
    yield { type: 'text-delta', text: '都读完了' };
    yield { type: 'done' };
  }
}

export class ReadToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  private phase: 'tool' | 'final' = 'tool';

  async complete(request: LlmRequest): Promise<LlmResponse> {
    return {
      provider: this.provider,
      model: 'fake-model',
      text: '读完了',
      raw: {}
    };
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    if (this.phase === 'tool') {
      this.phase = 'final';
      yield {
        type: 'tool-call',
        call: {
          id: 'read-1',
          name: 'Read',
          input: { path: 'README.md' }
        }
      };
      yield { type: 'done' };
      return;
    }

    yield { type: 'text-delta', text: '读完了' };
    yield { type: 'done' };
  }
}

export class MultiTurnThinkingToolClient implements LlmClient {
  readonly provider = 'openai' as const;
  private phase: 'tool' | 'final' = 'tool';

  async complete(): Promise<LlmResponse> {
    throw new Error('complete should not be used for streaming chat');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    if (this.phase === 'tool') {
      this.phase = 'final';
      yield { type: 'thinking-delta', text: '先看看文件' };
      yield {
        type: 'tool-call',
        call: { id: 'read-1', name: 'Read', input: { path: 'README.md' } }
      };
      yield { type: 'done' };
      return;
    }

    yield { type: 'thinking-delta', text: '根据内容总结' };
    yield { type: 'text-delta', text: '最终总结' };
    yield { type: 'done' };
  }
}

export class WriteToolCallingLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];
  private readonly delayFollowup: boolean;
  private readonly thinking: string | undefined;
  private readonly finalText: string;
  private release: (() => void) | undefined;
  private followupReleased = false;

  constructor(
    options: { delayFollowup?: boolean; thinking?: string; finalText?: string } = {}
  ) {
    this.delayFollowup = options.delayFollowup === true;
    this.thinking = options.thinking;
    this.finalText = options.finalText ?? '写入完成';
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    // 允许 releaseFollowup 抢跑：若测试先 release，complete 不再阻塞。
    if (this.delayFollowup && this.requests.length > 1 && !this.followupReleased) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return {
      provider: this.provider,
      model: 'fake-model',
      text: this.finalText,
      thinking: this.thinking,
      raw: {}
    };
  }

  releaseFollowup(): void {
    this.followupReleased = true;
    this.release?.();
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: 'tool-call',
        call: {
          id: 'write-1',
          name: 'fs.write',
          input: { path: 'README.md', content: 'hello' }
        }
      };
      yield { type: 'done' };
      return;
    }

    if (this.thinking) {
      yield { type: 'thinking-delta', text: this.thinking };
    }
    yield { type: 'text-delta', text: this.finalText };
    yield { type: 'done' };
  }
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitUntil timed out');
}

export function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'kross-tui-home-'));
}
