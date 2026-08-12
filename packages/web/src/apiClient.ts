import {
  approvalPageSchema,
  artifactPageSchema,
  runSummarySchema,
  sourcePageSchema,
  taskMessagePageSchema,
  taskMessageSchema,
  taskPageSchema,
  taskSnapshotSchema,
  taskSummarySchema,
  type ApprovalSummary,
  type ArtifactSummary,
  type RunSummary,
  type SourceSummary,
  type TaskMessage,
  type TaskSnapshot,
  type TaskSummary
} from '@kross/protocol';
import type { z } from 'zod';

import {
  bootstrapSchema,
  projectListSchema,
  projectSchema,
  serverRunRecordSchema,
  serverTaskRecordSchema,
  type Bootstrap,
  type Project
} from './contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface WorkApiOptions {
  baseUrl?: string;
  devUserId?: string;
  fetch?: typeof fetch;
}

export class WorkApiClient {
  private readonly fetcher: typeof fetch;
  private organizationId?: string;

  constructor(private readonly options: WorkApiOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  selectOrganization(organizationId: string): void {
    this.organizationId = organizationId;
  }

  me(): Promise<Bootstrap> {
    return this.get('/api/v2/me', bootstrapSchema, false);
  }

  listProjects(): Promise<Project[]> {
    return this.get('/api/v2/projects', projectListSchema).then((page) => page.items);
  }

  createProject(input: { name: string; description?: string }): Promise<Project> {
    return this.request('/api/v2/projects', projectSchema, {
      method: 'POST',
      body: { kind: 'general', ...input }
    });
  }

  async listTasks(projectId: string): Promise<TaskSummary[]> {
    const raw = await this.raw(`/api/v2/projects/${encodeURIComponent(projectId)}/tasks`);
    const official = taskPageSchema.safeParse(raw);
    if (official.success) return official.data.items;
    const skeleton = serverTaskRecordSchema.array().safeParse((raw as { items?: unknown }).items);
    if (!skeleton.success) throw protocolError('taskPage', official.error);
    return skeleton.data.map((task) => ({
      id: task.id,
      organizationId: task.organizationId,
      projectId: task.projectId,
      type: task.type,
      status: task.status,
      title: task.title,
      objectivePreview: task.objective.slice(0, 500),
      latestRunId: task.latestRunId,
      messageCount: 0,
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    }));
  }

  createTask(projectId: string, input: {
    type: TaskSummary['type']; title: string; objective: string;
  }): Promise<TaskSummary> {
    return this.raw(
      `/api/v2/projects/${encodeURIComponent(projectId)}/tasks`,
      { method: 'POST', body: input, idempotencyKey: createIdempotencyKey() }
    ).then((raw) => {
      const official = taskSummarySchema.safeParse(raw);
      return official.success
        ? official.data
        : toTaskSummary(serverTaskRecordSchema.parse(raw));
    });
  }

  async getTask(taskId: string): Promise<TaskSnapshot> {
    const raw = await this.raw(`/api/v2/tasks/${encodeURIComponent(taskId)}`);
    const official = taskSnapshotSchema.safeParse(raw);
    if (official.success) return official.data;
    const skeleton = serverTaskRecordSchema.safeParse(raw);
    if (!skeleton.success) throw protocolError('taskSnapshot', official.error);
    return taskSnapshotSchema.parse({
      ...skeleton.data,
      messageCount: 0,
      runCount: skeleton.data.latestRunId ? 1 : 0,
      sourceCount: 0,
      artifactCount: 0
    });
  }

  listMessages(taskId: string): Promise<TaskMessage[]> {
    return this.optionalPage(
      `/api/v2/tasks/${encodeURIComponent(taskId)}/messages`,
      taskMessagePageSchema
    );
  }

  appendMessage(taskId: string, text: string): Promise<TaskMessage> {
    return this.request(
      `/api/v2/tasks/${encodeURIComponent(taskId)}/messages`,
      taskMessageSchema,
      { method: 'POST', body: { content: [{ type: 'text', text }] }, idempotencyKey: createIdempotencyKey() }
    );
  }

  async createRun(taskId: string, mode: 'auto' | 'plan' = 'auto'): Promise<RunSummary> {
    const raw = await this.raw(`/api/v2/tasks/${encodeURIComponent(taskId)}/runs`, {
      method: 'POST', body: { mode }, idempotencyKey: createIdempotencyKey()
    });
    return decodeRun(raw);
  }

  async getRun(runId: string): Promise<RunSummary> {
    return decodeRun(await this.raw(`/api/v2/runs/${encodeURIComponent(runId)}`));
  }

  async cancelRun(runId: string): Promise<RunSummary> {
    return decodeRun(await this.raw(`/api/v2/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }));
  }

  listSources(projectId: string): Promise<SourceSummary[]> {
    return this.optionalPage(`/api/v2/projects/${encodeURIComponent(projectId)}/sources`, sourcePageSchema);
  }

  listArtifacts(taskId: string): Promise<ArtifactSummary[]> {
    return this.optionalPage(`/api/v2/tasks/${encodeURIComponent(taskId)}/artifacts`, artifactPageSchema);
  }

  listApprovals(runId?: string): Promise<ApprovalSummary[]> {
    const query = runId ? `?run=${encodeURIComponent(runId)}` : '';
    return this.optionalPage(`/api/v2/approvals${query}`, approvalPageSchema);
  }

  private async optionalPage<T extends z.ZodTypeAny>(path: string, schema: T): Promise<Array<z.infer<T>['items'][number]>> {
    try {
      const value = await this.get(path, schema);
      return value.items;
    } catch (error) {
      if (error instanceof ApiError && [404, 501, 503].includes(error.status)) return [];
      throw error;
    }
  }

  private get<T>(path: string, schema: z.ZodType<T>, organization = true): Promise<T> {
    return this.request(path, schema, { method: 'GET', organization });
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init: {
    method: string; body?: unknown; idempotencyKey?: string; organization?: boolean;
  }): Promise<T> {
    return schema.parse(await this.raw(path, init));
  }

  private async raw(path: string, init: {
    method?: string; body?: unknown; idempotencyKey?: string; organization?: boolean;
  } = {}): Promise<unknown> {
    const headers = new Headers({ accept: 'application/json' });
    if (this.options.devUserId) headers.set('x-kross-user-id', this.options.devUserId);
    if ((init.organization ?? true) && this.organizationId) {
      headers.set('x-kross-organization-id', this.organizationId);
    }
    if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.fetcher(new URL(path, this.options.baseUrl ?? location.origin), {
      method: init.method ?? 'GET', headers, credentials: 'include',
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
    const json = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
    if (!response.ok) throw new ApiError(response.status, json?.error?.code ?? 'HTTP_ERROR', json?.error?.message ?? `请求失败 (${response.status})`);
    return json;
  }
}

function protocolError(name: string, cause: unknown): Error {
  return new Error(`服务端返回的数据不符合 Protocol v2 (${name})`, { cause });
}

export function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toTaskSummary(task: z.infer<typeof serverTaskRecordSchema>): TaskSummary {
  return taskPageSchema.shape.items.element.parse({
    id: task.id, organizationId: task.organizationId, projectId: task.projectId,
    type: task.type, status: task.status, title: task.title,
    objectivePreview: task.objective.slice(0, 500), latestRunId: task.latestRunId,
    messageCount: 0, createdBy: task.createdBy, createdAt: task.createdAt,
    updatedAt: task.updatedAt
  });
}

function decodeRun(raw: unknown): RunSummary {
  const official = runSummarySchema.safeParse(raw);
  if (official.success) return official.data;
  const skeleton = serverRunRecordSchema.parse(raw);
  return runSummarySchema.parse({
    id: skeleton.id, organizationId: skeleton.organizationId,
    projectId: skeleton.projectId, taskId: skeleton.taskId,
    attempt: skeleton.attempt, status: skeleton.status, mode: skeleton.mode,
    createdAt: skeleton.queuedAt, queuedAt: skeleton.queuedAt,
    startedAt: skeleton.startedAt, finishedAt: skeleton.finishedAt,
    ...(skeleton.status === 'failed'
      ? { failure: { code: 'RUN_FAILED', summary: '运行失败', retryable: false } }
      : {})
  });
}
