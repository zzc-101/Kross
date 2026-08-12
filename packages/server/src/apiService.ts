import { createHash } from 'node:crypto';

import {
  assertMembershipCanPerform,
  taskTypeSchema,
  type OrganizationAction,
  type OrganizationContext
} from '@kross/work-domain';
import { idempotencyKeySchema, resourceIdSchema } from '@kross/protocol';
import { z } from 'zod';

import { ServerError } from './errors';
import type { Identity, IdentityProvider } from './identity';
import { OrganizationContextResolver } from './identity';
import type {
  CreateProjectCommand,
  CreateRunCommand,
  CreateTaskCommand,
  ArtifactRepository,
  IdempotencyRepository,
  MembershipRepository,
  OrganizationRepository,
  ProjectRepository,
  RunEventRepository,
  RunRepository,
  SourceRepository,
  TaskRepository
} from './repositories';
import type { SseService } from './sse';
import type { SourceArtifactService } from './sourceArtifactService';

const createProjectSchema = z.object({
  kind: z.enum(['general', 'repository']), name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(), repository: z.record(z.unknown()).optional(),
  defaultTaskType: taskTypeSchema.optional()
}).strict().superRefine((value, context) => {
  if ((value.kind === 'repository') !== (value.repository !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['repository'], message: 'Repository project requires repository binding' });
  }
});
const createTaskSchema = z.object({
  projectId: resourceIdSchema, type: taskTypeSchema, title: z.string().trim().min(1).max(500),
  objective: z.string().trim().min(1).max(100_000), constraints: z.array(z.string().trim().min(1)).max(50).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1)).max(50).optional()
}).strict();
const createRunSchema = z.object({
  mode: z.enum(['auto', 'plan']).default('auto'), selectedSourceIds: z.array(resourceIdSchema).max(100).optional(),
  requestedModelProfileId: resourceIdSchema.optional()
}).strict();
const sourceCommon = {
  scope: z.enum(['project', 'task']).default('project'), taskId: resourceIdSchema.optional(),
  displayName: z.string().trim().min(1).max(500), previousSourceId: resourceIdSchema.optional()
};
const createUploadSourceSchema = z.object({
  ...sourceCommon, mimeType: z.string().trim().min(3).max(255),
  sizeBytes: z.number().int().nonnegative().max(104_857_600).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional()
}).strict();
const createInlineSourceSchema = z.object({
  ...sourceCommon, mimeType: z.string().trim().min(3).max(255), content: z.string().max(20_000_000)
}).strict();
const createExternalSourceSchema = z.object({
  ...sourceCommon, kind: z.enum(['url', 'repository']), locator: z.string().trim().min(1).max(8_192),
  origin: z.record(z.unknown())
}).strict();
const completeSourceSchema = z.object({
  sizeBytes: z.number().int().nonnegative().max(104_857_600),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), mimeType: z.string().trim().min(3).max(255)
}).strict();

export interface ApiDependencies {
  readonly identity: IdentityProvider;
  readonly contexts: OrganizationContextResolver;
  readonly memberships: MembershipRepository;
  readonly organizations: OrganizationRepository;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly events: RunEventRepository;
  readonly idempotency: IdempotencyRepository;
  readonly sse: SseService;
  readonly sources: SourceRepository;
  readonly artifacts: ArtifactRepository;
  readonly sourceArtifacts: SourceArtifactService;
  readonly runCancellation?: { cancel(runId: string, organizationId: string): Promise<void> };
}

export class ApiService {
  public constructor(private readonly dependencies: ApiDependencies) {}

  public authenticate(headers: Readonly<Record<string, string | undefined>>): Promise<Identity> {
    return this.dependencies.identity.authenticate({ headers });
  }

  public async me(identity: Identity): Promise<Record<string, unknown>> {
    const memberships = await this.dependencies.memberships.listForUser(identity.userId);
    return { user: identity, memberships };
  }

  public async organization(identity: Identity, organizationId: string) {
    const context = await this.context(identity, organizationId, 'organization.read');
    return this.dependencies.organizations.get(context);
  }

  public async listProjects(identity: Identity, organizationId: string) {
    const context = await this.context(identity, organizationId, 'project.read');
    return this.dependencies.projects.list(context);
  }

  public async createProject(identity: Identity, organizationId: string, body: unknown) {
    const context = await this.context(identity, organizationId, 'project.create');
    return this.dependencies.projects.create(context, parse(createProjectSchema, body));
  }

  public async getProject(identity: Identity, organizationId: string, projectId: string) {
    const context = await this.context(identity, organizationId, 'project.read');
    return this.dependencies.projects.get(context, parse(resourceIdSchema, projectId));
  }

  public async listSources(identity: Identity, organizationId: string, projectId: string) {
    const context = await this.context(identity, organizationId, 'source.read');
    return this.dependencies.sources.list(context, parse(resourceIdSchema, projectId));
  }

  public async createSourceUpload(identity: Identity, organizationId: string, projectId: string, body: unknown) {
    const context = await this.context(identity, organizationId, 'source.create');
    const parsed = parse(createUploadSourceSchema, body);
    return this.dependencies.sourceArtifacts.createUpload(context, { ...parsed, projectId: parse(resourceIdSchema, projectId), scope: parsed.scope ?? 'project' });
  }

  public async createInlineSource(identity: Identity, organizationId: string, projectId: string, body: unknown) {
    const context = await this.context(identity, organizationId, 'source.create');
    const parsed = parse(createInlineSourceSchema, body);
    return this.dependencies.sourceArtifacts.createInline(context, { ...parsed, projectId: parse(resourceIdSchema, projectId), scope: parsed.scope ?? 'project' });
  }

  public async createExternalSource(identity: Identity, organizationId: string, projectId: string, body: unknown) {
    const context = await this.context(identity, organizationId, 'source.create');
    const parsed = parse(createExternalSourceSchema, body);
    return this.dependencies.sourceArtifacts.createExternal(context, { ...parsed, projectId: parse(resourceIdSchema, projectId), scope: parsed.scope ?? 'project' });
  }

  public async completeSource(identity: Identity, organizationId: string, sourceId: string, body: unknown) {
    const context = await this.context(identity, organizationId, 'source.create');
    return this.dependencies.sourceArtifacts.completeUpload(context, parse(resourceIdSchema, sourceId), parse(completeSourceSchema, body));
  }

  public async listTasks(identity: Identity, organizationId: string, projectId: string) {
    const context = await this.context(identity, organizationId, 'task.read');
    return this.dependencies.tasks.list(context, parse(resourceIdSchema, projectId));
  }

  public async createTask(
    identity: Identity,
    organizationId: string,
    body: unknown,
    key: string | undefined
  ) {
    const context = await this.context(identity, organizationId, 'task.create');
    const command = parse(createTaskSchema, body);
    return this.idempotent(context, 'task.create', key, command, () => this.dependencies.tasks.create(context, command));
  }

  public async getTask(identity: Identity, organizationId: string, taskId: string) {
    const context = await this.context(identity, organizationId, 'task.read');
    return this.dependencies.tasks.get(context, parse(resourceIdSchema, taskId));
  }

  public async listArtifacts(identity: Identity, organizationId: string, taskId: string) {
    const context = await this.context(identity, organizationId, 'artifact.read');
    return this.dependencies.artifacts.list(context, parse(resourceIdSchema, taskId));
  }

  public async getArtifact(identity: Identity, organizationId: string, artifactId: string) {
    const context = await this.context(identity, organizationId, 'artifact.read');
    return this.dependencies.artifacts.get(context, parse(resourceIdSchema, artifactId));
  }

  public async artifactContentUrl(identity: Identity, organizationId: string, artifactId: string) {
    const artifact = await this.getArtifact(identity, organizationId, artifactId);
    if (artifact.status !== 'ready' || typeof artifact.blob_key !== 'string') {
      throw new ServerError('artifact_not_ready', 'Artifact content is not ready', 409);
    }
    return this.dependencies.sourceArtifacts.createDownloadUrl(artifact.blob_key);
  }

  public async createRun(
    identity: Identity,
    organizationId: string,
    taskId: string,
    body: unknown,
    key: string | undefined
  ) {
    const context = await this.context(identity, organizationId, 'run.create');
    const parsed = parse(createRunSchema, body);
    const command: CreateRunCommand = {
      taskId: parse(resourceIdSchema, taskId),
      mode: parsed.mode ?? 'auto',
      ...(parsed.selectedSourceIds === undefined ? {} : { selectedSourceIds: parsed.selectedSourceIds }),
      ...(parsed.requestedModelProfileId === undefined ? {} : { requestedModelProfileId: parsed.requestedModelProfileId })
    };
    return this.idempotent(context, 'run.create', key, command, () => this.dependencies.runs.create(context, command));
  }

  public async getRun(identity: Identity, organizationId: string, runId: string) {
    const context = await this.context(identity, organizationId, 'run.read');
    return this.dependencies.runs.get(context, parse(resourceIdSchema, runId));
  }

  public async cancelRun(identity: Identity, organizationId: string, runId: string) {
    const context = await this.context(identity, organizationId, 'run.cancel');
    const parsedRunId = parse(resourceIdSchema, runId);
    const run = await this.dependencies.runs.requestCancel(context, parsedRunId);
    if (run.status === 'cancelling') {
      await this.dependencies.runCancellation?.cancel(parsedRunId, context.organizationId);
    }
    return run;
  }

  public async replayEvents(
    identity: Identity,
    organizationId: string,
    cursor: string | undefined,
    filters: { projectId?: string; taskId?: string; runId?: string }
  ) {
    const context = await this.context(identity, organizationId, 'run.read');
    return this.dependencies.sse.replay(context, cursor, filters);
  }

  private context(identity: Identity, organizationId: string, action: OrganizationAction) {
    return this.dependencies.contexts.resolve(identity, organizationId, action);
  }

  private async idempotent<T extends { readonly id: string }>(
    context: OrganizationContext,
    scope: string,
    rawKey: string | undefined,
    command: unknown,
    operation: () => Promise<T>
  ): Promise<T> {
    if (!rawKey) throw new ServerError('idempotency_key_required', 'Idempotency-Key is required', 400);
    const key = parse(idempotencyKeySchema, rawKey);
    const hash = createHash('sha256').update(stableStringify(command)).digest('hex');
    const existing = await this.dependencies.idempotency.find(context, scope, key);
    if (existing) {
      if (existing.request_hash !== hash) throw new ServerError('idempotency_conflict', 'Idempotency key was used for another request', 409);
      if (existing.response_body == null) throw new ServerError('idempotency_in_progress', 'Idempotent request is still in progress', 409);
      return existing.response_body as T;
    }
    const reserved = await this.dependencies.idempotency.reserve(context, scope, key, hash);
    if (!reserved) {
      const raced = await this.dependencies.idempotency.find(context, scope, key);
      if (raced?.request_hash !== hash) throw new ServerError('idempotency_conflict', 'Idempotency key was used for another request', 409);
      if (raced.response_body != null) return raced.response_body as T;
      throw new ServerError('idempotency_in_progress', 'Idempotent request is still in progress', 409);
    }
    try {
      const result = await operation();
      await this.dependencies.idempotency.complete(
        context, scope, key, hash, 201,
        result as unknown as Readonly<Record<string, unknown>>, result.id
      );
      return result;
    } catch (error) {
      await this.dependencies.idempotency.abandon(context, scope, key, hash);
      throw error;
    }
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ServerError('invalid_request', 'Request validation failed', 400, { issues: result.error.issues });
  return result.data;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
