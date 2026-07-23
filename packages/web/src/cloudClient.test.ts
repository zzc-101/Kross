import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudClient } from './cloudClient';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', {});
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', {});
  }

  message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('CloudClient', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queues offline commands and keeps their request id after reconnect', () => {
    const client = new CloudClient('ws://localhost/ws', 'secret');
    client.connect();
    const requestId = client.send({ type: 'workspace.list' });
    const socket = MockWebSocket.instances[0]!;

    expect(socket.sent).toEqual([]);
    socket.open();

    const commands = socket.sent.map((value) => JSON.parse(value));
    expect(commands).toHaveLength(2);
    expect(commands[0].type).toBe('workspace.list');
    expect(commands[1]).toMatchObject({
      type: 'workspace.list',
      requestId
    });
  });

  it('resumes the active session before flushing queued work', () => {
    localStorage.setItem('kross.seq.w1.s1', '7');
    const client = new CloudClient('ws://localhost/ws', 'secret');
    client.setActiveSession('w1', 's1');
    client.connect();
    client.send({
      type: 'session.input',
      workspaceId: 'w1',
      sessionId: 's1',
      input: '继续',
      mode: 'auto'
    });

    const socket = MockWebSocket.instances[0]!;
    socket.open();
    const commands = socket.sent.map((value) => JSON.parse(value));

    expect(commands.map((command) => command.type)).toEqual([
      'workspace.list',
      'session.resume',
      'session.input'
    ]);
    expect(commands[1].lastSeq).toBe(7);
  });

  it('ignores duplicate replay events for a session', () => {
    const client = new CloudClient('ws://localhost/ws', 'secret');
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    const envelope = {
      protocolVersion: 1,
      workspaceId: 'w1',
      sessionId: 's1',
      seq: 3,
      timestamp: new Date().toISOString(),
      event: { type: 'request.accepted', requestId: 'r1' }
    };

    socket.message(envelope);
    socket.message(envelope);

    expect(events).toHaveLength(1);
    expect(localStorage.getItem('kross.seq.w1.s1')).toBe('3');
  });

  it('does not reconnect a stale socket closed by StrictMode cleanup', () => {
    vi.useFakeTimers();
    const client = new CloudClient('ws://localhost/ws', 'secret');
    client.connect();
    const first = MockWebSocket.instances[0]!;
    client.close();
    client.connect();

    first.close();
    vi.runAllTimers();

    expect(MockWebSocket.instances).toHaveLength(2);
    vi.useRealTimers();
  });
});
