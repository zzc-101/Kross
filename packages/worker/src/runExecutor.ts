import { join } from 'node:path';

import {
  PROTOCOL_VERSION,
  runSpecSchema,
  workerRunEventEnvelopeSchema,
  type InternalRunEvent,
  type RunSpec
} from '@kross/protocol';
import {
  FileCheckpointStore,
  WorkRunEvidence,
  createWorkExecutionProfile,
  materializeExecutionWorkspace,
  type SourceDownloadAdapter
} from '@kross/work-runtime';

import type { WorkAgentRuntime, WorkRuntimeFactory } from './coreRuntimeFactory';
import { RunEventJournal } from './eventJournal';
import type { WorkerControlCommand, WorkerControlTransport, WorkerLeaseIdentity } from './transport';

export interface RunExecutorOptions {
  lease: WorkerLeaseIdentity;
  runToken: string;
  physicalWorkRoot: string;
  transport: WorkerControlTransport;
  downloader: SourceDownloadAdapter;
  runtimeFactory: WorkRuntimeFactory;
  now?: () => Date;
}

export interface RunExecutionOutcome {
  status: 'completed' | 'cancelled' | 'failed' | 'waiting_for_approval';
  summary: string;
  lastSequence: number;
}

export class RunExecutor {
  private readonly now: () => Date;

  constructor(private readonly options: RunExecutorOptions) {
    if (!options.runToken.trim()) throw new Error('A run-scoped token is required');
    this.now = options.now ?? (() => new Date());
  }

  async execute(): Promise<RunExecutionOutcome> {
    const registered = await this.options.transport.register(this.options.lease, this.options.runToken);
    const runSpec = runSpecSchema.parse(registered.runSpec);
    this.assertLease(runSpec);
    const workspace = await materializeExecutionWorkspace({
      runSpec,
      physicalRoot: this.options.physicalWorkRoot,
      downloader: this.options.downloader
    });
    const journal = await RunEventJournal.open({
      path: join(workspace.checkpointDirectory, 'event-outbox.json'),
      runId: runSpec.runId,
      generation: runSpec.generation
    });
    const emitter = new EventEmitter({
      runSpec,
      journal,
      transport: this.options.transport,
      workerSessionId: registered.workerSessionId,
      lease: this.options.lease,
      runToken: this.options.runToken,
      now: this.now
    });
    await emitter.flush();
    const evidence = new WorkRunEvidence();
    const handle = await this.options.runtimeFactory.create({
      runSpec,
      workspaceRoot: workspace.root,
      executionProfile: createWorkExecutionProfile({ runSpec, evidence })
    });
    const checkpointStore = new FileCheckpointStore(workspace.checkpointDirectory);
    const abortController = new AbortController();
    let leaseLost: Error | undefined;
    const unsubscribe = this.options.transport.subscribe?.((command) => {
      if (sameGeneration(command, runSpec) && command.type === 'cancel') {
        abortController.abort(new Error(command.reason));
      }
    });
    const heartbeat = setInterval(() => {
      void this.options.transport.heartbeat({
        workerSessionId: registered.workerSessionId,
        lease: this.options.lease,
        runToken: this.options.runToken,
        lastEmittedSeq: emitter.lastSequence
      }).then((renewal) => {
        if (renewal.generation !== runSpec.generation || renewal.leaseId !== runSpec.leaseId || Date.parse(renewal.leaseExpiresAt) <= this.now().getTime()) {
          leaseLost = new Error('Worker lease was lost');
          abortController.abort(leaseLost);
        }
      }).catch((error: unknown) => {
        leaseLost = error instanceof Error ? error : new Error(String(error));
        abortController.abort(leaseLost);
      });
    }, registered.heartbeatIntervalMs);

    try {
      await this.restoreCheckpoint(runSpec, checkpointStore, handle.runtime);
      await emitter.emit({ type: 'run.started', startedAt: this.now().toISOString() });
      const outcome = await this.runAgent({ runSpec, runtime: handle.runtime, evidence, emitter, checkpointStore, signal: abortController.signal });
      await this.options.transport.release({
        workerSessionId: registered.workerSessionId,
        lease: this.options.lease,
        runToken: this.options.runToken,
        reason: outcome.status === 'waiting_for_approval' ? 'shutdown' : 'terminal'
      });
      return outcome;
    } catch (error) {
      if (leaseLost) throw leaseLost;
      const summary = error instanceof Error ? error.message : String(error);
      const cancelled = abortController.signal.aborted;
      await emitter.emit({
        type: 'run.terminal',
        terminal: cancelled
          ? { status: 'cancelled', summary, finishedAt: this.now().toISOString() }
          : {
              status: 'failed',
              summary,
              failure: { code: 'WORKER_EXECUTION_FAILED', summary, retryable: true },
              finishedAt: this.now().toISOString()
            }
      });
      await this.options.transport.release({
        workerSessionId: registered.workerSessionId,
        lease: this.options.lease,
        runToken: this.options.runToken,
        reason: 'error'
      });
      return { status: cancelled ? 'cancelled' : 'failed', summary, lastSequence: emitter.lastSequence };
    } finally {
      clearInterval(heartbeat);
      unsubscribe?.();
      await handle.close();
    }
  }

  private async runAgent(input: {
    runSpec: RunSpec;
    runtime: WorkAgentRuntime;
    evidence: WorkRunEvidence;
    emitter: EventEmitter;
    checkpointStore: FileCheckpointStore;
    signal: AbortSignal;
  }): Promise<RunExecutionOutcome> {
    let fullText = '';
    let pendingDelta = '';
    let finalResult: Awaited<ReturnType<WorkAgentRuntime['resolveToolApproval']>> | undefined;
    for await (const event of input.runtime.runStreaming({
      input: buildRunPrompt(input.runSpec),
      requestedMode: input.runSpec.mode,
      signal: input.signal
    })) {
      if (event.type === 'text-delta') {
        fullText += event.text;
        pendingDelta += event.text;
        if (/\S/.test(pendingDelta)) {
          for (const delta of splitText(pendingDelta, 16_000)) {
            await input.emitter.emit({
              type: 'run.message_delta',
              messageId: finalMessageId(input.runSpec.runId),
              index: input.emitter.nextMessageDeltaIndex(),
              delta
            });
          }
          pendingDelta = '';
        }
      } else if (event.type === 'result') {
        finalResult = event.result;
      }
    }
    if (!finalResult) throw new Error('Core runtime finished without a result');
    if (finalResult.status === 'approval-required') {
      const saved = await input.checkpointStore.save({
        version: 1,
        runId: input.runSpec.runId,
        generation: input.runSpec.generation,
        contextState: input.runtime.exportContextState(),
        workState: input.runtime.exportWorkState(),
        savedAt: this.now().toISOString()
      });
      await input.emitter.emit({
        type: 'run.checkpoint_updated',
        checkpointKey: saved.key,
        sha256: saved.sha256,
        sizeBytes: saved.sizeBytes,
        completedThroughSeq: Math.max(1, input.emitter.lastSequence)
      });
      return { status: 'waiting_for_approval', summary: finalResult.summary, lastSequence: input.emitter.lastSequence };
    }
    const summary = finalResult.summary || fullText;
    if (finalResult.status === 'completed') {
      input.evidence.recordResponse(summary);
      await input.emitter.emit({
        type: 'run.message_final',
        message: {
          id: finalMessageId(input.runSpec.runId),
          organizationId: input.runSpec.organizationId,
          projectId: input.runSpec.projectId,
          taskId: input.runSpec.taskId,
          role: 'agent',
          content: [{ type: 'text', text: summary }],
          createdAt: this.now().toISOString()
        }
      });
    }
    const status = finalResult.status === 'cancelled' ? 'cancelled' : finalResult.status === 'completed' ? 'completed' : 'failed';
    await input.emitter.emit({
      type: 'run.terminal',
      terminal:
        status === 'failed'
          ? {
              status,
              summary,
              failure: { code: 'AGENT_RUN_FAILED', summary, retryable: false },
              finishedAt: this.now().toISOString()
            }
          : { status, summary, finishedAt: this.now().toISOString() }
    });
    return { status, summary, lastSequence: input.emitter.lastSequence };
  }

  private async restoreCheckpoint(runSpec: RunSpec, store: FileCheckpointStore, runtime: WorkAgentRuntime): Promise<void> {
    if (!runSpec.resumeCheckpointKey) return;
    const checkpoint = await store.load(runSpec.resumeCheckpointKey);
    if (!checkpoint) throw new Error('Resume checkpoint was not found');
    if (checkpoint.runId !== runSpec.runId || checkpoint.generation > runSpec.generation) throw new Error('Resume checkpoint does not belong to this run generation');
    if (!runtime.restoreContextState(checkpoint.contextState as never) || !runtime.restoreWorkState(checkpoint.workState as never)) {
      throw new Error('Core checkpoint restore failed closed');
    }
  }

  private assertLease(runSpec: RunSpec): void {
    if (runSpec.protocolVersion !== PROTOCOL_VERSION || runSpec.runId !== this.options.lease.runId || runSpec.generation !== this.options.lease.generation || runSpec.leaseId !== this.options.lease.leaseId) {
      throw new Error('RunSpec does not match the claimed run lease generation');
    }
    if (Date.parse(runSpec.leaseExpiresAt) <= this.now().getTime()) throw new Error('Run lease has expired');
  }
}

class EventEmitter {
  private messageDeltaIndex = 0;
  constructor(private readonly options: {
    runSpec: RunSpec;
    journal: RunEventJournal;
    transport: WorkerControlTransport;
    workerSessionId: string;
    lease: WorkerLeaseIdentity;
    runToken: string;
    now: () => Date;
  }) {}
  get lastSequence(): number { return this.options.journal.lastSequence }
  nextMessageDeltaIndex(): number { return ++this.messageDeltaIndex }
  async emit(event: InternalRunEvent): Promise<void> {
    const envelope = workerRunEventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      runId: this.options.runSpec.runId,
      generation: this.options.runSpec.generation,
      seq: this.options.journal.lastSequence + 1,
      timestamp: this.options.now().toISOString(),
      event
    });
    await this.options.journal.append(envelope);
    await this.flush();
  }
  async flush(): Promise<void> {
    for (const envelope of this.options.journal.pending()) {
      const ack = await this.options.transport.sendEvent({
        workerSessionId: this.options.workerSessionId,
        lease: this.options.lease,
        runToken: this.options.runToken,
        envelope
      });
      await this.options.journal.acknowledge(ack.acceptedThroughSeq);
    }
  }
}

function sameGeneration(command: WorkerControlCommand, runSpec: RunSpec): boolean {
  return command.runId === runSpec.runId && command.generation === runSpec.generation;
}
function finalMessageId(runId: string): string { return `${runId}_final` }
function buildRunPrompt(runSpec: RunSpec): string {
  return [runSpec.task.objective, runSpec.task.messages.map((message) => `${message.role}: ${message.text}`).join('\n')].filter(Boolean).join('\n\n');
}
function splitText(value: string, maxChars: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += maxChars) {
    const part = value.slice(index, index + maxChars);
    if (/\S/.test(part)) parts.push(part);
  }
  return parts;
}
