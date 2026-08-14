import { describe, expect, it } from 'vitest';
import { WsAgentControlTransport } from './transport';

describe('WsAgentControlTransport', () => {
  it('registers over websocket with the agent token', async () => {
    const sockets: FakeSocket[] = [];
    const transport = new WsAgentControlTransport({
      agentId: 'agent1',
      agentToken: 'short-token',
      controlPlaneUrl: 'https://control.example.test',
      webSocket: fakeWebSocket(sockets) as unknown as typeof WebSocket
    });
    const registered = transport.register();
    await Promise.resolve();
    expect(sockets[0]?.url).toContain('/internal/v2/agents/ws');
    expect(sockets[0]?.url).toContain('token=short-token');
    expect(sockets[0]?.url.startsWith('wss://')).toBe(true);
    sockets[0]?.open();
    sockets[0]?.emit({
      type: 'agent.registered',
      heartbeatIntervalMs: 10_000,
      idleMs: 900_000,
      agentId: 'agent1'
    });
    await expect(registered).resolves.toEqual({ heartbeatIntervalMs: 10_000, idleMs: 900_000 });
  });

  it('waits for a pushed job instead of polling', async () => {
    const sockets: FakeSocket[] = [];
    const transport = new WsAgentControlTransport({
      agentId: 'agent1',
      agentToken: 'short-token',
      controlPlaneUrl: 'http://control.example.test',
      webSocket: fakeWebSocket(sockets) as unknown as typeof WebSocket
    });
    const registered = transport.register();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.emit({ type: 'agent.registered', heartbeatIntervalMs: 10_000, idleMs: 900_000 });
    await registered;
    const claimed = transport.claimJob();
    sockets[0]?.emit({
      type: 'agent.job',
      id: 'user-1',
      conversationId: 'conv-1',
      agentMessageId: 'agent-1',
      content: 'hello',
      history: []
    });
    await expect(claimed).resolves.toMatchObject({
      id: 'user-1',
      agentMessageId: 'agent-1',
      content: 'hello'
    });
  });

  it('delivers a pushed approval decision to the pending run', async () => {
    const sockets: FakeSocket[] = [];
    const transport = new WsAgentControlTransport({
      agentId: 'agent1',
      agentToken: 'short-token',
      controlPlaneUrl: 'http://control.example.test',
      webSocket: fakeWebSocket(sockets) as unknown as typeof WebSocket
    });
    const registered = transport.register();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.emit({ type: 'agent.registered', heartbeatIntervalMs: 10_000, idleMs: 900_000 });
    await registered;

    const decision = transport.waitForApproval('run-1');
    sockets[0]?.emit({ type: 'agent.approval', approvalId: 'run-1', approved: true });

    await expect(decision).resolves.toEqual({ approved: true });
  });

  it('rejects a missing agent token', () => {
    expect(() => new WsAgentControlTransport({
      agentId: 'agent1',
      agentToken: '  ',
      controlPlaneUrl: 'https://control.example.test'
    })).toThrow('Agent token is required');
  });
});

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.emitEvent('close');
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emitEvent('open');
  }

  emit(payload: unknown): void {
    this.emitEvent('message', { data: JSON.stringify(payload) });
  }

  private emitEvent(type: string, event: { data?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fakeWebSocket(sockets: FakeSocket[]): typeof FakeSocket {
  return class extends FakeSocket {
    static override readonly CONNECTING = 0;
    static override readonly OPEN = 1;
    static override readonly CLOSING = 2;
    static override readonly CLOSED = 3;

    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  };
}
