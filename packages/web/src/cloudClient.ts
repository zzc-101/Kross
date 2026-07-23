import {
  PROTOCOL_VERSION,
  eventEnvelopeSchema,
  type ClientCommand,
  type EventEnvelope
} from '@kross/protocol';

export type ConnectionState = 'connecting' | 'online' | 'offline';
type OutgoingCommand = ClientCommand extends infer Command
  ? Command extends ClientCommand
    ? Omit<Command, 'protocolVersion' | 'requestId'>
    : never
  : never;

export class CloudClient {
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private closed = false;
  private readonly eventListeners = new Set<(event: EventEnvelope) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private activeSession?: { workspaceId: string; sessionId: string };

  constructor(
    private readonly endpoint: string,
    private readonly token: string
  ) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'client logout');
  }

  onEvent(listener: (event: EventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  setActiveSession(workspaceId: string, sessionId: string): void {
    this.activeSession = { workspaceId, sessionId };
  }

  send(command: OutgoingCommand): string {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('连接尚未就绪');
    }
    const requestId = crypto.randomUUID();
    this.socket.send(
      JSON.stringify({ ...command, protocolVersion: PROTOCOL_VERSION, requestId })
    );
    return requestId;
  }

  private open(): void {
    this.emitState('connecting');
    const protocols = ['kross.v1', `kross.token.${encodeToken(this.token)}`];
    const socket = new WebSocket(this.endpoint, protocols);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.emitState('online');
      this.send({ type: 'workspace.list' });
      if (this.activeSession) {
        const { workspaceId, sessionId } = this.activeSession;
        this.send({
          type: 'session.resume',
          workspaceId,
          sessionId,
          lastSeq: readLastSeq(workspaceId, sessionId)
        });
      }
    });
    socket.addEventListener('message', (message) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const parsed = eventEnvelopeSchema.safeParse(raw);
      if (!parsed.success) return;
      if (parsed.data.sessionId && parsed.data.seq > 0) {
        writeLastSeq(
          parsed.data.workspaceId,
          parsed.data.sessionId,
          parsed.data.seq
        );
      }
      for (const listener of this.eventListeners) listener(parsed.data);
    });
    socket.addEventListener('close', () => this.reconnect());
    socket.addEventListener('error', () => socket.close());
  }

  private reconnect(): void {
    this.emitState('offline');
    if (this.closed) return;
    const delay = Math.min(30_000, 600 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private emitState(state: ConnectionState): void {
    for (const listener of this.stateListeners) listener(state);
  }
}

function encodeToken(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function seqKey(workspaceId: string, sessionId: string): string {
  return `kross.seq.${workspaceId}.${sessionId}`;
}

function readLastSeq(workspaceId: string, sessionId: string): number {
  return Number(localStorage.getItem(seqKey(workspaceId, sessionId)) ?? 0);
}

function writeLastSeq(
  workspaceId: string,
  sessionId: string,
  seq: number
): void {
  localStorage.setItem(seqKey(workspaceId, sessionId), String(seq));
}
