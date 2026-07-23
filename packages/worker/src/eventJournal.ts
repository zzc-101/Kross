import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  PROTOCOL_VERSION,
  eventEnvelopeSchema,
  type EventEnvelope,
  type ServerEvent
} from '@kross/protocol';

export class EventJournal {
  private readonly lastSequences = new Map<string, number>();

  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  append(
    workspaceId: string,
    sessionId: string | undefined,
    event: ServerEvent
  ): EventEnvelope {
    const key = sessionId ?? '$workspace';
    const seq = this.lastSeq(workspaceId, sessionId) + 1;
    const envelope = eventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      workspaceId,
      sessionId,
      seq,
      timestamp: this.now().toISOString(),
      event
    });
    const path = this.pathFor(workspaceId, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(envelope)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    this.lastSequences.set(`${workspaceId}:${key}`, seq);
    return envelope;
  }

  replay(
    workspaceId: string,
    sessionId: string | undefined,
    afterSeq = 0
  ): EventEnvelope[] {
    const events = this.read(workspaceId, sessionId);
    return events.filter((event) => event.seq > afterSeq);
  }

  findAcceptedRequest(
    workspaceId: string,
    sessionId: string,
    requestId: string
  ): EventEnvelope | undefined {
    return this.read(workspaceId, sessionId).find(
      (envelope) =>
        envelope.event.type === 'request.accepted' &&
        envelope.event.requestId === requestId
    );
  }

  lastSeq(workspaceId: string, sessionId: string | undefined): number {
    const key = `${workspaceId}:${sessionId ?? '$workspace'}`;
    const cached = this.lastSequences.get(key);
    if (cached !== undefined) return cached;
    const events = this.read(workspaceId, sessionId);
    const last = events.at(-1)?.seq ?? 0;
    this.lastSequences.set(key, last);
    return last;
  }

  private read(
    workspaceId: string,
    sessionId: string | undefined
  ): EventEnvelope[] {
    const path = this.pathFor(workspaceId, sessionId);
    if (!existsSync(path)) return [];
    const events: EventEnvelope[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = eventEnvelopeSchema.safeParse(JSON.parse(line));
        if (parsed.success) events.push(parsed.data);
      } catch {
        // 崩溃可能留下半行；此前的完整事件仍可安全回放。
      }
    }
    return events;
  }

  private pathFor(workspaceId: string, sessionId: string | undefined): string {
    return join(
      this.root,
      encodeURIComponent(workspaceId),
      `${encodeURIComponent(sessionId ?? '$workspace')}.jsonl`
    );
  }
}
