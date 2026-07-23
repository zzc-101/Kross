import {
  eventEnvelopeSchema,
  type ClientCommand,
  type EventEnvelope
} from '@kross/protocol';
import WebSocket from 'ws';

export class WorkerClient {
  private socket?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private readonly listeners = new Set<(event: EventEnvelope) => void>();

  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(command: ClientCommand): Promise<void> {
    const socket = await this.connectWithRetry();
    socket.send(JSON.stringify(command));
  }

  close(): void {
    this.socket?.close(1000, 'gateway disconnect');
    this.socket = undefined;
  }

  private connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.socket);
    }
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        headers: { authorization: `Bearer ${this.token}` }
      });
      const clear = () => {
        this.connecting = undefined;
      };
      socket.once('open', () => {
        clear();
        this.socket = socket;
        resolve(socket);
      });
      socket.once('error', (error) => {
        clear();
        reject(error);
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
        for (const listener of this.listeners) listener(parsed.data);
      });
      socket.once('close', () => {
        if (this.socket === socket) this.socket = undefined;
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
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(2_000, baseDelayMs * 2 ** attempt))
          );
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('worker 连接失败');
  }
}
