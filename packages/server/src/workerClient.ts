import { randomUUID } from 'node:crypto';

import {
  PROTOCOL_VERSION,
  eventEnvelopeSchema,
  type ClientCommand,
  type EventEnvelope
} from '@kross/protocol';
import WebSocket from 'ws';

export interface WorkerClientOptions {
  heartbeatMs?: number;
  reconnectBaseMs?: number;
}

export class WorkerClient {
  private socket?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectAttempt = 0;
  private alive = true;
  private closed = false;
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private readonly sessionSequences = new Map<string, number>();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly workspaceId: string,
    private readonly options: WorkerClientOptions = {}
  ) {}

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.closed) this.closed = false;
    void this.connectWithRetry().catch(() => this.scheduleReconnect());
  }

  async send(command: ClientCommand): Promise<void> {
    if ('sessionId' in command && command.sessionId) {
      this.sessionSequences.set(
        command.sessionId,
        this.sessionSequences.get(command.sessionId) ?? 0
      );
    }
    const socket = await this.connectWithRetry();
    await sendSocket(socket, JSON.stringify(command));
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
    this.socket?.close(1000, 'gateway disconnect');
    this.socket = undefined;
  }

  private connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.socket);
    }
    if (this.connecting) return this.connecting;
    this.closed = false;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        headers: { authorization: `Bearer ${this.token}` }
      });
      const clearConnecting = () => {
        this.connecting = undefined;
      };
      socket.once('open', () => {
        clearConnecting();
        if (this.closed) {
          socket.close(1000, 'stale worker connection');
          reject(new Error('worker client 已关闭'));
          return;
        }
        this.socket = socket;
        this.reconnectAttempt = 0;
        this.startHeartbeat(socket);
        this.resumeKnownSessions(socket);
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearConnecting();
        reject(error);
      });
      socket.on('pong', () => {
        this.alive = true;
      });
      socket.on('message', (data) => {
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          return;
        }
        const parsed = eventEnvelopeSchema.safeParse(raw);
        if (!parsed.success) return;
        if (parsed.data.sessionId && parsed.data.seq > 0) {
          this.sessionSequences.set(parsed.data.sessionId, parsed.data.seq);
        }
        for (const listener of this.listeners) listener(parsed.data);
      });
      socket.once('close', () => {
        clearConnecting();
        if (this.socket === socket) this.socket = undefined;
        this.stopHeartbeat();
        if (!this.closed) this.scheduleReconnect();
      });
    });
    return this.connecting;
  }

  private async connectWithRetry(
    attempts = 8,
    baseDelayMs = 150
  ): Promise<WebSocket> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.connect();
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) {
          await delay(Math.min(2_000, baseDelayMs * 2 ** attempt));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('worker 连接失败');
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const base = this.options.reconnectBaseMs ?? 300;
    const waitMs = Math.min(30_000, base * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => this.scheduleReconnect());
    }, waitMs);
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.alive = true;
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!this.alive) {
        socket.terminate();
        return;
      }
      this.alive = false;
      socket.ping();
    }, this.options.heartbeatMs ?? 20_000);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private resumeKnownSessions(socket: WebSocket): void {
    for (const [sessionId, lastSeq] of this.sessionSequences) {
      socket.send(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: `reconnect-${randomUUID()}`,
        type: 'session.resume',
        workspaceId: this.workspaceId,
        sessionId,
        lastSeq
      } satisfies ClientCommand));
    }
  }
}

function sendSocket(socket: WebSocket, data: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.send(data, (error) => (error ? reject(error) : resolve()));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
