import { z } from 'zod';
import {
  approvalPolicySchema, auditLogSchema, authConfigSchema, authLoginEventSchema, dashboardSchema, memberSchema, modelSchema,
  page, platformOrganizationSchema, platformSchema, platformSsoSchema, sessionSchema, userAccountSchema,
  type ApprovalPolicy, type Member, type ModelConfig, type PlatformSettings, type PlatformSso, type Session, type UserAccount
} from './contracts';

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

type RequestOptions = { method?: string; body?: unknown; organization?: boolean };

const envelopeSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional()
});

export class AdminApiClient {
  private organizationId?: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  selectOrganization(id: string) { this.organizationId = id; }
  authConfig() { return this.request('/api/v2/auth/config', authConfigSchema, { organization: false }); }
  login(input: { username: string; password: string }) {
    return this.request('/api/v2/auth/login', sessionSchema, { method: 'POST', body: input, organization: false });
  }
  register(input: { username: string; password: string; displayName?: string }) {
    return this.request('/api/v2/auth/register', sessionSchema, { method: 'POST', body: input, organization: false });
  }
  logout() {
    return this.request('/api/v2/auth/logout', z.unknown().optional(), { method: 'POST', organization: false }).then(() => undefined);
  }
  me() { return this.request('/api/v2/me', sessionSchema, { organization: false }); }
  updateProfile(input: { displayName?: string; avatarUrl?: string; gender?: string; phone?: string }) {
    return this.request('/api/v2/me', sessionSchema, { method: 'PATCH', body: input, organization: false });
  }
  createOrganization(input: {
    name: string; slug: string; defaultTimezone: string;
    adminUsername: string; adminPassword?: string; adminDisplayName?: string;
  }) {
    return this.request('/api/v2/admin/platform/organizations', platformOrganizationSchema, {
      method: 'POST', body: input, organization: false
    });
  }
  organizations() {
    return this.request('/api/v2/admin/platform/organizations', page(platformOrganizationSchema), { organization: false }).then(x => x.items);
  }
  updateOrganization(organizationId: string, input: { name?: string; status?: 'active' | 'suspended' }) {
    return this.request(`/api/v2/admin/platform/organizations/${encodeURIComponent(organizationId)}`, platformOrganizationSchema, {
      method: 'PATCH', body: input, organization: false
    });
  }
  assignAdmin(organizationId: string, input: { username: string; password?: string; displayName?: string }) {
    return this.request(`/api/v2/admin/platform/organizations/${encodeURIComponent(organizationId)}/admins`, memberSchema, {
      method: 'POST', body: input, organization: false
    });
  }
  dashboard() { return this.request('/api/v2/admin/dashboard', dashboardSchema); }
  members() { return this.request('/api/v2/admin/members', page(memberSchema)).then(x => x.items); }
  inviteMember(input: { username: string; password?: string; displayName?: string; role: Member['role'] }) {
    return this.request('/api/v2/admin/members', memberSchema, { method: 'POST', body: input });
  }
  updateMember(memberId: string, input: Partial<Pick<Member, 'role' | 'status'>>) { return this.request(`/api/v2/admin/members/${encodeURIComponent(memberId)}`, memberSchema, { method: 'PATCH', body: input }); }
  models() { return this.request('/api/v2/admin/models', page(modelSchema)).then(x => x.items); }
  createModel(input: { name: string; provider: string; model: string; apiKey: string; baseUrl?: string }) {
    return this.request('/api/v2/admin/models', modelSchema, { method: 'POST', body: input });
  }
  updateModel(modelId: string, input: Partial<Pick<ModelConfig, 'name' | 'provider' | 'model' | 'status'>>) {
    return this.request(`/api/v2/admin/models/${encodeURIComponent(modelId)}`, modelSchema, { method: 'PATCH', body: input });
  }
  approvalPolicy() { return this.request('/api/v2/admin/approval-policy', approvalPolicySchema); }
  updateApprovalPolicy(input: ApprovalPolicy) { return this.request('/api/v2/admin/approval-policy', approvalPolicySchema, { method: 'PATCH', body: input }); }
  auditLogs() { return this.request('/api/v2/admin/audit-logs', page(auditLogSchema)).then(x => x.items); }
  authLogs() {
    return this.request('/api/v2/admin/auth-logs', page(authLoginEventSchema), { organization: false }).then(x => x.items);
  }
  platform() { return this.request('/api/v2/admin/platform', platformSchema, { organization: false }); }
  updatePlatform(input: Partial<PlatformSettings>) {
    return this.request('/api/v2/admin/platform', platformSchema, { method: 'PATCH', body: input, organization: false });
  }
  users() { return this.request('/api/v2/admin/users', page(userAccountSchema), { organization: false }).then(x => x.items); }
  createUser(input: { username: string; password: string; displayName?: string }) {
    return this.request('/api/v2/admin/users', userAccountSchema, { method: 'POST', body: input, organization: false });
  }
  sso() { return this.request('/api/v2/admin/platform/sso', platformSsoSchema, { organization: false }); }
  updateSso(input: Partial<PlatformSso> & { clientSecret?: string }) {
    return this.request('/api/v2/admin/platform/sso', platformSsoSchema, { method: 'PATCH', body: input, organization: false });
  }

  private async request<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers({ accept: 'application/json' });
    if ((options.organization ?? true) && this.organizationId) headers.set('x-kross-organization-id', this.organizationId);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.fetcher(new URL(path, this.options.baseUrl ?? location.origin), {
      method: options.method ?? 'GET', headers, credentials: 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = z.object({ error: z.object({ code: z.string().optional(), message: z.string().optional() }) }).safeParse(json);
      throw new AdminApiError(response.status, error.success ? error.data.error.code ?? 'HTTP_ERROR' : 'HTTP_ERROR', error.success ? error.data.error.message ?? `请求失败 (${response.status})` : `请求失败 (${response.status})`);
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success || envelope.data.code !== 0) {
      throw new AdminApiError(502, 'INVALID_RESPONSE', '服务端返回的数据不符合管理端协议');
    }
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) throw new AdminApiError(502, 'INVALID_RESPONSE', '服务端返回的数据不符合管理端协议');
    return parsed.data;
  }
}

export type { Session, UserAccount };
