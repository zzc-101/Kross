import { randomUUID } from 'node:crypto';

export interface AgentControlTransport {
  register(): Promise<{ heartbeatIntervalMs: number; idleMs: number }>;
  heartbeat(activeJob?: { id: string; leaseId: string }): Promise<{
    shouldSleep: boolean;
    leaseValid: boolean;
    heartbeatIntervalMs: number;
  }>;
  claimJob(): Promise<{
    id: string;
    leaseId: string;
    conversationId: string;
    agentMessageId: string;
    content: string;
    history: Array<{ role: string; content: string }>;
    mode: 'auto' | 'plan' | 'conductor';
    modelId?: string;
    skill?: ActiveSkill;
  } | undefined>;
  postEvents(input: {
    userMessageId: string;
    agentMessageId: string;
    leaseId: string;
    events: AgentStreamEvent[];
  }): Promise<void>;
  postReply(input: {
    userMessageId: string;
    agentMessageId?: string;
    leaseId: string;
    content: string;
    status: 'processing' | 'done' | 'failed';
    errorSummary?: string;
    parts?: unknown[];
    usage?: AgentTokenUsage;
    contextUsage?: AgentContextUsage;
  }): Promise<void>;
  waitForApproval(approvalId: string): Promise<{ approved: boolean; reason?: string }>;
  onCommand(handler: (command: {
    commandId: string;
    name: string;
    payload: Record<string, unknown>;
  }) => Promise<{ ok: boolean; payload?: Record<string, unknown>; error?: string }>): void;
  sleep(): Promise<void>;
  mintModelEnvironment(modelId?: string): Promise<Record<string, string | undefined>>;
  fetchSettings(): Promise<{
    mcpServers: Record<string, unknown>;
    userMarkdown?: string;
    memoryMarkdown?: string;
  }>;
  close(): void;
}

export type ActiveSkill = {
  id: string;
  name: string;
  description: string;
  content: string;
  revision: number;
};

export type AgentTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  llmCalls: number;
  durationMs: number;
};

export type AgentContextUsage = {
  usedTokens: number;
  contextWindow: number;
  ratio: number;
};

export type AgentStreamEvent = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  ok?: boolean;
};

export interface WsAgentControlTransportOptions {
  agentId: string;
  agentToken: string;
  controlPlaneUrl: string;
  webSocket?: typeof WebSocket;
  timeoutMs?: number;
  reconnectDelayMs?: number;
}

type Job = {
  id: string;
  leaseId: string;
  conversationId: string;
  agentMessageId: string;
  content: string;
  history: Array<{ role: string; content: string }>;
  mode: 'auto' | 'plan' | 'conductor';
  modelId?: string;
  skill?: ActiveSkill;
};

type SocketMessage = {
  type?: unknown;
  code?: unknown;
  message?: unknown;
  heartbeatIntervalMs?: unknown;
  idleMs?: unknown;
  shouldSleep?: unknown;
  env?: unknown;
  mcpServers?: unknown;
  userMarkdown?: unknown;
  memoryMarkdown?: unknown;
  id?: unknown;
  conversationId?: unknown;
  agentMessageId?: unknown;
  content?: unknown;
  history?: unknown;
  mode?: unknown;
  modelId?: unknown;
  skill?: unknown;
  commandId?: unknown;
  name?: unknown;
  payload?: unknown;
  approvalId?: unknown;
  approved?: unknown;
  reason?: unknown;
  leaseId?: unknown;
  leaseValid?: unknown;
  deliveryId?: unknown;
};

export class WsAgentControlTransport implements AgentControlTransport {
  private readonly webSocket: typeof WebSocket;
  private readonly timeoutMs: number;
  private readonly reconnectDelayMs: number;
  private socket?: WebSocket;
  private closed = false;
  private opening?: Promise<void>;
  private readonly pending = new Map<string, Deferred<SocketMessage>[]>();
  private readonly pendingDeliveries = new Map<string, Deferred<void>>();
  private readonly jobs: Job[] = [];
  private readonly jobWaiters: Array<(job: Job | undefined) => void> = [];
  private readonly approvalWaiters = new Map<string, Deferred<{ approved: boolean; reason?: string }>>();
  private readonly approvalQueue = new Map<string, { approved: boolean; reason?: string }>();
  private commandHandler?: (command: {
    commandId: string;
    name: string;
    payload: Record<string, unknown>;
  }) => Promise<{ ok: boolean; payload?: Record<string, unknown>; error?: string }>;

  constructor(private readonly options: WsAgentControlTransportOptions) {
    const url = new URL(options.controlPlaneUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Control plane URL must use HTTP(S)');
    if (!options.agentToken.trim()) throw new Error('Agent token is required');
    this.webSocket = options.webSocket ?? WebSocket;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 250;
  }

  async register(): Promise<{ heartbeatIntervalMs: number; idleMs: number }> {
    const registered = this.waitFor('agent.registered');
    try {
      await this.ensureConnected();
      const body = await registered;
      return {
        heartbeatIntervalMs: numberField(body, 'heartbeatIntervalMs'),
        idleMs: numberField(body, 'idleMs')
      };
    } catch (error) {
      this.close();
      await registered.catch(() => undefined);
      throw error;
    }
  }

  async heartbeat(activeJob?: { id: string; leaseId: string }): Promise<{
    shouldSleep: boolean;
    leaseValid: boolean;
    heartbeatIntervalMs: number;
  }> {
    await this.ensureConnected();
    const body = await this.request('agent.heartbeat_ack', {
      type: 'agent.heartbeat',
      agentId: this.options.agentId,
      ...(activeJob ? { jobId: activeJob.id, leaseId: activeJob.leaseId } : {})
    });
    return {
      shouldSleep: Boolean(body.shouldSleep),
      leaseValid: body.leaseValid !== false,
      heartbeatIntervalMs: numberField(body, 'heartbeatIntervalMs')
    };
  }

  async claimJob(): Promise<Job | undefined> {
    if (this.closed) return undefined;
    await this.ensureConnected();
    const queued = this.jobs.shift();
    if (queued) return queued;
    return new Promise((resolve) => {
      this.jobWaiters.push(resolve);
    });
  }

  async postEvents(input: {
    userMessageId: string;
    agentMessageId: string;
    leaseId: string;
    events: AgentStreamEvent[];
  }): Promise<void> {
    if (input.events.length === 0) return;
    try {
      await this.ensureConnected();
      this.send({
        type: 'agent.events',
        userMessageId: input.userMessageId,
        agentMessageId: input.agentMessageId,
        leaseId: input.leaseId,
        events: input.events
      });
    } catch {
      // Streaming is transient; the final message remains the persisted source of truth.
    }
  }

  async postReply(input: {
    userMessageId: string;
    agentMessageId?: string;
    leaseId: string;
    content: string;
    status: 'processing' | 'done' | 'failed';
    errorSummary?: string;
    parts?: unknown[];
    usage?: AgentTokenUsage;
    contextUsage?: AgentContextUsage;
  }): Promise<void> {
    await this.deliver({
      type: 'agent.message',
      userMessageId: input.userMessageId,
      leaseId: input.leaseId,
      content: input.content,
      status: input.status,
      ...(input.agentMessageId ? { agentMessageId: input.agentMessageId } : {}),
      ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
      ...(input.parts ? { parts: input.parts } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.contextUsage ? { contextUsage: input.contextUsage } : {})
    });
  }

  async waitForApproval(approvalId: string): Promise<{ approved: boolean; reason?: string }> {
    const queued = this.approvalQueue.get(approvalId);
    if (queued) {
      this.approvalQueue.delete(approvalId);
      return queued;
    }
    return new Promise((resolve, reject) => {
      this.approvalWaiters.set(approvalId, { resolve, reject });
    });
  }

  onCommand(handler: (command: {
    commandId: string;
    name: string;
    payload: Record<string, unknown>;
  }) => Promise<{ ok: boolean; payload?: Record<string, unknown>; error?: string }>): void {
    this.commandHandler = handler;
  }

  async sleep(): Promise<void> {
    this.send({
      type: 'agent.sleep',
      agentId: this.options.agentId
    });
    this.close();
  }

  async mintModelEnvironment(modelId?: string): Promise<Record<string, string | undefined>> {
    await this.ensureConnected();
    const body = await this.request('agent.model_environment', {
      type: 'agent.model_environment',
      ...(modelId ? { modelId } : {})
    });
    if (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)) {
      throw new Error('Control plane returned an invalid model environment');
    }
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) env[key] = value;
    }
    if (!env.AGENT_LLM_PROVIDER) throw new Error('Control plane returned a model environment without AGENT_LLM_PROVIDER');
    return env;
  }

  async fetchSettings(): Promise<{
    mcpServers: Record<string, unknown>;
    userMarkdown?: string;
    memoryMarkdown?: string;
  }> {
    await this.ensureConnected();
    const body = await this.request('agent.settings', { type: 'agent.settings' });
    const raw = body.mcpServers;
    const mcpServers = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    return {
      mcpServers,
      ...(typeof body.userMarkdown === 'string' ? { userMarkdown: body.userMarkdown } : {}),
      ...(typeof body.memoryMarkdown === 'string' ? { memoryMarkdown: body.memoryMarkdown } : {})
    };
  }

  close(): void {
    this.closed = true;
    this.flushJobWaiters();
    this.rejectAll(new Error('Agent control websocket closed'));
    const socket = this.socket;
    this.socket = undefined;
    this.opening = undefined;
    if (socket && socket.readyState === this.webSocket.OPEN) socket.close();
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error('Agent control websocket is closed');
    if (this.socket && this.socket.readyState === this.webSocket.OPEN) return;
    if (this.opening) {
      await this.opening;
      return;
    }
    this.opening = this.connect();
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async connect(): Promise<void> {
    const socket = new this.webSocket(
      socketUrl(this.options.controlPlaneUrl),
      [`kross.bearer.${this.options.agentToken}`]
    );
    this.socket = socket;
    socket.addEventListener('message', (event) => this.onMessage(String((event as MessageEvent).data)));
    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.rejectTransient(new Error('Agent control websocket closed'));
      }
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) {
        this.rejectTransient(new Error('Agent control websocket error'));
      }
    });
    if (socket.readyState === this.webSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Control plane websocket timed out')), this.timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Control plane websocket error'));
      }, { once: true });
    });
  }

  private onMessage(raw: string): void {
    let parsed: SocketMessage;
    try {
      parsed = JSON.parse(raw) as SocketMessage;
    } catch {
      return;
    }
    const type = typeof parsed.type === 'string' ? parsed.type : '';
    if (type === 'agent.error') {
      const detail = typeof parsed.message === 'string' ? parsed.message : 'Agent websocket request failed';
      this.rejectAll(new Error(detail));
      return;
    }
    if (type === 'agent.job') {
      const job = parseJob(parsed);
      const waiter = this.jobWaiters.shift();
      if (waiter) waiter(job);
      else this.jobs.push(job);
      return;
    }
    if (type === 'agent.approval') {
      const approvalId = typeof parsed.approvalId === 'string' ? parsed.approvalId : '';
      if (!approvalId || typeof parsed.approved !== 'boolean') return;
      const decision = {
        approved: parsed.approved,
        ...(typeof parsed.reason === 'string' && parsed.reason.trim() ? { reason: parsed.reason } : {})
      };
      const waiter = this.approvalWaiters.get(approvalId);
      if (waiter) {
        this.approvalWaiters.delete(approvalId);
        waiter.resolve(decision);
      } else {
        this.approvalQueue.set(approvalId, decision);
      }
      return;
    }
    if (type === 'agent.command') {
      void this.dispatchCommand(parsed);
      return;
    }
    if (type === 'agent.message_ack') {
      const deliveryId = typeof parsed.deliveryId === 'string' ? parsed.deliveryId : '';
      const delivery = this.pendingDeliveries.get(deliveryId);
      if (delivery) {
        this.pendingDeliveries.delete(deliveryId);
        delivery.resolve();
      }
      return;
    }
    const waiters = this.pending.get(type);
    const waiter = waiters?.shift();
    if (waiter) waiter.resolve(parsed);
  }

  private async request(responseType: string, body: Record<string, unknown>): Promise<SocketMessage> {
    const wait = this.waitFor(responseType);
    this.send(body);
    return wait;
  }

  private async deliver(body: Record<string, unknown>): Promise<void> {
    const deliveryId = randomUUID();
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 5 && !this.closed; attempt += 1) {
      try {
        await this.ensureConnected();
        const acknowledgement = this.waitForDelivery(deliveryId);
        try {
          this.send({ ...body, deliveryId });
        } catch (error) {
          const sendError = error instanceof Error ? error : new Error(String(error));
          this.pendingDeliveries.get(deliveryId)?.reject(sendError);
        }
        await acknowledgement;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.pendingDeliveries.delete(deliveryId);
        if (attempt < 4 && !this.closed) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(this.reconnectDelayMs * 2 ** attempt, 2_000))
          );
        }
      }
    }
    throw lastError ?? new Error('Agent delivery failed');
  }

  private waitForDelivery(deliveryId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDeliveries.delete(deliveryId);
        reject(new Error(`Control plane delivery acknowledgement timed out: ${deliveryId}`));
      }, this.timeoutMs);
      this.pendingDeliveries.set(deliveryId, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  private waitFor(type: string): Promise<SocketMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removePending(type, deferred);
        reject(new Error(`Control plane ${type} timed out`));
      }, this.timeoutMs);
      const deferred: Deferred<SocketMessage> = {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      };
      const waiters = this.pending.get(type) ?? [];
      waiters.push(deferred);
      this.pending.set(type, waiters);
    });
  }

  private send(body: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.webSocket.OPEN) {
      throw new Error('Agent control websocket is not connected');
    }
    socket.send(JSON.stringify(body));
  }

  private removePending(type: string, deferred: Deferred<SocketMessage>): void {
    const waiters = this.pending.get(type);
    if (!waiters) return;
    const next = waiters.filter((item) => item !== deferred);
    if (next.length === 0) this.pending.delete(type);
    else this.pending.set(type, next);
  }

  private rejectAll(error: Error): void {
    this.rejectTransient(error);
    for (const waiter of this.approvalWaiters.values()) waiter.reject(error);
    this.approvalWaiters.clear();
    this.approvalQueue.clear();
  }

  private rejectTransient(error: Error): void {
    for (const waiters of this.pending.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.pendingDeliveries.values()) waiter.reject(error);
    this.pendingDeliveries.clear();
  }

  private flushJobWaiters(): void {
    while (this.jobWaiters.length > 0) {
      const waiter = this.jobWaiters.shift();
      waiter?.(undefined);
    }
  }

  private async dispatchCommand(parsed: SocketMessage): Promise<void> {
    const commandId = typeof parsed.commandId === 'string' ? parsed.commandId : '';
    const name = typeof parsed.name === 'string' ? parsed.name : '';
    if (!commandId || !name) return;
    const payload = parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)
      ? parsed.payload as Record<string, unknown>
      : {};
    try {
      const handler = this.commandHandler;
      const result = handler
        ? await handler({ commandId, name, payload })
        : { ok: false, error: 'Workspace commands are not available' };
      this.send({
        type: 'agent.command_result',
        commandId,
        ok: result.ok,
        ...(result.payload ? { payload: result.payload } : {}),
        ...(result.error ? { error: result.error } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.send({
          type: 'agent.command_result',
          commandId,
          ok: false,
          error: message
        });
      } catch {
        // socket already closed
      }
    }
  }
}

type Deferred<T> = {
  resolve(value: T): void;
  reject(error: Error): void;
};

function socketUrl(controlPlaneUrl: string): string {
  const url = new URL('/internal/v2/agents/ws', controlPlaneUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function parseJob(value: SocketMessage): Job {
  if (
    typeof value.id !== 'string'
    || typeof value.leaseId !== 'string'
    || !value.leaseId.trim()
    || typeof value.content !== 'string'
    || typeof value.agentMessageId !== 'string'
  ) {
    throw new Error('Control plane returned an invalid job');
  }
  const skill = parseSkill(value.skill);
  return {
    id: value.id,
    leaseId: value.leaseId,
    conversationId: typeof value.conversationId === 'string' ? value.conversationId : '',
    agentMessageId: value.agentMessageId,
    content: value.content,
    history: parseHistory(value.history),
    mode: parseMode(value.mode),
    ...(typeof value.modelId === 'string' && value.modelId.trim() ? { modelId: value.modelId } : {}),
    ...(skill ? { skill } : {})
  };
}

function parseSkill(value: unknown): ActiveSkill | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const skill = value as Record<string, unknown>;
  if (
    typeof skill.id !== 'string'
    || typeof skill.name !== 'string'
    || typeof skill.description !== 'string'
    || typeof skill.content !== 'string'
    || typeof skill.revision !== 'number'
  ) return undefined;
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    revision: skill.revision
  };
}

function parseMode(value: unknown): 'auto' | 'plan' | 'conductor' {
  return value === 'plan' || value === 'conductor' ? value : 'auto';
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

function numberField(body: SocketMessage, key: 'heartbeatIntervalMs' | 'idleMs'): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Control plane response omitted ${key}`);
  }
  return value;
}
