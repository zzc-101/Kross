import {
  artifactCommittedMessageSchema,
  artifactReservedMessageSchema,
  leaseRenewedMessageSchema,
  internalWorkerMessageSchema,
  PROTOCOL_VERSION,
  workerEventAckMessageSchema,
  workerRegisteredMessageSchema,
  type ArtifactCommitMessage,
  type ArtifactReserveMessage,
  type ArtifactSnapshot,
  type RunSpec,
  type WorkerRunEventEnvelope
} from '@kross/protocol';

export interface WorkerLeaseIdentity {
  workerId: string;
  runId: string;
  generation: number;
  leaseId: string;
}

export interface RegisteredRun {
  workerSessionId: string;
  heartbeatIntervalMs: number;
  runSpec: RunSpec;
}

export type WorkerControlCommand =
  | { type: 'cancel'; runId: string; generation: number; reason: string }
  | { type: 'approval'; runId: string; generation: number; approvalId: string; approved: boolean; reason?: string };

/** Server adapter; every operation authenticates with the short-lived Run token. */
export interface WorkerControlTransport {
  register(input: WorkerLeaseIdentity, runToken: string): Promise<RegisteredRun>;
  sendEvent(input: {
    workerSessionId: string;
    lease: WorkerLeaseIdentity;
    runToken: string;
    envelope: WorkerRunEventEnvelope;
  }): Promise<{ acceptedThroughSeq: number }>;
  heartbeat(input: {
    workerSessionId: string;
    lease: WorkerLeaseIdentity;
    runToken: string;
    lastEmittedSeq: number;
  }): Promise<{ leaseExpiresAt: string; generation: number; leaseId: string }>;
  release(input: {
    workerSessionId: string;
    lease: WorkerLeaseIdentity;
    runToken: string;
    reason: 'terminal' | 'shutdown' | 'lost' | 'error';
  }): Promise<void>;
  reserveArtifact(input: {
    lease: WorkerLeaseIdentity;
    runToken: string;
    artifact: Omit<ArtifactReserveMessage, 'protocolVersion' | 'messageId' | 'sentAt' | 'type' | 'runId' | 'generation'>;
  }): Promise<ArtifactReservation>;
  uploadArtifact(input: { upload: ArtifactUploadInstruction; absolutePath: string; signal?: AbortSignal }): Promise<{ etag?: string }>;
  commitArtifact(input: {
    lease: WorkerLeaseIdentity;
    runToken: string;
    commit: Omit<ArtifactCommitMessage, 'protocolVersion' | 'messageId' | 'sentAt' | 'type' | 'runId' | 'generation'>;
  }): Promise<ArtifactSnapshot>;
  subscribe?(listener: (command: WorkerControlCommand) => void): () => void;
}

export interface ArtifactUploadInstruction {
  method: 'PUT' | 'POST';
  url: string;
  headers: Array<{ name: string; value: string }>;
  expiresAt: string;
}

export type ArtifactReservation =
  | { artifactId: string; alreadyCommitted: true }
  | { artifactId: string; alreadyCommitted: false; upload: ArtifactUploadInstruction };

export interface FetchWorkerControlTransportOptions {
  controlPlaneUrl: string;
  runSpecUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** HTTP adapter for the private Worker API. It never stores a long-lived credential. */
export class FetchWorkerControlTransport implements WorkerControlTransport {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: FetchWorkerControlTransportOptions) {
    const url = new URL(options.controlPlaneUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Control plane URL must use HTTP(S)');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async register(lease: WorkerLeaseIdentity, runToken: string): Promise<RegisteredRun> {
    const body = await this.request(this.options.runSpecUrl ?? '/internal/v2/workers/register', runToken, {
      type: 'worker.register',
      workerId: lease.workerId,
      runId: lease.runId,
      generation: lease.generation,
      leaseId: lease.leaseId,
      workerVersion: '0.1.0',
      capabilities: { checkpointResume: true, artifactUpload: true, connectorProxy: false }
    });
    const parsed = workerRegisteredMessageSchema.parse(body);
    return {
      workerSessionId: parsed.workerSessionId,
      heartbeatIntervalMs: parsed.heartbeatIntervalMs,
      runSpec: parsed.runSpec
    };
  }

  async sendEvent(input: {
    workerSessionId: string;
    lease: WorkerLeaseIdentity;
    runToken: string;
    envelope: WorkerRunEventEnvelope;
  }): Promise<{ acceptedThroughSeq: number }> {
    const body = await this.request('/internal/v2/workers/events', input.runToken, {
      type: 'worker.event',
      envelope: input.envelope
    });
    const parsed = workerEventAckMessageSchema.parse(body);
    return { acceptedThroughSeq: parsed.acceptedThroughSeq };
  }

  async heartbeat(input: {
    workerSessionId: string;
    lease: WorkerLeaseIdentity;
    runToken: string;
    lastEmittedSeq: number;
  }): Promise<{ leaseExpiresAt: string; generation: number; leaseId: string }> {
    const body = await this.request('/internal/v2/workers/heartbeat', input.runToken, {
      type: 'worker.heartbeat',
      workerSessionId: input.workerSessionId,
      runId: input.lease.runId,
      generation: input.lease.generation,
      leaseId: input.lease.leaseId,
      lastEmittedSeq: input.lastEmittedSeq,
      usage: { cpuMillis: 0, memoryBytes: 0, diskBytes: 0 }
    });
    const parsed = leaseRenewedMessageSchema.parse(body);
    return { leaseExpiresAt: parsed.leaseExpiresAt, generation: parsed.generation, leaseId: parsed.leaseId };
  }

  async release(input: {
    workerSessionId: string;
    lease: WorkerLeaseIdentity;
    runToken: string;
    reason: 'terminal' | 'shutdown' | 'lost' | 'error';
  }): Promise<void> {
    await this.request('/internal/v2/workers/release', input.runToken, {
      type: 'lease.release',
      workerSessionId: input.workerSessionId,
      runId: input.lease.runId,
      generation: input.lease.generation,
      leaseId: input.lease.leaseId,
      reason: input.reason
    }, true);
  }

  async reserveArtifact(input: {
    lease: WorkerLeaseIdentity;
    runToken: string;
    artifact: Omit<ArtifactReserveMessage, 'protocolVersion' | 'messageId' | 'sentAt' | 'type' | 'runId' | 'generation'>;
  }): Promise<ArtifactReservation> {
    const response = artifactReservedMessageSchema.parse(await this.request('/internal/v2/workers/artifacts/reserve', input.runToken, {
      type: 'artifact.reserve', runId: input.lease.runId, generation: input.lease.generation, ...input.artifact
    }));
    assertArtifactFence(response, input.lease);
    return response.alreadyCommitted
      ? { artifactId: response.artifactId, alreadyCommitted: true }
      : { artifactId: response.artifactId, alreadyCommitted: false, upload: response.upload };
  }

  async uploadArtifact(input: { upload: ArtifactUploadInstruction; absolutePath: string; signal?: AbortSignal }): Promise<{ etag?: string }> {
    if (Date.parse(input.upload.expiresAt) <= Date.now()) throw new Error('Artifact upload instruction has expired');
    const { createReadStream } = await import('node:fs');
    const body = createReadStream(input.absolutePath);
    const abort = () => body.destroy(input.signal?.reason instanceof Error ? input.signal.reason : new Error('Operation aborted'));
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetch(input.upload.url, {
        method: input.upload.method,
        headers: Object.fromEntries(input.upload.headers.map((header) => [header.name, header.value])),
        body,
        signal: input.signal,
        duplex: 'half'
      } as unknown as RequestInit);
      if (!response.ok) throw new Error(`Artifact upload failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
      return { etag: response.headers.get('etag')?.replace(/^"|"$/g, '') || undefined };
    } finally {
      input.signal?.removeEventListener('abort', abort);
      body.destroy();
    }
  }

  async commitArtifact(input: {
    lease: WorkerLeaseIdentity;
    runToken: string;
    commit: Omit<ArtifactCommitMessage, 'protocolVersion' | 'messageId' | 'sentAt' | 'type' | 'runId' | 'generation'>;
  }): Promise<ArtifactSnapshot> {
    const response = artifactCommittedMessageSchema.parse(await this.request('/internal/v2/workers/artifacts/commit', input.runToken, {
      type: 'artifact.commit', runId: input.lease.runId, generation: input.lease.generation, ...input.commit
    }));
    assertArtifactFence(response, input.lease);
    return { ...response.artifact, runId: response.runId };
  }

  private async request(path: string, token: string, body: Record<string, unknown>, allowEmpty = false): Promise<unknown> {
    if (!token.trim()) throw new Error('Run token is required');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Control plane request timed out')), this.timeoutMs);
    try {
      const response = await this.fetch(new URL(path, this.options.controlPlaneUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(internalWorkerMessageSchema.parse(withMessageMetadata(body))),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`Control plane ${path} failed (${response.status}): ${detail || response.statusText}`);
      }
      if (allowEmpty && response.status === 204) return undefined;
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Control plane ${path} timed out`, { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function assertArtifactFence(message: { runId: string; generation: number }, lease: WorkerLeaseIdentity): void {
  if (message.runId !== lease.runId || message.generation !== lease.generation) {
    throw new Error('Artifact response does not match the active run generation');
  }
}

function withMessageMetadata(body: Record<string, unknown>): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    sentAt: new Date().toISOString(),
    ...body
  };
}
