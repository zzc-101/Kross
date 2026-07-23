import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  PROTOCOL_VERSION,
  eventEnvelopeSchema,
  type EventEnvelope,
  type ServerEvent
} from '@kross/protocol';

interface CompletedRequest {
  requestId: string;
  completedAt: string;
  events: EventEnvelope[];
}

export class EventJournal {
  private readonly lastSequences = new Map<string, number>();
  private readonly sequenceLimits = new Map<string, number>();
  private readonly requestIndexes = new Map<string, CompletedRequest[]>();

  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  append(
    workspaceId: string,
    sessionId: string | undefined,
    event: ServerEvent,
    correlationId?: string
  ): EventEnvelope {
    const key = `${workspaceId}:${sessionId ?? '$workspace'}`;
    const current = this.lastSeq(workspaceId, sessionId);
    const limit = this.sequenceLimits.get(key) ?? current;
    if (current + 1 > limit) {
      this.reserveSequenceRange(workspaceId, sessionId, current);
    }
    const seq = current + 1;
    const envelope = eventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      source: 'worker',
      workspaceId,
      sessionId,
      correlationId,
      seq,
      timestamp: this.now().toISOString(),
      event
    });
    this.lastSequences.set(key, seq);
    if (!shouldPersist(event)) return envelope;

    const path = this.pathFor(workspaceId, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    if (event.type === 'session.snapshot') {
      atomicWrite(path, `${JSON.stringify(envelope)}\n`);
    } else {
      appendFileSync(path, `${JSON.stringify(envelope)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
    }
    return envelope;
  }

  replay(
    workspaceId: string,
    sessionId: string | undefined,
    afterSeq = 0
  ): EventEnvelope[] {
    return this.read(workspaceId, sessionId)
      .filter((event) => event.seq > afterSeq);
  }

  findCompletedRequest(
    workspaceId: string,
    sessionId: string | undefined,
    requestId: string
  ): EventEnvelope[] | undefined {
    return this.requests(workspaceId, sessionId)
      .find((entry) => entry.requestId === requestId)
      ?.events;
  }

  completeRequest(
    workspaceId: string,
    sessionId: string | undefined,
    requestId: string,
    events: EventEnvelope[]
  ): void {
    if (events.length === 0) return;
    const path = this.requestPathFor(workspaceId, sessionId);
    const entries = this.requests(workspaceId, sessionId)
      .filter((entry) => entry.requestId !== requestId);
    entries.push({
      requestId,
      completedAt: this.now().toISOString(),
      events
    });
    const retained = entries.slice(-500);
    this.requestIndexes.set(path, retained);
    mkdirSync(dirname(path), { recursive: true });
    atomicWrite(path, `${JSON.stringify(retained)}\n`);
  }

  deleteSession(workspaceId: string, sessionId: string): void {
    const eventPath = this.pathFor(workspaceId, sessionId);
    const requestPath = this.requestPathFor(workspaceId, sessionId);
    rmSync(eventPath, { force: true });
    rmSync(requestPath, { force: true });
    this.lastSequences.delete(`${workspaceId}:${sessionId}`);
    this.sequenceLimits.delete(`${workspaceId}:${sessionId}`);
    rmSync(this.sequencePathFor(workspaceId, sessionId), { force: true });
    this.requestIndexes.delete(requestPath);
  }

  lastSeq(workspaceId: string, sessionId: string | undefined): number {
    const key = `${workspaceId}:${sessionId ?? '$workspace'}`;
    const cached = this.lastSequences.get(key);
    if (cached !== undefined) return cached;
    const persisted = this.read(workspaceId, sessionId).at(-1)?.seq ?? 0;
    const sequencePath = this.sequencePathFor(workspaceId, sessionId);
    let reserved = 0;
    if (existsSync(sequencePath)) {
      const value = Number(readFileSync(sequencePath, 'utf8').trim());
      if (Number.isSafeInteger(value) && value > 0) reserved = value;
    }
    const baseline = Math.max(persisted, reserved);
    this.lastSequences.set(key, baseline);
    this.reserveSequenceRange(workspaceId, sessionId, baseline);
    return baseline;
  }

  private reserveSequenceRange(
    workspaceId: string,
    sessionId: string | undefined,
    after: number
  ): void {
    const key = `${workspaceId}:${sessionId ?? '$workspace'}`;
    const limit = after + 10_000;
    const path = this.sequencePathFor(workspaceId, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    atomicWrite(path, `${limit}\n`);
    this.sequenceLimits.set(key, limit);
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

  private requests(
    workspaceId: string,
    sessionId: string | undefined
  ): CompletedRequest[] {
    const path = this.requestPathFor(workspaceId, sessionId);
    const cached = this.requestIndexes.get(path);
    if (cached) return cached;
    let entries: CompletedRequest[] = [];
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (Array.isArray(raw)) {
          entries = raw.flatMap((candidate) => {
            if (
              !candidate ||
              typeof candidate !== 'object' ||
              typeof (candidate as CompletedRequest).requestId !== 'string' ||
              !Array.isArray((candidate as CompletedRequest).events)
            ) {
              return [];
            }
            const events = (candidate as CompletedRequest).events.flatMap(
              (event) => {
                const parsed = eventEnvelopeSchema.safeParse(event);
                return parsed.success ? [parsed.data] : [];
              }
            );
            return [{
              requestId: (candidate as CompletedRequest).requestId,
              completedAt:
                typeof (candidate as CompletedRequest).completedAt === 'string'
                  ? (candidate as CompletedRequest).completedAt
                  : this.now().toISOString(),
              events
            }];
          });
        }
      } catch {
        // 索引损坏时允许命令重新执行，不能阻塞工作区恢复。
      }
    }
    this.requestIndexes.set(path, entries);
    return entries;
  }

  private pathFor(workspaceId: string, sessionId: string | undefined): string {
    return join(
      this.root,
      encodeURIComponent(workspaceId),
      `${encodeURIComponent(sessionId ?? '$workspace')}.jsonl`
    );
  }

  private requestPathFor(
    workspaceId: string,
    sessionId: string | undefined
  ): string {
    return join(
      this.root,
      encodeURIComponent(workspaceId),
      'requests',
      `${encodeURIComponent(sessionId ?? '$workspace')}.json`
    );
  }

  private sequencePathFor(
    workspaceId: string,
    sessionId: string | undefined
  ): string {
    return join(
      this.root,
      encodeURIComponent(workspaceId),
      'sequences',
      `${encodeURIComponent(sessionId ?? '$workspace')}.seq`
    );
  }
}

function shouldPersist(event: ServerEvent): boolean {
  return (
    event.type === 'approval.pending' ||
    event.type === 'session.snapshot' ||
    event.type === 'session.updated' ||
    event.type === 'git.result'
  );
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}
