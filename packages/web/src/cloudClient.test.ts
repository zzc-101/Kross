import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CloudClient,
  httpEndpoint,
  readEventStream,
  type ConnectionState
} from './cloudClient';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

class MockTransport {
  readonly streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  readonly commands: Array<Record<string, unknown>> = [];
  readonly commandResults: Array<() => Promise<Response>> = [];
  readonly encoder = new TextEncoder();

  readonly fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/events')) {
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              this.streams.push(controller);
              signal?.addEventListener('abort', () => {
                try {
                  controller.error(new DOMException('aborted', 'AbortError'));
                } catch {
                  // Stream may already be closed by the test.
                }
              });
            }
          }),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          }
        );
      }
      if (url.endsWith('/api/commands')) {
        this.commands.push(JSON.parse(String(init?.body)));
        const result = this.commandResults.shift();
        return result
          ? result()
          : new Response(
              JSON.stringify({ accepted: true }),
              { status: 202, headers: { 'content-type': 'application/json' } }
            );
      }
      throw new Error(`unexpected fetch ${url}`);
    }
  );

  push(value: string, index = this.streams.length - 1): void {
    this.streams[index]!.enqueue(this.encoder.encode(value));
  }
}

describe('CloudClient SSE transport', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses SSE frames split across chunks and ignores duplicate seq', async () => {
    const transport = new MockTransport();
    vi.stubGlobal('fetch', transport.fetch);
    const client = new CloudClient('http://localhost:8787', 'secret');
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    client.connect();
    await vi.waitFor(() => expect(transport.streams).toHaveLength(1));

    const envelope = JSON.stringify({
      protocolVersion: 1,
      workspaceId: 'w1',
      sessionId: 's1',
      seq: 3,
      timestamp: new Date().toISOString(),
      event: { type: 'request.accepted', requestId: 'r1' }
    });
    transport.push(`data: ${envelope}\n`);
    transport.push('\n');
    transport.push(`data: ${envelope}\n\n`);

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(localStorage.getItem('kross.seq.w1.s1')).toBe('3');
    client.close();
  });

  it('serializes command POSTs', async () => {
    const transport = new MockTransport();
    vi.stubGlobal('fetch', transport.fetch);
    const first = deferred<Response>();
    const second = deferred<Response>();
    transport.commandResults.push(() => first.promise, () => second.promise);
    const client = new CloudClient('http://localhost:8787', 'secret');
    client.connect();
    await vi.waitFor(() => expect(transport.streams).toHaveLength(1));

    client.send({ type: 'workspace.list' });
    client.send({ type: 'workspace.list' });
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    first.resolve(new Response('{}', { status: 202 }));
    await vi.waitFor(() => expect(transport.commands).toHaveLength(2));
    second.resolve(new Response('{}', { status: 202 }));
    client.close();
  });

  it('keeps failed commands at the queue head after reconnect', async () => {
    const transport = new MockTransport();
    vi.stubGlobal('fetch', transport.fetch);
    transport.commandResults.push(
      async () => { throw new TypeError('network down'); }
    );
    const client = new CloudClient('http://localhost:8787', 'secret', {
      reconnectBaseMs: 1,
      heartbeatTimeoutMs: 5_000
    });
    client.connect();
    await vi.waitFor(() => expect(transport.streams).toHaveLength(1));
    const firstId = client.send({ type: 'workspace.list' });
    const secondId = client.send({ type: 'workspace.list' });

    await vi.waitFor(() => expect(transport.streams.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(transport.commands).toHaveLength(3));
    expect(transport.commands.map((command) => command.requestId)).toEqual([
      firstId,
      firstId,
      secondId
    ]);
    client.close();
  });

  it('reconnects when no frame arrives before the heartbeat timeout', async () => {
    const transport = new MockTransport();
    vi.stubGlobal('fetch', transport.fetch);
    const states: ConnectionState[] = [];
    const client = new CloudClient('http://localhost:8787', 'secret', {
      reconnectBaseMs: 1,
      heartbeatTimeoutMs: 15
    });
    client.onState((state) => states.push(state));
    client.connect();

    await vi.waitFor(
      () => expect(transport.streams.length).toBeGreaterThan(1),
      { timeout: 500 }
    );
    expect(states).toContain('offline');
    client.close();
  });

  it('migrates legacy WebSocket endpoints to HTTP base URLs', () => {
    expect(httpEndpoint('wss://agent.example/ws')).toBe(
      'https://agent.example'
    );
    expect(httpEndpoint('ws://localhost:8787/ws/')).toBe(
      'http://localhost:8787'
    );
  });
});

describe('readEventStream', () => {
  it('treats comments as frames even without data', async () => {
    const encoder = new TextEncoder();
    const frames: Array<{ data?: string }> = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': ping\n\ndata: {'));
        controller.enqueue(encoder.encode('"ok":true}\n\n'));
        controller.close();
      }
    });
    await readEventStream(stream, (frame) => frames.push(frame));
    expect(frames).toEqual([{}, { data: '{"ok":true}' }]);
  });
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
