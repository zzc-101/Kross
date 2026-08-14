export interface AgentControlTransport {
  register(): Promise<{ heartbeatIntervalMs: number; idleMs: number }>;
  heartbeat(): Promise<{ shouldSleep: boolean; heartbeatIntervalMs: number }>;
  claimJob(): Promise<{
    id: string;
    conversationId: string;
    content: string;
    history: Array<{ role: string; content: string }>;
  } | undefined>;
  postReply(input: {
    userMessageId: string;
    content: string;
    status: 'done' | 'failed';
    errorSummary?: string;
  }): Promise<void>;
  sleep(): Promise<void>;
  mintModelEnvironment(): Promise<Record<string, string | undefined>>;
}

export interface FetchAgentControlTransportOptions {
  agentId: string;
  agentToken: string;
  controlPlaneUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class FetchAgentControlTransport implements AgentControlTransport {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: FetchAgentControlTransportOptions) {
    const url = new URL(options.controlPlaneUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Control plane URL must use HTTP(S)');
    if (!options.agentToken.trim()) throw new Error('Agent token is required');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async register(): Promise<{ heartbeatIntervalMs: number; idleMs: number }> {
    const body = await this.request('/internal/v2/agents/register', {
      type: 'agent.register',
      agentId: this.options.agentId
    });
    return {
      heartbeatIntervalMs: numberField(body, 'heartbeatIntervalMs'),
      idleMs: numberField(body, 'idleMs')
    };
  }

  async heartbeat(): Promise<{ shouldSleep: boolean; heartbeatIntervalMs: number }> {
    const body = await this.request('/internal/v2/agents/heartbeat', {
      type: 'agent.heartbeat',
      agentId: this.options.agentId
    });
    return {
      shouldSleep: Boolean((body as { shouldSleep?: unknown }).shouldSleep),
      heartbeatIntervalMs: numberField(body, 'heartbeatIntervalMs')
    };
  }

  async claimJob(): Promise<{
    id: string;
    conversationId: string;
    content: string;
    history: Array<{ role: string; content: string }>;
  } | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Control plane request timed out')), this.timeoutMs);
    try {
      const response = await this.fetch(new URL('/internal/v2/agents/jobs', this.options.controlPlaneUrl), {
        headers: {
          authorization: `Bearer ${this.options.agentToken}`,
          accept: 'application/json'
        },
        signal: controller.signal
      });
      if (response.status === 204) return undefined;
      if (!response.ok) {
        throw new Error(`Control plane /internal/v2/agents/jobs failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
      }
      const parsed = await response.json() as {
        id?: unknown;
        conversationId?: unknown;
        content?: unknown;
        history?: unknown;
      };
      if (typeof parsed.id !== 'string' || typeof parsed.content !== 'string') {
        throw new Error('Control plane returned an invalid job');
      }
      return {
        id: parsed.id,
        conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : '',
        content: parsed.content,
        history: parseHistory(parsed.history)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async postReply(input: {
    userMessageId: string;
    content: string;
    status: 'done' | 'failed';
    errorSummary?: string;
  }): Promise<void> {
    await this.request('/internal/v2/agents/messages', {
      type: 'agent.message',
      userMessageId: input.userMessageId,
      content: input.content,
      status: input.status,
      ...(input.errorSummary ? { errorSummary: input.errorSummary } : {})
    }, true);
  }

  async sleep(): Promise<void> {
    await this.request('/internal/v2/agents/sleep', {
      type: 'agent.sleep',
      agentId: this.options.agentId
    }, true);
  }

  async mintModelEnvironment(): Promise<Record<string, string | undefined>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Control plane request timed out')), this.timeoutMs);
    try {
      const response = await this.fetch(new URL('/internal/v2/agents/model-environment', this.options.controlPlaneUrl), {
        headers: {
          authorization: `Bearer ${this.options.agentToken}`,
          accept: 'application/json'
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Control plane model environment failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
      }
      const parsed = await response.json() as { env?: unknown };
      if (!parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) {
        throw new Error('Control plane returned an invalid model environment');
      }
      const env: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(parsed.env as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) env[key] = value;
      }
      if (!env.AGENT_LLM_PROVIDER) throw new Error('Control plane returned a model environment without AGENT_LLM_PROVIDER');
      return env;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request(path: string, body: Record<string, unknown>, allowEmpty = false): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Control plane request timed out')), this.timeoutMs);
    try {
      const response = await this.fetch(new URL(path, this.options.controlPlaneUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.agentToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
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

function parseHistory(value: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(value)) return [];
  const turns: Array<{ role: string; content: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (typeof role === 'string' && typeof content === 'string') {
      turns.push({ role, content });
    }
  }
  return turns;
}

function numberField(body: unknown, key: string): number {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Control plane response omitted ${key}`);
  }
  return value;
}
