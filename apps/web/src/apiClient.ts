import {
  approvalPageSchema,
  approvalSummarySchema,
  artifactPageSchema,
  artifactSnapshotSchema,
  artifactSummarySchema,
  runSummarySchema,
  sourcePageSchema,
  sourceSummarySchema,
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
import { z } from 'zod';

import {
  bootstrapSchema,
  projectListSchema,
  projectSchema,
  serverApprovalRecordSchema,
  serverArtifactRecordSchema,
  serverRunRecordSchema,
  serverSourceRecordSchema,
  serverTaskRecordSchema,
  sourceUploadReservationSchema,
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

  async bootstrapOrganization(input: { name: string; slug: string }): Promise<Bootstrap> {
    await this.request('/api/v2/admin/bootstrap', z.object({
      organization: z.object({
        id: z.string().min(1), slug: z.string().min(1), name: z.string().min(1), defaultTimezone: z.string().min(1)
      }).strict(),
      membership: z.object({
        id: z.string().min(1), userId: z.string().min(1), role: z.literal('owner'), status: z.literal('active')
      }).strict()
    }).strict(), {
      method: 'POST',
      organization: false,
      body: {
        organizationId: globalThis.crypto?.randomUUID?.() ?? `org-${Date.now()}`,
        name: input.name,
        slug: input.slug,
        defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
      }
    });
    return this.me();
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
    return this.raw(`/api/v2/projects/${encodeURIComponent(projectId)}/sources`).then((raw) => {
      const official = sourcePageSchema.safeParse(raw);
      if (official.success) return official.data.items;
      return z.object({ items: z.array(serverSourceRecordSchema) }).parse(raw).items.map(toSourceSummary);
    });
  }

  listArtifacts(taskId: string): Promise<ArtifactSummary[]> {
    return this.raw(`/api/v2/tasks/${encodeURIComponent(taskId)}/artifacts`).then((raw) => {
      const official = artifactPageSchema.safeParse(raw);
      if (official.success) return official.data.items;
      return z.object({ items: z.array(serverArtifactRecordSchema) }).parse(raw).items.map(toArtifactSummary);
    });
  }

  async uploadSource(projectId: string, file: File): Promise<SourceSummary> {
    const sha256 = await digestFile(file);
    const reservation = sourceUploadReservationSchema.parse(await this.raw(
      `/api/v2/projects/${encodeURIComponent(projectId)}/sources/uploads`,
      { method: 'POST', body: { scope: 'project', displayName: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, sha256 } }
    ));
    const headers = new Headers();
    for (const header of reservation.upload.headers) headers.set(header.name, header.value);
    const uploaded = await this.fetcher(reservation.upload.url, { method: 'PUT', headers, body: file });
    if (!uploaded.ok) throw new ApiError(uploaded.status, 'SOURCE_UPLOAD_FAILED', `资料上传失败 (${uploaded.status})`);
    const completed = serverSourceRecordSchema.parse(await this.raw(
      `/api/v2/sources/${encodeURIComponent(reservation.id)}/complete`,
      { method: 'POST', body: { sizeBytes: file.size, sha256, mimeType: file.type || 'application/octet-stream' } }
    ));
    return toSourceSummary(completed);
  }

  async createInlineSource(projectId: string, displayName: string, content: string): Promise<SourceSummary> {
    const row = serverSourceRecordSchema.parse(await this.raw(
      `/api/v2/projects/${encodeURIComponent(projectId)}/sources/inline`,
      { method: 'POST', body: { scope: 'project', displayName, mimeType: 'text/plain', content } }
    ));
    return toSourceSummary(row);
  }

  async openArtifact(artifactId: string): Promise<string> {
    const raw = await this.raw(`/api/v2/artifacts/${encodeURIComponent(artifactId)}`);
    const official = artifactSnapshotSchema.safeParse(raw);
    if (!official.success) toArtifactSummary(serverArtifactRecordSchema.parse(raw));
    const response = await this.authorizedFetch(`/api/v2/artifacts/${encodeURIComponent(artifactId)}/content`);
    if (!response.ok) throw new ApiError(response.status, 'ARTIFACT_DOWNLOAD_FAILED', `交付物下载失败 (${response.status})`);
    return URL.createObjectURL(await response.blob());
  }

  listApprovals(runId?: string): Promise<ApprovalSummary[]> {
    const query = runId ? `?run=${encodeURIComponent(runId)}` : '';
    return this.raw(`/api/v2/approvals${query}`).then((raw) => decodeApprovalPage(raw, runId));
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string
  ): Promise<ApprovalSummary> {
    const raw = await this.raw(
      `/api/v2/approvals/${encodeURIComponent(approvalId)}/decision`,
      {
        method: 'POST',
        body: { decision, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
        idempotencyKey: createIdempotencyKey()
      }
    );
    return decodeApproval(raw);
  }

  private async optionalPage<T extends z.ZodTypeAny>(path: string, schema: T): Promise<Array<z.infer<T>['items'][number]>> {
    try {
      const raw = await this.raw(path);
      const parsed = schema.safeParse(raw);
      const value = parsed.success
        ? parsed.data
        : schema.parse({
            ...z.object({ items: z.array(z.unknown()) }).passthrough().parse(raw),
            pageInfo: { hasMore: false }
          });
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
    const response = await this.authorizedFetch(path, init);
    const json = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
    if (!response.ok) throw new ApiError(response.status, json?.error?.code ?? 'HTTP_ERROR', json?.error?.message ?? `请求失败 (${response.status})`);
    return json;
  }

  private authorizedFetch(path: string, init: {
    method?: string; body?: unknown; idempotencyKey?: string; organization?: boolean;
  } = {}): Promise<Response> {
    const headers = new Headers({ accept: 'application/json' });
    if (this.options.devUserId) headers.set('x-kross-user-id', this.options.devUserId);
    if ((init.organization ?? true) && this.organizationId) {
      headers.set('x-kross-organization-id', this.organizationId);
    }
    if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return this.fetcher(new URL(path, this.options.baseUrl ?? location.origin), {
      method: init.method ?? 'GET', headers, credentials: 'include',
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
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

function decodeApprovalPage(raw: unknown, runId?: string): ApprovalSummary[] {
  const official = approvalPageSchema.safeParse(raw);
  const items = official.success
    ? official.data.items
    : z.object({ items: z.array(serverApprovalRecordSchema) }).parse(raw).items.map(toApprovalSummary);
  return runId ? items.filter((approval) => approval.runId === runId) : items;
}

function decodeApproval(raw: unknown): ApprovalSummary {
  const official = approvalSummarySchema.safeParse(raw);
  return official.success ? official.data : toApprovalSummary(serverApprovalRecordSchema.parse(raw));
}

function toApprovalSummary(row: z.infer<typeof serverApprovalRecordSchema>): ApprovalSummary {
  return approvalSummarySchema.parse({
    id: row.id, organizationId: row.organization_id, projectId: row.project_id,
    taskId: row.task_id, runId: row.run_id, kind: row.kind, scope: row.scope,
    riskLevel: row.risk_level, actionPreview: row.action_preview, status: row.status,
    requestedAt: row.requested_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(['approved', 'rejected'].includes(row.status) ? {
      decidedAt: row.decided_at, decidedBy: row.decided_by,
      decisionIdempotencyKey: row.decision_idempotency_key
    } : {})
  });
}

function toSourceSummary(row: z.infer<typeof serverSourceRecordSchema>): SourceSummary {
  return sourceSummarySchema.parse({
    id: row.id, organizationId: row.organization_id, projectId: row.project_id,
    kind: row.kind, scope: row.scope, status: row.status, displayName: row.display_name,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.size_bytes != null ? { sizeBytes: Number(row.size_bytes) } : {}),
    ...(row.previous_source_id ? { previousSourceId: row.previous_source_id } : {}),
    createdBy: row.created_by, createdAt: row.created_at
  });
}

function toArtifactSummary(row: z.infer<typeof serverArtifactRecordSchema>): ArtifactSummary {
  return artifactSummarySchema.parse({
    id: row.id, organizationId: row.organization_id, projectId: row.project_id,
    taskId: row.task_id, runId: row.run_id, kind: row.kind, status: row.status,
    displayName: row.display_name,
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.size_bytes != null ? { sizeBytes: Number(row.size_bytes) } : {}),
    ...(row.previous_artifact_id ? { parentArtifactId: row.previous_artifact_id } : {}),
    createdAt: row.created_at
  });
}

async function digestFile(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
