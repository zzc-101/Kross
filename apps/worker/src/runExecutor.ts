import { createHash } from 'node:crypto';
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
import { publishOutputArtifacts } from './artifactPublisher';
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
      const checkpoint = await this.restoreCheckpoint(runSpec, checkpointStore, handle.runtime);
      await emitter.emit({ type: 'run.started', startedAt: this.now().toISOString() });
      const outcome = await this.runAgent({ runSpec, runtime: handle.runtime, evidence, emitter, checkpointStore, checkpoint, outputDirectory: workspace.outputDirectory, signal: abortController.signal });
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
    checkpoint?: import('@kross/work-runtime').WorkRuntimeCheckpoint;
    outputDirectory: string;
    signal: AbortSignal;
  }): Promise<RunExecutionOutcome> {
    let fullText = '';
    let pendingDelta = '';
    let finalResult: Awaited<ReturnType<WorkAgentRuntime['resolveToolApproval']>> | undefined;
    if (input.checkpoint?.pendingApproval) {
      const decision = await this.options.transport.getApprovalDecision({ lease: this.options.lease, runToken: this.options.runToken });
      if (!decision) throw new Error('Resumed approval checkpoint has no decision');
      if (decision.approvalId !== input.checkpoint.pendingApproval.approvalId || decision.requestHash !== input.checkpoint.pendingApproval.requestHash) {
        throw new Error('Approval decision digest does not match the checkpoint');
      }
      finalResult = await input.runtime.resolveToolApproval({
        runId: input.runSpec.runId,
        approved: decision.decision === 'approved',
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        signal: input.signal
      });
      input.evidence.resolveApproval(decision.approvalId);
    }
    for await (const event of finalResult ? emptyEvents() : input.runtime.runStreaming({
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
      if (!finalResult.pendingApproval) throw new Error('Approval-required result omitted pending approval metadata');
      const approvalId = approvalIdFor(finalResult.pendingApproval.toolCallId);
      const requestHash = createHash('sha256').update(finalResult.pendingApproval.inputPreview).digest('hex');
      input.evidence.addPendingApproval(approvalId);
      await input.emitter.emit({
        type: 'run.approval_requested',
        approval: {
          id: approvalId,
          organizationId: input.runSpec.organizationId,
          projectId: input.runSpec.projectId,
          taskId: input.runSpec.taskId,
          runId: input.runSpec.runId,
          scope: 'run',
          riskLevel: approvalRisk(finalResult.pendingApproval.risk),
          actionPreview: finalResult.pendingApproval.inputPreview || finalResult.pendingApproval.toolName,
          target: {
            type: 'tool', toolCallId: finalResult.pendingApproval.toolCallId,
            toolName: finalResult.pendingApproval.toolName, argumentsHash: requestHash
          },
          status: 'pending',
          requestedAt: this.now().toISOString(),
          expiresAt: new Date(this.now().getTime() + 86_400_000).toISOString()
        }
      });
      const saved = await input.checkpointStore.save({
        version: 1,
        runId: input.runSpec.runId,
        generation: input.runSpec.generation,
        contextState: input.runtime.exportContextState(),
        workState: input.runtime.exportWorkState(),
        pendingApproval: { approvalId, requestHash },
        savedAt: this.now().toISOString()
      });
      const remote = await this.options.transport.uploadCheckpoint({
        runToken: this.options.runToken,
        absolutePath: join(input.checkpointStore.directoryPath, saved.key),
        sha256: saved.sha256,
        sizeBytes: saved.sizeBytes
      });
      await input.emitter.emit({
        type: 'run.checkpoint_updated',
        checkpointKey: remote.checkpointKey,
        sha256: saved.sha256,
        sizeBytes: saved.sizeBytes,
        completedThroughSeq: Math.max(1, input.emitter.lastSequence)
      });
      return { status: 'waiting_for_approval', summary: finalResult.summary, lastSequence: input.emitter.lastSequence };
    }
    const summary = finalResult.summary || fullText;
    const artifactIds = finalResult.status === 'completed'
      ? await publishOutputArtifacts({
          runSpec: input.runSpec,
          lease: this.options.lease,
          runToken: this.options.runToken,
          outputDirectory: input.outputDirectory,
          transport: this.options.transport,
          signal: input.signal
        })
      : [];
    for (const artifactId of artifactIds) input.evidence.recordArtifact(artifactId);
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
          content: [
            { type: 'text', text: summary },
            ...artifactIds.map((artifactId) => ({ type: 'artifact_reference' as const, artifactId }))
          ],
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

  private async restoreCheckpoint(runSpec: RunSpec, store: FileCheckpointStore, runtime: WorkAgentRuntime): Promise<import('@kross/work-runtime').WorkRuntimeCheckpoint | undefined> {
    if (!runSpec.resumeCheckpointKey) return undefined;
    const localKey = 'restored-checkpoint.json';
    await this.options.transport.downloadCheckpoint({
      runToken: this.options.runToken, checkpointKey: runSpec.resumeCheckpointKey,
      destination: join(store.directoryPath, localKey)
    });
    const checkpoint = await store.load(localKey);
    if (!checkpoint) throw new Error('Resume checkpoint was not found');
    if (checkpoint.runId !== runSpec.runId || checkpoint.generation > runSpec.generation) throw new Error('Resume checkpoint does not belong to this run generation');
    if (!runtime.restoreContextState(checkpoint.contextState as never) || !runtime.restoreWorkState(checkpoint.workState as never)) {
      throw new Error('Core checkpoint restore failed closed');
    }
    return checkpoint;
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
async function* emptyEvents(): AsyncGenerator<never> {}
function approvalIdFor(toolCallId: string): string {
  return `approval_${createHash('sha256').update(toolCallId).digest('hex').slice(0, 32)}`;
}
function approvalRisk(risk: string): 'low' | 'medium' | 'high' | 'critical' {
  if (risk === 'read') return 'low';
  if (risk === 'write') return 'high';
  if (risk === 'critical') return 'critical';
  return 'medium';
}
