import {
  PROTOCOL_VERSION,
  eventEnvelopeSchema,
  type ClientCommand,
  type EventEnvelope
} from '@kross/protocol';

export type ConnectionState =
  | 'connecting'
  | 'online'
  | 'offline'
  | 'outdated';

type OutgoingCommand = ClientCommand extends infer Command
  ? Command extends ClientCommand
    ? Omit<Command, 'protocolVersion' | 'requestId'>
    : never
  : never;

interface QueuedCommand {
  command: OutgoingCommand;
  requestId: string;
}

export interface CloudClientOptions {
  heartbeatTimeoutMs?: number;
  reconnectBaseMs?: number;
  onProtocolMismatch?: () => void;
}

export class CloudClient {
  private streamAbort?: AbortController;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private streamGeneration = 0;
  private closed = false;
  private draining = false;
  private state: ConnectionState = 'offline';
  private readonly queuedCommands: QueuedCommand[] = [];
  private readonly handledSeq = new Map<string, number>();
  private readonly eventListeners = new Set<(event: EventEnvelope) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private activeSession?: { workspaceId: string; sessionId: string };

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly options: CloudClientOptions = {}
  ) {}

  connect(): void {
    if (!this.closed && (this.streamAbort || this.reconnectTimer)) return;
    this.closed = false;
    this.openStream();
  }

  close(): void {
    this.closed = true;
    this.streamGeneration += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    this.queuedCommands.length = 0;
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
    if (command.type === 'workspace.create' && this.state !== 'online') {
      throw new Error('当前离线，恢复连接后再创建工作区');
    }
    if (this.queuedCommands.length >= 100) {
      throw new Error('等待发送的操作过多，请恢复连接后重试');
    }
    const requestId = crypto.randomUUID();
    this.queuedCommands.push({ command, requestId });
    if (this.state === 'online') void this.drainCommands();
    return requestId;
  }

  private openStream(): void {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const generation = ++this.streamGeneration;
    const controller = new AbortController();
    this.streamAbort = controller;
    this.emitState('connecting');
    void this.consumeEventStream(controller.signal, generation);
  }

  private async consumeEventStream(
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    try {
      const response = await fetch(`${httpEndpoint(this.endpoint)}/api/events`, {
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${this.token}`
        },
        cache: 'no-store',
        signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`事件流连接失败（${response.status}）`);
      }
      if (this.closed || generation !== this.streamGeneration) return;
      this.reconnectAttempt = 0;
      this.emitState('online');
      this.touchHeartbeat(generation);
      if (this.activeSession) {
        const { workspaceId, sessionId } = this.activeSession;
        this.queuedCommands.unshift({
          requestId: crypto.randomUUID(),
          command: {
            type: 'session.resume',
            workspaceId,
            sessionId,
            lastSeq: readLastSeq(workspaceId, sessionId)
          }
        });
      }
      void this.drainCommands();

      let invalidEnvelopes = 0;
      await readEventStream(response.body, (frame) => {
        this.touchHeartbeat(generation);
        if (!frame.data) return;
        let raw: unknown;
        try {
          raw = JSON.parse(frame.data);
        } catch {
          invalidEnvelopes += 1;
          this.checkProtocolMismatch(invalidEnvelopes);
          return;
        }
        const parsed = eventEnvelopeSchema.safeParse(raw);
        if (!parsed.success) {
          invalidEnvelopes += 1;
          this.checkProtocolMismatch(invalidEnvelopes);
          return;
        }
        invalidEnvelopes = 0;
        this.receiveEvent(parsed.data);
      }, signal);
      if (!signal.aborted) throw new Error('事件流已结束');
    } catch {
      // Abort 是主动关闭或心跳检测触发，统一由下面的重连逻辑处理。
    } finally {
      if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      if (generation !== this.streamGeneration) return;
      this.streamAbort = undefined;
      if (!this.closed && this.state !== 'outdated') this.reconnect();
    }
  }

  private async drainCommands(): Promise<void> {
    if (this.draining || this.state !== 'online') return;
    this.draining = true;
    try {
      while (
        !this.closed &&
        this.state === 'online' &&
        this.queuedCommands.length > 0
      ) {
        const item = this.queuedCommands[0]!;
        let response: Response;
        try {
          response = await fetch(
            `${httpEndpoint(this.endpoint)}/api/commands`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${this.token}`,
                'content-type': 'application/json'
              },
              body: JSON.stringify({
                ...item.command,
                protocolVersion: PROTOCOL_VERSION,
                requestId: item.requestId
              })
            }
          );
        } catch {
          this.disconnectStream();
          return;
        }
        if (response.ok) {
          this.queuedCommands.shift();
          continue;
        }
        if (response.status >= 400 && response.status < 500) {
          this.queuedCommands.shift();
          this.emitLocalError(
            item.requestId,
            await responseError(response)
          );
          continue;
        }
        this.disconnectStream();
        return;
      }
    } finally {
      this.draining = false;
    }
  }

  private receiveEvent(envelope: EventEnvelope): void {
    if (
      envelope.sessionId &&
      envelope.source !== 'gateway' &&
      envelope.seq > 0
    ) {
      const key = sessionKey(envelope.workspaceId, envelope.sessionId);
      const previous = this.handledSeq.get(key) ?? 0;
      if (envelope.seq <= previous) return;
      this.handledSeq.set(key, envelope.seq);
      writeLastSeq(envelope.workspaceId, envelope.sessionId, envelope.seq);
    }
    for (const listener of this.eventListeners) listener(envelope);
  }

  private touchHeartbeat(generation: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (generation !== this.streamGeneration || this.closed) return;
      this.disconnectStream();
    }, this.options.heartbeatTimeoutMs ?? 60_000);
  }

  private disconnectStream(): void {
    if (this.state !== 'outdated') this.emitState('offline');
    this.streamAbort?.abort();
  }

  private reconnect(): void {
    if (this.closed) return;
    this.emitState('offline');
    const base = this.options.reconnectBaseMs ?? 600;
    const delay = Math.min(30_000, base * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openStream();
    }, delay);
  }

  private checkProtocolMismatch(count: number): void {
    if (count < 3 || this.state === 'outdated') return;
    this.emitState('outdated');
    this.options.onProtocolMismatch?.();
    this.streamAbort?.abort();
  }

  private emitLocalError(requestId: string, message: string): void {
    this.receiveEvent({
      protocolVersion: PROTOCOL_VERSION,
      source: 'gateway',
      workspaceId: '$gateway',
      correlationId: requestId,
      seq: 0,
      timestamp: new Date().toISOString(),
      event: {
        type: 'request.error',
        requestId,
        code: 'COMMAND_REJECTED',
        message
      }
    });
  }

  private emitState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

interface SseFrame {
  data?: string;
}

export async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = rawFrame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        onFrame(data ? { data } : {});
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function httpEndpoint(endpoint: string): string {
  return endpoint
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/ws\/?$/, '')
    .replace(/\/$/, '');
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error ?? `命令被拒绝（${response.status}）`;
  } catch {
    return `命令被拒绝（${response.status}）`;
  }
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
