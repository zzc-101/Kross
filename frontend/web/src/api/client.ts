import { z } from 'zod';

import type {
  AgentMemory, AgentMessage, AuthConfig, Conversation, InvitePreview, Me, MessagePart, Skill, WorkspaceFile, WorkspaceListing
} from './types';
import type { ChannelEvent } from './channelEvents';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function isUnauthorizedError(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.status === 401;
}

const id = z.string().min(1);
const instant = z.string().min(1);

const meUserSchema = z.object({
  userId: id,
  username: z.string().min(1),
  displayName: z.string().min(1),
  platformRole: z.enum(['super_admin', 'user']),
  status: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  avatarUrl: z.string().min(1).optional(),
  gender: z.enum(['unspecified', 'male', 'female', 'other']).optional(),
  phone: z.string().min(1).optional()
});

const meSchema: z.ZodType<Me> = z.object({
  user: meUserSchema,
  memberships: z.array(z.object({
    id,
    organizationId: id,
    organizationName: z.string().min(1),
    organizationSlug: z.string().min(1),
    userId: id,
    role: z.enum(['admin', 'member']),
    status: z.string()
  })),
  canAccessAdmin: z.boolean()
});

const authConfigSchema: z.ZodType<AuthConfig> = z.object({
  registrationEnabled: z.boolean(),
  bootstrapRequired: z.boolean(),
  organizationExists: z.boolean(),
  ssoEnabled: z.boolean(),
  ssoDisplayName: z.string().min(1).optional()
});

const invitePreviewSchema: z.ZodType<InvitePreview> = z.object({
  organizationName: z.string().min(1),
  organizationSlug: z.string().min(1),
  role: z.enum(['admin', 'member']),
  expiresAt: instant,
  accepted: z.boolean()
});

const conversationSchema: z.ZodType<Conversation, z.ZodTypeDef, unknown> = z.object({
  id,
  title: z.string().min(1),
  skillId: z.string().min(1).optional(),
  archivedAt: instant.optional(),
  lastMessageAt: instant,
  createdAt: instant
});

const partSchema: z.ZodType<MessagePart> = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({
    type: z.literal('tool'),
    id: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
    result: z.string().optional(),
    status: z.enum(['running', 'approval-required', 'done', 'failed']).optional(),
    approval: z.object({
      id,
      risk: z.string(),
      reason: z.string().optional(),
      inputPreview: z.string().optional(),
      approved: z.boolean().optional()
    }).optional()
  })
]);

const contextUsageSchema = z.preprocess(
  (value) => {
    if (value == null) return undefined;
    if (
      typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value as Record<string, unknown>).length === 0
    ) {
      return undefined;
    }
    return value;
  },
  z.object({
    usedTokens: z.number().int().nonnegative(),
    contextWindow: z.number().int().positive(),
    ratio: z.number().nonnegative()
  }).optional()
);

const messageSchema: z.ZodType<AgentMessage, z.ZodTypeDef, unknown> = z.object({
  id,
  conversationId: id,
  role: z.enum(['user', 'agent', 'system']),
  content: z.string(),
  parts: z.array(partSchema).optional(),
  status: z.enum(['queued', 'processing', 'done', 'failed']),
  errorSummary: z.string().optional(),
  contextUsage: contextUsageSchema,
  createdAt: instant
});

const workspaceListingSchema: z.ZodType<WorkspaceListing> = z.object({
  path: z.string().min(1),
  entries: z.array(z.object({
    name: z.string().min(1),
    type: z.enum(['file', 'dir']),
    size: z.number().optional(),
    modifiedAt: instant.optional()
  }))
});

const workspaceFileSchema: z.ZodType<WorkspaceFile> = z.object({
  path: z.string().min(1),
  content: z.string()
});

const skillSchema: z.ZodType<Skill> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  category: z.string().min(1),
  icon: z.string().min(1),
  launchMode: z.enum(['instant', 'form', 'file']),
  starterPrompt: z.string(),
  revision: z.number().int().positive()
});

const memorySchema: z.ZodType<AgentMemory> = z.object({
  id,
  kind: z.enum(['preference', 'fact']),
  source: z.enum(['manual', 'remember', 'extract']),
  content: z.string().min(1),
  createdAt: instant,
  updatedAt: instant
});

const envelopeSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional()
});

export class AgentApiClient {
  private readonly fetcher: typeof fetch;
  private organizationId?: string;

  constructor(private readonly options: {
    baseUrl?: string;
    fetch?: typeof fetch;
  } = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  selectOrganization(organizationId: string): void {
    this.organizationId = organizationId;
  }

  authConfig(): Promise<AuthConfig> {
    return this.request('/api/v2/auth/config', authConfigSchema, { organization: false });
  }

  login(input: { username: string; password: string }): Promise<Me> {
    return this.request('/api/v2/auth/login', meSchema, {
      method: 'POST',
      organization: false,
      body: input
    });
  }

  register(input: { username: string; password: string; displayName?: string }): Promise<Me> {
    return this.request('/api/v2/auth/register', meSchema, {
      method: 'POST',
      organization: false,
      body: input
    });
  }

  logout(): Promise<void> {
    return this.request('/api/v2/auth/logout', z.unknown().optional(), {
      method: 'POST',
      organization: false
    }).then(() => undefined);
  }

  me(): Promise<Me> {
    return this.request('/api/v2/me', meSchema, { organization: false });
  }

  previewInvite(token: string): Promise<InvitePreview> {
    return this.request(
      `/api/v2/auth/invites/${encodeURIComponent(token)}`,
      invitePreviewSchema,
      { organization: false }
    );
  }

  acceptInvite(token: string, input?: { username?: string; password?: string; displayName?: string }): Promise<Me> {
    return this.request(
      `/api/v2/auth/invites/${encodeURIComponent(token)}/accept`,
      meSchema,
      { method: 'POST', organization: false, body: input ?? {} }
    );
  }

  updateProfile(input: { displayName?: string; avatarUrl?: string; gender?: string; phone?: string }): Promise<Me> {
    return this.request('/api/v2/me', meSchema, { method: 'PATCH', organization: false, body: input });
  }

  listConversations(): Promise<Conversation[]> {
    return this.request('/api/v2/agent/conversations', z.object({ items: z.array(conversationSchema) }))
      .then((page) => page.items);
  }

  createConversation(input?: { title?: string; skillId?: string }): Promise<Conversation> {
    return this.request('/api/v2/agent/conversations', conversationSchema, {
      method: 'POST',
      body: input ?? {}
    });
  }

  patchConversation(conversationId: string, patch: {
    title?: string;
    archived?: boolean;
  }): Promise<Conversation> {
    return this.request(
      `/api/v2/agent/conversations/${encodeURIComponent(conversationId)}`,
      conversationSchema,
      { method: 'PATCH', body: patch }
    );
  }

  listMessages(conversationId: string, limit = 200): Promise<AgentMessage[]> {
    return this.request(
      `/api/v2/agent/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`,
      z.object({ items: z.array(messageSchema) })
    ).then((page) => page.items);
  }

  appendMessage(conversationId: string, content: string): Promise<AgentMessage> {
    return this.request(
      `/api/v2/agent/conversations/${encodeURIComponent(conversationId)}/messages`,
      messageSchema,
      { method: 'POST', body: { content } }
    );
  }

  resolveApproval(
    conversationId: string,
    approvalId: string,
    input: { approved: boolean; reason?: string }
  ): Promise<void> {
    return this.request(
      `/api/v2/agent/conversations/${encodeURIComponent(conversationId)}/approvals/${encodeURIComponent(approvalId)}`,
      z.null(),
      { method: 'POST', body: input }
    ).then(() => undefined);
  }

  listWorkspace(path = '.'): Promise<WorkspaceListing> {
    return this.request(
      `/api/v2/agent/workspace/files?path=${encodeURIComponent(path)}`,
      workspaceListingSchema
    );
  }

  readWorkspaceFile(path: string): Promise<WorkspaceFile> {
    return this.request(
      `/api/v2/agent/workspace/file?path=${encodeURIComponent(path)}`,
      workspaceFileSchema
    );
  }

  listSkills(): Promise<Skill[]> {
    return this.request('/api/v2/agent/skills', z.object({ items: z.array(skillSchema) }))
      .then((page) => page.items);
  }

  listMemories(): Promise<AgentMemory[]> {
    return this.request('/api/v2/agent/memories', z.object({ items: z.array(memorySchema) }))
      .then((page) => page.items);
  }

  createMemory(input: { kind: AgentMemory['kind']; content: string }): Promise<AgentMemory> {
    return this.request('/api/v2/agent/memories', memorySchema, { method: 'POST', body: input });
  }

  patchMemory(memoryId: string, input: { kind?: AgentMemory['kind']; content?: string }): Promise<AgentMemory> {
    return this.request(`/api/v2/agent/memories/${encodeURIComponent(memoryId)}`, memorySchema, {
      method: 'PATCH',
      body: input
    });
  }

  forgetMemory(memoryId: string): Promise<void> {
    return this.request(`/api/v2/agent/memories/${encodeURIComponent(memoryId)}`, z.unknown().optional(), {
      method: 'DELETE'
    }).then(() => undefined);
  }

  rememberMemory(input: {
    conversationId?: string;
    messageId?: string;
    content?: string;
    kind?: AgentMemory['kind'];
  }): Promise<AgentMemory> {
    return this.request('/api/v2/agent/memories/remember', memorySchema, { method: 'POST', body: input });
  }

  async subscribeConversationEvents(
    conversationId: string,
    onEvent: (event: ChannelEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const headers = new Headers({ accept: 'text/event-stream' });
    if (this.organizationId) headers.set('x-kross-organization-id', this.organizationId);
    const response = await this.fetcher(
      new URL(
        `/api/v2/agent/conversations/${encodeURIComponent(conversationId)}/events`,
        this.options.baseUrl ?? location.origin
      ),
      { headers, credentials: 'include', signal }
    );
    if (!response.ok || !response.body) {
      throw new ApiError(response.status, 'SSE_ERROR', `无法订阅对话事件 (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const event = parseSseChunk(chunk);
        if (event) onEvent(event);
      }
    }
  }

  private async request<T, Input = T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, Input>, init: {
    method?: string;
    body?: unknown;
    organization?: boolean;
  } = {}): Promise<T> {
    const headers = new Headers({ accept: 'application/json' });
    if ((init.organization ?? true) && this.organizationId) {
      headers.set('x-kross-organization-id', this.organizationId);
    }
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.fetcher(new URL(path, this.options.baseUrl ?? location.origin), {
      method: init.method ?? 'GET',
      headers,
      credentials: 'include',
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const result = envelopeSchema.safeParse(json);
      if (result.success) {
        throw new ApiError(response.status, String(result.data.code), result.data.message);
      }
      const legacyError = z.object({
        error: z.object({ code: z.string().optional(), message: z.string().optional() })
      }).safeParse(json);
      throw new ApiError(
        response.status,
        legacyError.success ? legacyError.data.error.code ?? 'HTTP_ERROR' : 'HTTP_ERROR',
        legacyError.success
          ? legacyError.data.error.message ?? `请求失败 (${response.status})`
          : `请求失败 (${response.status})`
      );
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success || envelope.data.code !== 0) {
      throw new ApiError(502, 'INVALID_RESPONSE', '服务端返回的数据不符合协议');
    }
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) {
      throw new ApiError(502, 'INVALID_RESPONSE', '服务端返回的数据不符合协议');
    }
    return parsed.data;
  }
}

function parseSseChunk(chunk: string): ChannelEvent | undefined {
  const dataLines: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as ChannelEvent;
    if (!parsed || typeof parsed.type !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
