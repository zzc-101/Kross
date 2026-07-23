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
  private readonly queuedCommands: Array<{
    command: OutgoingCommand;
    requestId: string;
  }> = [];
  private readonly handledSeq = new Map<string, number>();
  private readonly eventListeners = new Set<(event: EventEnvelope) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private activeSession?: { workspaceId: string; sessionId: string };

  constructor(
    private readonly endpoint: string,
    private readonly token: string
  ) {}

  connect(): void {
    if (
      !this.closed &&
      (this.socket?.readyState === WebSocket.OPEN ||
        this.socket?.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.queuedCommands.length = 0;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, 'client logout');
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
    this.handledSeq.set(
      sessionKey(workspaceId, sessionId),
      readLastSeq(workspaceId, sessionId)
    );
  }

  clearActiveSession(): void {
    this.activeSession = undefined;
  }

  send(command: OutgoingCommand): string {
    const requestId = crypto.randomUUID();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendNow(command, requestId);
    } else {
      if (this.queuedCommands.length >= 100) {
        throw new Error('等待发送的操作过多，请恢复连接后重试');
      }
      this.queuedCommands.push({ command, requestId });
    }
    return requestId;
  }

  private open(): void {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.emitState('connecting');
    const protocols = ['kross.v1', `kross.token.${encodeToken(this.token)}`];
    const socket = new WebSocket(this.endpoint, protocols);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.closed) return;
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
      const queued = this.queuedCommands.splice(0);
      for (const item of queued) {
        this.sendNow(item.command, item.requestId);
      }
    });
    socket.addEventListener('message', (message) => {
      if (this.socket !== socket || this.closed) return;
      let raw: unknown;
      try {
        raw = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const parsed = eventEnvelopeSchema.safeParse(raw);
      if (!parsed.success) return;
      if (parsed.data.sessionId && parsed.data.seq > 0) {
        const key = sessionKey(
          parsed.data.workspaceId,
          parsed.data.sessionId
        );
        const previous = this.handledSeq.get(key) ?? 0;
        if (parsed.data.seq <= previous) return;
        this.handledSeq.set(key, parsed.data.seq);
        writeLastSeq(
          parsed.data.workspaceId,
          parsed.data.sessionId,
          parsed.data.seq
        );
      }
      for (const listener of this.eventListeners) listener(parsed.data);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.reconnect();
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) socket.close();
    });
  }

  private reconnect(): void {
    this.emitState('offline');
    if (this.closed) return;
    const delay = Math.min(30_000, 600 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private sendNow(command: OutgoingCommand, requestId: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.queuedCommands.unshift({ command, requestId });
      return;
    }
    this.socket.send(
      JSON.stringify({ ...command, protocolVersion: PROTOCOL_VERSION, requestId })
    );
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

function sessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
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
