import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentRuntime,
  HybridSessionStore,
  ToolGateway,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamChunk,
  type TraceEvent,
  type TraceStore
} from '@kross/core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  HEADLESS_SCHEMA_VERSION,
  headlessEventSchema,
  headlessExitCodes,
  type HeadlessEvent,
  type HeadlessExecRequest
} from './contract';
import { runHeadlessCommand } from './runHeadless';

describe('headless runtime host', () => {
  it('runs a real Runtime with a Fixture LLM and persists the session', async () => {
    const fixture = createFixture();
    const client = new TextFixtureClient('fixture completed');
    let hostClosed = 0;

    const exitCode = await runHeadlessCommand(
      request('inspect the fixture'),
      {
        ...fixture.dependencies,
        createHost: async ({ runId }) => ({
          runtime: new AgentRuntime({
            traceStore: new MemoryTraceStore(),
            llmClient: client,
            createRunId: () => runId
          }),
          close: async () => {
            hostClosed += 1;
          }
        })
      }
    );

    expect(exitCode).toBe(headlessExitCodes.success);
    expect(hostClosed).toBe(1);
    expect(fixture.stderr.text).toBe('');
    const events = fixture.events();
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'turn.started',
      'text.delta',
      'run.completed'
    ]);
    expect(events.every((event) => event.runId === 'run-headless-test')).toBe(
      true
    );
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(events.at(-1)).toMatchObject({
      type: 'run.completed',
      data: {
        status: 'completed',
        summary: 'fixture completed',
        verificationStatus: 'not-needed'
      }
    });

    const sessionId = events[0]?.sessionId;
    const reopened = new HybridSessionStore({
      krossHome: fixture.krossHome
    });
    const stored = reopened.loadSession(fixture.cwd, sessionId);
    expect(stored?.messages.map((message) => message.from)).toEqual([
      'user',
      'agent'
    ]);
    expect(stored?.contextState).toBeDefined();
    expect(stored?.workState).toBeDefined();
    reopened.close();
  });

  it('restores a named session into a new Runtime', async () => {
    const fixture = createFixture();
    const firstClient = new TextFixtureClient('first answer');
    await runHeadlessCommand(request('first task'), {
      ...fixture.dependencies,
      createHost: createFixtureHost(firstClient)
    });
    const sessionId = fixture.events()[0]?.sessionId;
    fixture.stdout.text = '';

    const secondClient = new TextFixtureClient('second answer');
    const exitCode = await runHeadlessCommand(
      {
        ...request('second task'),
        sessionId
      },
      {
        ...fixture.dependencies,
        createHost: createFixtureHost(secondClient)
      }
    );

    expect(exitCode).toBe(headlessExitCodes.success);
    expect(
      secondClient.requests[0]?.messages.map((message) => message.content)
    ).toEqual(
      expect.arrayContaining(['first task', 'first answer', 'second task'])
    );
    expect(fixture.events()[0]?.sessionId).toBe(sessionId);
  });

  it('exits at a tool approval boundary without executing the tool', async () => {
    const fixture = createFixture();
    const client = new ToolFixtureClient();
    let writes = 0;

    const exitCode = await runHeadlessCommand(request('write a file'), {
      ...fixture.dependencies,
      createHost: async ({ runId }) => {
        const traces = new MemoryTraceStore();
        const gateway = new ToolGateway({ traceStore: traces });
        gateway.register({
          name: 'fixture.write',
          description: 'write fixture data',
          risk: 'write',
          inputSchema: z.object({ content: z.string() }),
          execute: async () => {
            writes += 1;
            return { content: 'written' };
          }
        });
        return {
          runtime: new AgentRuntime({
            traceStore: traces,
            llmClient: client,
            toolGateway: gateway,
            createRunId: () => runId
          }),
          close: async () => undefined
        };
      }
    });

    expect(exitCode).toBe(headlessExitCodes.approvalRequired);
    expect(writes).toBe(0);
    expect(fixture.events().at(-1)).toMatchObject({
      type: 'approval.required',
      data: {
        toolCallId: 'write-1',
        toolName: 'fixture.write',
        risk: 'write'
      }
    });
  });

  it('uses the verification-failed exit code even when model text claims success', async () => {
    const fixture = createFixture();
    const client = new VerificationFailureClient();

    const exitCode = await runHeadlessCommand(
      {
        ...request('run verification'),
        permission: 'auto'
      },
      {
        ...fixture.dependencies,
        createHost: async ({ runId }) => {
          const traces = new MemoryTraceStore();
          const gateway = new ToolGateway({ traceStore: traces });
          gateway.register({
            name: 'Bash',
            description: 'run verification',
            risk: 'execute',
            inputSchema: z.object({ command: z.string() }),
            execute: async () => ({
              content: 'Type error',
              summary: 'exit=2, 1 line',
              data: { exitCode: 2 }
            })
          });
          return {
            runtime: new AgentRuntime({
              traceStore: traces,
              llmClient: client,
              toolGateway: gateway,
              createRunId: () => runId
            }),
            close: async () => undefined
          };
        }
      }
    );

    expect(exitCode).toBe(headlessExitCodes.verificationFailed);
    expect(fixture.events().at(-1)).toMatchObject({
      type: 'run.completed',
      data: {
        status: 'completed',
        summary: 'All checks passed.',
        verificationStatus: 'failed'
      }
    });
  });

  it('maps SIGINT to cancellation and still closes the Runtime Host', async () => {
    const fixture = createFixture();
    const signals = fixture.dependencies.signals;
    let hostClosed = 0;
    const client = new InterruptFixtureClient(signals);

    const exitCode = await runHeadlessCommand(request('wait for signal'), {
      ...fixture.dependencies,
      createHost: async ({ runId }) => ({
        runtime: new AgentRuntime({
          traceStore: new MemoryTraceStore(),
          llmClient: client,
          createRunId: () => runId
        }),
        close: async () => {
          hostClosed += 1;
        }
      })
    });

    expect(exitCode).toBe(headlessExitCodes.interrupted);
    expect(hostClosed).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(fixture.events().at(-1)).toMatchObject({
      type: 'error',
      data: { category: 'interrupted' }
    });
  });

  it('rejects empty stdin before creating a Runtime Host', async () => {
    const fixture = createFixture();
    let hosts = 0;
    const exitCode = await runHeadlessCommand(
      {
        ...request('unused'),
        input: { source: 'stdin' }
      },
      {
        ...fixture.dependencies,
        readStdin: async () => ' \n',
        createHost: async () => {
          hosts += 1;
          throw new Error('should not create host');
        }
      }
    );

    expect(exitCode).toBe(headlessExitCodes.usage);
    expect(hosts).toBe(0);
    expect(fixture.events()).toEqual([
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ category: 'usage' })
      })
    ]);
  });
});

function request(task: string): HeadlessExecRequest {
  return {
    schemaVersion: HEADLESS_SCHEMA_VERSION,
    input: { source: 'argument', task },
    mode: 'auto',
    permission: 'default',
    json: true
  };
}

function createFixture(): {
  cwd: string;
  krossHome: string;
  stdout: BufferWriter;
  stderr: BufferWriter;
  events: () => HeadlessEvent[];
  dependencies: {
    processCwd: string;
    stdout: BufferWriter;
    stderr: BufferWriter;
    now: () => Date;
    createRunId: () => string;
    createSessionStore: () => HybridSessionStore;
    signals: EventEmitter;
  };
} {
  const root = mkdtempSync(join(tmpdir(), 'kross-headless-test-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  const krossHome = join(root, '.kross');
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  let tick = 0;
  return {
    cwd,
    krossHome,
    stdout,
    stderr,
    events: () =>
      stdout.text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => headlessEventSchema.parse(JSON.parse(line))),
    dependencies: {
      processCwd: cwd,
      stdout,
      stderr,
      now: () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++),
      createRunId: () => 'run-headless-test',
      createSessionStore: () =>
        new HybridSessionStore({
          krossHome,
          createSessionId: () => 'session-headless-test'
        }),
      signals: new EventEmitter()
    }
  };
}

function createFixtureHost(
  client: LlmClient
): NonNullable<
  Parameters<typeof runHeadlessCommand>[1]
>['createHost'] {
  return async ({ runId }) => ({
    runtime: new AgentRuntime({
      traceStore: new MemoryTraceStore(),
      llmClient: client,
      createRunId: () => runId
    }),
    close: async () => undefined
  });
}

class BufferWriter {
  text = '';

  write(text: string): void {
    this.text += text;
  }
}

class MemoryTraceStore implements TraceStore {
  readonly events: TraceEvent[] = [];

  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }

  async listRunIds(): Promise<string[]> {
    return [...new Set(this.events.map((event) => event.runId))];
  }
}

class TextFixtureClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  constructor(private readonly text: string) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return {
      provider: this.provider,
      model: 'fixture',
      text: this.text,
      raw: {}
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    yield { type: 'text-delta', text: this.text };
    yield { type: 'done' };
  }
}

class ToolFixtureClient implements LlmClient {
  readonly provider = 'openai' as const;

  async complete(): Promise<LlmResponse> {
    throw new Error('stream should be used');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield {
      type: 'tool-call',
      call: {
        id: 'write-1',
        name: 'fixture.write',
        input: { content: 'new content' }
      }
    };
    yield { type: 'done' };
  }
}

class VerificationFailureClient implements LlmClient {
  readonly provider = 'openai' as const;
  private requests = 0;

  async complete(): Promise<LlmResponse> {
    throw new Error('stream should be used');
  }

  async *stream(): AsyncIterable<LlmStreamChunk> {
    this.requests += 1;
    if (this.requests === 1) {
      yield {
        type: 'tool-call',
        call: {
          id: 'verify-1',
          name: 'Bash',
          input: { command: 'npm run typecheck' }
        }
      };
    } else {
      yield { type: 'text-delta', text: 'All checks passed.' };
    }
    yield { type: 'done' };
  }
}

class InterruptFixtureClient implements LlmClient {
  readonly provider = 'openai' as const;

  constructor(private readonly signals: EventEmitter) {}

  async complete(): Promise<LlmResponse> {
    throw new Error('stream should be used');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.signals.emit('SIGINT');
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    if (request.signal?.aborted) {
      throw request.signal.reason;
    }
    yield { type: 'done' };
  }
}
