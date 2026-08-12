import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { OrganizationContext } from '@kross/work-domain';

import type { QueryResult, SqlClient, SqlExecutor, TransactionRunner } from './database';
import type { OrchestratorClient, OrchestratorLaunchRequest } from './orchestratorClient';
import { ProjectRepository, RunRepository, TaskRepository } from './repositories';
import { RunScheduler } from './runScheduler';
import { PostgresWorkerControlService } from './workerControl';

const now = '2026-08-12T00:00:00.000Z';
const leaseExpiry = '2026-08-12T00:01:00.000Z';
const context: OrganizationContext = {
  organizationId: 'org-a', userId: 'user-a', membershipId: 'membership-a', role: 'admin'
};

describe('SaaS vertical journey', () => {
  it('flows Project → Task → Run → scheduler → register → events → Artifact → terminal', async () => {
    const state = new JourneySql();
    const project = await new ProjectRepository(state).create(context, { kind: 'general', name: 'Market brief' });
    const task = await new TaskRepository(state).create(context, {
      projectId: project.id, type: 'research', title: 'Research competitors',
      objective: 'Deliver a cited comparison', acceptanceCriteria: ['Artifact is ready']
    });
    const run = await new RunRepository(state, state).create(context, { taskId: task.id, mode: 'auto' });

    const workerControl = new PostgresWorkerControlService(state, state, {
      now: () => new Date(now),
      sourceArtifacts: state.artifacts as never
    });
    const launched: OrchestratorLaunchRequest[] = [];
    const orchestrator: OrchestratorClient = {
      launch: vi.fn(async (request) => {
        launched.push(request);
        return handle(request.runId, request.generation);
      }),
      cancel: vi.fn(async (runId, generation) => ({ ...handle(runId, generation), state: 'exited' as const }))
    };
    const tokenIssuer = {
      issueRunToken: async (...args: Parameters<PostgresWorkerControlService['issueRunToken']>) => {
        const issued = await workerControl.issueRunToken(...args);
        state.issuedToken = issued.token;
        return issued;
      }
    };
    const scheduler = new RunScheduler(state, state, tokenIssuer, orchestrator, {
      owner: 'server-a', publicBaseUrl: 'http://server:8787'
    });
    expect(await scheduler.runOnce()).toBe(true);
    expect(launched[0]).toMatchObject({
      runId: run.id, generation: 1, leaseId: 'lease-1',
      runSpecUrl: 'http://server:8787/internal/v2/workers/register'
    });

    const runToken = state.issuedToken!;
    const registered = await workerControl.register(runToken, {
      protocolVersion: 2, type: 'worker.register', messageId: 'message-register', sentAt: now,
      workerId: 'worker-a', runId: run.id, generation: 1, leaseId: 'lease-1', workerVersion: '0.1.0',
      capabilities: { checkpointResume: true, artifactUpload: true, connectorProxy: true }
    });
    expect(registered.runSpec).toMatchObject({ runId: run.id, generation: 1, task: { title: task.title } });

    await workerControl.appendEvent(runToken, event(run.id, 1, 1, { type: 'run.started', startedAt: now }));
    const reserved = await workerControl.reserveArtifact(runToken, {
      protocolVersion: 2, type: 'artifact.reserve', messageId: 'message-reserve', sentAt: now,
      idempotencyKey: 'artifact-reserve-1', runId: run.id, generation: 1, taskId: task.id,
      kind: 'document', displayName: 'comparison.md', mimeType: 'text/markdown',
      sizeBytes: 12, sha256: 'a'.repeat(64), sourceIds: []
    });
    const artifactId = String(reserved.artifactId);
    const committed = await workerControl.commitArtifact(runToken, {
      protocolVersion: 2, type: 'artifact.commit', messageId: 'message-commit', sentAt: now,
      idempotencyKey: 'artifact-reserve-1', runId: run.id, generation: 1,
      artifactId, sizeBytes: 12, sha256: 'a'.repeat(64)
    });
    expect(committed).toMatchObject({ artifact: { id: artifactId, status: 'ready' } });
    await workerControl.appendEvent(runToken, event(run.id, 1, 2, {
      type: 'run.terminal', terminal: { status: 'completed', summary: 'Delivered', finishedAt: now }
    }));
    await workerControl.release(runToken, {
      protocolVersion: 2, type: 'lease.release', messageId: 'message-release', sentAt: now,
      workerSessionId: registered.workerSessionId, runId: run.id, generation: 1,
      leaseId: 'lease-1', reason: 'terminal'
    });

    expect(state.run?.status).toBe('completed');
    expect(state.lease.status).toBe('completed');
    expect(state.artifacts.committed).toBe(true);
  });

  it('rejects cross-tenant resource IDs at the repository boundary', async () => {
    const state = new JourneySql();
    const project = await new ProjectRepository(state).create(context, { kind: 'general', name: 'Private' });
    await expect(new ProjectRepository(state).get({ ...context, organizationId: 'org-b' }, project.id))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('fences a previous generation token and deduplicates worker sequence numbers', async () => {
    const state = await preparedRun();
    const worker = new PostgresWorkerControlService(state, state, { now: () => new Date(now) });
    const stale = state.issueTokenForGeneration(1);
    state.lease.generation = 2;
    state.lease.leaseId = 'lease-2';
    const runId = String(state.run!.id);
    expect(await worker.register(stale, register(runId, 1, 'lease-1')).catch((error) => error))
      .toMatchObject({ code: 'worker_unauthenticated' });

    const current = state.issueTokenForGeneration(2);
    const registered = await worker.register(current, register(runId, 2, 'lease-2'));
    await worker.appendEvent(current, event(runId, 2, 1, { type: 'run.started', startedAt: now }));
    await worker.appendEvent(current, event(runId, 2, 1, { type: 'run.started', startedAt: now }));
    expect(registered.runSpec.generation).toBe(2);
    expect(state.events.filter((item) => item.generation === 2 && item.seq === 1)).toHaveLength(1);
  });
});

class JourneySql implements SqlExecutor, TransactionRunner {
  project?: Record<string, unknown>;
  task?: Record<string, unknown>;
  run?: Record<string, unknown>;
  lease = { status: 'missing', generation: 0, leaseId: '', owner: '' };
  tokens = new Map<string, { generation: number; leaseId: string; session?: string; worker?: string; revoked: boolean }>();
  events: Array<{ generation: number; seq: number }> = [];
  issuedToken?: string;
  artifacts = new FakeArtifacts();

  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    return operation(this as SqlClient);
  }
  release(): void {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    let rows: Record<string, unknown>[] = [];
    if (text.includes('INSERT INTO projects')) {
      this.project = { id: values[0], organization_id: values[1], kind: values[2], name: values[3], description: values[4], status: 'active', created_by: values[8], created_at: now, updated_at: now };
      rows = [this.project];
    } else if (text.includes('SELECT * FROM projects WHERE organization_id')) {
      const project = this.project;
      if (project && project.organization_id === values[0] && project.id === values[1]) rows = [project];
    } else if (text.includes('INSERT INTO tasks')) {
      const project = this.project;
      if (project && project.organization_id === values[1] && project.id === values[2]) {
        this.task = { id: values[0], organization_id: values[1], project_id: values[2], type: values[3], title: values[4], objective: values[5], constraints: values[6], acceptance_criteria: values[7], status: 'open', created_by: values[8], created_at: now, updated_at: now };
        rows = [this.task];
      }
    } else if (text.includes('COALESCE(MAX(r.attempt)')) {
      const task = this.task;
      if (task && task.organization_id === values[0] && task.id === values[1]) rows = [{ ...task, last_attempt: this.run ? 1 : 0 }];
    } else if (text.includes('INSERT INTO runs')) {
      this.run = { id: values[0], organization_id: values[1], project_id: values[2], task_id: values[3], attempt: values[4], status: 'queued', mode: values[5], execution_profile: 'work', model_snapshot: { provider: 'test', model: 'test', credentialHandle: 'credential-test' }, permission_policy: values[7], resource_limits: values[8], selected_source_ids: values[9], usage: values[10], queued_at: now, created_by: values[11], created_at: now };
      rows = [this.run];
    } else if (text.includes('UPDATE tasks SET latest_run_id')) {
      if (this.task) this.task.latest_run_id = values[2];
    } else if (text.includes('INSERT INTO run_leases')) {
      this.lease = { status: 'available', generation: 0, leaseId: '', owner: '' };
    } else if (text.includes('SELECT run_id, organization_id FROM run_leases')) {
      if (['available', 'released'].includes(this.lease.status)) rows = [{ run_id: this.run!.id, organization_id: this.run!.organization_id }];
    } else if (text.includes("UPDATE run_leases SET status = 'leased'")) {
      this.lease = { status: 'leased', generation: this.lease.generation + 1, leaseId: 'lease-1', owner: String(values[3]) };
      rows = [{ lease_id: this.lease.leaseId, organization_id: this.run!.organization_id, run_id: this.run!.id, lease_owner: this.lease.owner, generation: this.lease.generation, lease_expires_at: leaseExpiry }];
    } else if (text.includes('SELECT resource_limits, permission_policy')) {
      rows = [{ resource_limits: this.run!.resource_limits, permission_policy: { ...(this.run!.permission_policy as object), networkAccess: 'disabled' } }];
    } else if (text.includes('INSERT INTO worker_run_tokens')) {
      const hash = String(values[0]);
      this.tokens.set(hash, { generation: Number(values[3]), leaseId: String(values[4]), revoked: false });
      rows = [{ expires_at: values[5] }];
    } else if (text.includes("UPDATE runs SET status = 'provisioning'")) {
      this.run!.status = 'provisioning'; this.run!.worker_generation = values[2]; rows = [{ id: this.run!.id }];
    } else if (text.includes('FROM worker_run_tokens t')) {
      const token = this.tokens.get(String(values[0]));
      if (token && !token.revoked && token.generation === this.lease.generation && token.leaseId === this.lease.leaseId) rows = [{ token_hash: values[0], organization_id: this.run!.organization_id, run_id: this.run!.id, generation: token.generation, lease_id: token.leaseId, expires_at: leaseExpiry, lease_owner: this.lease.owner, worker_session_id: token.session, worker_id: token.worker }];
    } else if (text.includes('UPDATE worker_run_tokens SET worker_session_id')) {
      const token = this.tokens.get(String(values[0])); if (token) { token.session = String(values[1]); token.worker = String(values[2]); rows = [{ worker_session_id: token.session }]; }
    } else if (text.includes('t.type AS task_type')) {
      rows = [{ ...this.run, task_type: this.task!.type, task_title: this.task!.title, task_objective: this.task!.objective, task_constraints: this.task!.constraints, task_acceptance_criteria: this.task!.acceptance_criteria, repository_binding: null, lease_expires_at: leaseExpiry, messages: [], checkpoint_key: null }];
    } else if (text.includes('accepted_through_seq')) {
      const generation = Number(values[2]); const seq = Number(values[5]);
      if (!this.events.some((item) => item.generation === generation && item.seq === seq)) this.events.push({ generation, seq });
      const event = values[8] as { terminal?: { status?: string } };
      if (values[6] === 'run.started') this.run!.status = 'running';
      if (values[6] === 'run.terminal') this.run!.status = event.terminal!.status!;
      rows = [{ accepted_through_seq: Math.max(...this.events.filter((item) => item.generation === generation).map((item) => item.seq)) }];
    } else if (text.includes('UPDATE run_leases l SET status = CASE')) {
      this.lease.status = ['completed', 'failed', 'cancelled'].includes(String(this.run!.status)) ? 'completed' : 'released';
    } else if (text.includes('UPDATE worker_run_tokens SET revoked_at')) {
      const token = this.tokens.get(String(values[0])); if (token) token.revoked = true;
    }
    return { rows: rows as Row[], rowCount: rows.length || (text.startsWith('UPDATE') || text.startsWith('INSERT') ? 1 : 0) };
  }

  issueTokenForGeneration(generation: number): string {
    const token = `token-generation-${generation}`;
    this.tokens.set(createHash('sha256').update(token).digest('hex'), { generation, leaseId: `lease-${generation}`, revoked: false });
    this.lease.status = 'leased'; this.lease.owner = 'server-a';
    return token;
  }
}

class FakeArtifacts {
  committed = false;
  async reserveArtifact(_context: unknown, generation: number, message: { runId: string; idempotencyKey: string }) {
    return { protocolVersion: 2, type: 'artifact.reserved', messageId: 'reserved-response', sentAt: now, idempotencyKey: message.idempotencyKey, runId: message.runId, generation, artifactId: 'artifact-1', alreadyCommitted: false, upload: { method: 'PUT', url: 'https://blob.test/upload', headers: [], expiresAt: leaseExpiry } };
  }
  async commitArtifact(_context: unknown, generation: number, message: { runId: string; idempotencyKey: string }) {
    this.committed = true;
    return { protocolVersion: 2, type: 'artifact.committed', messageId: 'commit-response', sentAt: now, idempotencyKey: message.idempotencyKey, runId: message.runId, generation, artifact: { id: 'artifact-1', organizationId: 'org-a', projectId: 'project-1', taskId: 'task-1', runId: message.runId, kind: 'document', status: 'ready', displayName: 'comparison.md', mimeType: 'text/markdown', sizeBytes: 12, sha256: 'a'.repeat(64), sourceIds: [], previewAvailable: false, downloadPath: '/api/v2/artifacts/artifact-1/content', readyAt: now, createdAt: now } };
  }
}

async function preparedRun() {
  const state = new JourneySql();
  const project = await new ProjectRepository(state).create(context, { kind: 'general', name: 'P' });
  const task = await new TaskRepository(state).create(context, { projectId: project.id, type: 'general', title: 'T', objective: 'O' });
  await new RunRepository(state, state).create(context, { taskId: task.id, mode: 'auto' });
  return state;
}

function event(runId: string, generation: number, seq: number, payload: Record<string, unknown>) {
  return { protocolVersion: 2 as const, runId, generation, seq, timestamp: now, event: payload } as never;
}
function register(runId: string, generation: number, leaseId: string) {
  return { protocolVersion: 2 as const, type: 'worker.register' as const, messageId: `register-${generation}`, sentAt: now, workerId: `worker-${generation}`, runId, generation, leaseId, workerVersion: '0.1.0', capabilities: { checkpointResume: true, artifactUpload: true, connectorProxy: true } };
}
function handle(runId: string, generation: number) { return { runId, generation, containerId: 'container-1', containerName: 'container-1', volumeName: 'volume-1', deadlineAt: leaseExpiry }; }
