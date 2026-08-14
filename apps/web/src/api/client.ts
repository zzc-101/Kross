import { z } from 'zod';

import type { Agent, AgentMessage, Conversation, Me, MessagePart } from './types';
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

const id = z.string().min(1);
const instant = z.string().min(1);

const meSchema: z.ZodType<Me> = z.object({
  user: z.object({ userId: id, displayName: z.string().min(1) }),
  memberships: z.array(z.object({
    id,
    organizationId: id,
    userId: id,
    role: z.enum(['owner', 'admin', 'member', 'viewer']),
    status: z.string()
  }))
});

const agentSchema: z.ZodType<Agent> = z.object({
  id,
  organizationId: id,
  userId: id,
  status: z.enum(['stopped', 'starting', 'running', 'stopping', 'error']),
  lastActiveAt: instant,
  createdAt: instant
});

const conversationSchema: z.ZodType<Conversation> = z.object({
  id,
  title: z.string().min(1),
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
    status: z.enum(['running', 'done', 'failed']).optional()
  })
]);

const messageSchema: z.ZodType<AgentMessage> = z.object({
  id,
  conversationId: id,
  role: z.enum(['user', 'agent', 'system']),
  content: z.string(),
  parts: z.array(partSchema).optional(),
  status: z.enum(['queued', 'processing', 'done', 'failed']),
  errorSummary: z.string().optional(),
  createdAt: instant
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
    devUserId?: string;
    fetch?: typeof fetch;
  } = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  selectOrganization(organizationId: string): void {
    this.organizationId = organizationId;
  }

  me(): Promise<Me> {
    return this.request('/api/v2/me', meSchema, { organization: false });
  }

  async bootstrapOrganization(input: { name: string; slug: string }): Promise<Me> {
    await this.request('/api/v2/admin/bootstrap', z.unknown(), {
      method: 'POST',
      organization: false,
      body: {
        organizationId: globalThis.crypto.randomUUID(),
        name: input.name,
        slug: input.slug,
        defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
      }
    });
    return this.me();
  }

  getAgent(): Promise<Agent> {
    return this.request('/api/v2/agent', agentSchema);
  }

  listConversations(): Promise<Conversation[]> {
    return this.request('/api/v2/agent/conversations', z.object({ items: z.array(conversationSchema) }))
      .then((page) => page.items);
  }

  createConversation(title?: string): Promise<Conversation> {
    return this.request('/api/v2/agent/conversations', conversationSchema, {
      method: 'POST',
      body: title ? { title } : {}
    });
  }

  patchConversation(conversationId: string, patch: { title?: string; archived?: boolean }): Promise<Conversation> {
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

  async subscribeConversationEvents(
    conversationId: string,
    onEvent: (event: ChannelEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const headers = new Headers({ accept: 'text/event-stream' });
    if (this.options.devUserId) headers.set('x-kross-user-id', this.options.devUserId);
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

  sleep(): Promise<Agent> {
    return this.request('/api/v2/agent/sleep', agentSchema, { method: 'POST' });
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init: {
    method?: string;
    body?: unknown;
    organization?: boolean;
  } = {}): Promise<T> {
    const headers = new Headers({ accept: 'application/json' });
    if (this.options.devUserId) headers.set('x-kross-user-id', this.options.devUserId);
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
      const error = z.object({
        error: z.object({ code: z.string().optional(), message: z.string().optional() })
      }).safeParse(json);
      throw new ApiError(
        response.status,
        error.success ? error.data.error.code ?? 'HTTP_ERROR' : 'HTTP_ERROR',
        error.success ? error.data.error.message ?? `请求失败 (${response.status})` : `请求失败 (${response.status})`
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
