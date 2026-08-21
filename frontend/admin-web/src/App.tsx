import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, Bot, Building2, CheckCircle2, ChevronDown, Cpu,
  LayoutDashboard, Menu, Plus, RefreshCw, ScrollText, Settings, ShieldCheck, Users, X
} from 'lucide-react';
import { AdminApiClient, AdminApiError } from './apiClient';
import type { ApprovalPolicy, AuditLog, AuthConfig, Member, ModelConfig, Session, UserAccount } from './contracts';

type Page = 'organizations' | 'platform' | 'dashboard' | 'members' | 'models' | 'policy' | 'audit';
const orgNavigation: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: '概览', icon: LayoutDashboard },
  { id: 'members', label: '成员与角色', icon: Users },
  { id: 'models', label: '模型配置', icon: Cpu },
  { id: 'policy', label: '审批策略', icon: ShieldCheck },
  { id: 'audit', label: '审计日志', icon: ScrollText }
];

export function App() {
  const [config, setConfig] = useState<AuthConfig>();
  const [session, setSession] = useState<Session>();
  const [organizationId, setOrganizationId] = useState('');
  const [page, setPage] = useState<Page>('organizations');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const api = useMemo(() => new AdminApiClient(), []);

  const applyMe = (data: Session) => {
    const adminMemberships = data.memberships.filter(item => item.role === 'admin');
    const firstOrganizationId = adminMemberships[0]?.organizationId || '';
    setSession(data);
    setOrganizationId(current => {
      const next = adminMemberships.some(item => item.organizationId === current) ? current : firstOrganizationId;
      if (next) api.selectOrganization(next);
      return next;
    });
    setPage(current => {
      if (!data.canAccessAdmin) return current;
      if (data.user.platformRole === 'super_admin' && adminMemberships.length === 0) return 'organizations';
      if (current === 'organizations' || current === 'platform') {
        return data.user.platformRole === 'super_admin' ? current : (firstOrganizationId ? 'dashboard' : current);
      }
      return firstOrganizationId ? current : 'organizations';
    });
  };

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void (async () => {
      try {
        const nextConfig = await api.authConfig();
        if (!active) return;
        setConfig(nextConfig);
        if (nextConfig.bootstrapRequired) setMode('register');
        try {
          applyMe(await api.me());
        } catch (e) {
          if (!active) return;
          if (e instanceof AdminApiError && e.status === 401) setSession(undefined);
          else setError(messageOf(e));
        }
      } catch (e) {
        if (active) setError(messageOf(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api]);
  useEffect(() => { if (organizationId) api.selectOrganization(organizationId); }, [api, organizationId]);

  const canRegister = Boolean(config?.registrationEnabled || config?.bootstrapRequired);
  const runAuth = async (action: () => Promise<Session>) => {
    setBusy(true); setError('');
    try { applyMe(await action()); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  const logout = async () => {
    await api.logout().catch(() => undefined);
    setSession(undefined);
    setOrganizationId('');
  };

  if (loading) return <Centered><Spinner /><h2>正在进入管理中心</h2><p>正在验证身份与组织权限…</p></Centered>;
  if (!session) {
    return <AuthGate mode={canRegister && mode === 'register' ? 'register' : 'login'} canRegister={canRegister} error={error} busy={busy}
      onLogin={(username, password) => runAuth(() => api.login({ username, password }))}
      onRegister={(username, password, displayName) => runAuth(() => api.register({ username, password, displayName }))}
      onToggle={() => { setError(''); setMode(current => current === 'login' ? 'register' : 'login'); }} />;
  }
  if (!session.canAccessAdmin) {
    return <Centered><ShieldCheck size={34} /><h2>没有管理权限</h2><p>普通用户请使用工作台。管理中心只对超级管理员和组织管理员开放。</p><a className="button" href={workbenchUrl()}>打开工作台</a><button className="button secondary" onClick={() => void logout()}>退出登录</button></Centered>;
  }

  const superAdmin = session.user.platformRole === 'super_admin';
  const adminMemberships = session.memberships.filter(item => item.role === 'admin');
  const currentMembership = adminMemberships.find(m => m.organizationId === organizationId);
  const pages = [
    ...(superAdmin ? [
      { id: 'organizations' as const, label: '组织', icon: Building2 },
      { id: 'platform' as const, label: '平台设置', icon: Settings }
    ] : []),
    ...(currentMembership ? orgNavigation : [])
  ];
  const roleLabel = superAdmin && !currentMembership ? '超级管理员' : (currentMembership?.role === 'admin' ? '组织管理员' : '管理员');
  return <div className="shell">
    <aside className={sidebarOpen ? 'sidebar open' : 'sidebar'}>
      <div className="brand"><span className="brand-mark"><Bot /></span><div><strong>Kross</strong><small>管理中心</small></div><button className="icon mobile-close" onClick={() => setSidebarOpen(false)}><X /></button></div>
      <nav>{pages.map(item => <button key={item.id} className={page === item.id ? 'nav-item active' : 'nav-item'} onClick={() => { setPage(item.id); setSidebarOpen(false); }}><item.icon />{item.label}</button>)}</nav>
      <div className="sidebar-foot"><span className="avatar">{session.user.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{session.user.displayName}</strong><small>{session.user.username} · {roleLabel}</small></div><button className="button secondary" type="button" onClick={() => void logout()}>退出</button></div>
    </aside>
    <main>
      <header className="topbar"><button className="icon mobile-menu" onClick={() => setSidebarOpen(true)}><Menu /></button>
        {currentMembership
          ? <div className="organization"><small>当前组织</small><select aria-label="选择组织" value={organizationId} onChange={e => { api.selectOrganization(e.target.value); setOrganizationId(e.target.value); }}>{adminMemberships.map(m => <option key={m.id} value={m.organizationId}>{m.organizationName}</option>)}</select><ChevronDown /></div>
          : <div className="organization"><small>平台</small><strong>组织管理</strong></div>}
        <div className="environment"><span />组织数据已隔离</div></header>
      <div className="content">
        {page === 'organizations' && superAdmin && <OrganizationsPage api={api} currentUsername={session.user.username} onChanged={() => void api.me().then(applyMe)} />}
        {page === 'platform' && superAdmin && <PlatformPage api={api} />}
        {page === 'dashboard' && currentMembership && <DashboardPage api={api} />}
        {page === 'members' && currentMembership && <MembersPage api={api} />}
        {page === 'models' && currentMembership && <ModelsPage api={api} />}
        {page === 'policy' && currentMembership && <PolicyPage api={api} />}
        {page === 'audit' && currentMembership && <AuditPage api={api} />}
      </div>
    </main>
  </div>;
}

function useResource<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T>(); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const reload = useCallback(() => { setLoading(true); setError(''); loader().then(setData).catch(e => setError(messageOf(e))).finally(() => setLoading(false)); }, dependencies);
  useEffect(reload, [reload]);
  return { data, setData, loading, error, reload };
}

function DashboardPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.dashboard(), [api]);
  return <PageFrame title="组织概览" subtitle="组织运行状况、风险与资源使用情况" action={<RefreshButton onClick={state.reload} />}><Resource state={state}>{d => <>
    <div className="metrics"><Metric label="活跃成员" value={d.counts.activeMembers} icon={<Users />} tone="blue" /><Metric label="运行中 Agent" value={d.counts.runningAgents} icon={<Activity />} tone="green" /><Metric label="已休眠 Agent" value={d.counts.stoppedAgents} icon={<LayoutDashboard />} tone="violet" /></div>
    <div className="dashboard-grid"><section className="card"><CardTitle title="工作区" subtitle="每人一个长期 Agent，容器可睡，磁盘留下" /><div className="health-list"><Health label="运行中" value={d.counts.runningAgents} ok={true} /><Health label="已休眠" value={d.counts.stoppedAgents} ok={true} /><Health label="活跃成员" value={d.counts.activeMembers} ok={d.counts.activeMembers > 0} /></div></section><section className="card callout"><Bot /><div><h3>Kross 控制面</h3><p>给组织成员配备长期 Agent 工作区。会话、模型密钥和 Worker 按组织隔离。</p></div></section></div>
  </>}</Resource></PageFrame>;
}

function MembersPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.members(), [api]); const [showForm, setShowForm] = useState(false); const [busy, setBusy] = useState('');
  const change = async (member: Member, field: 'role' | 'status', value: string) => { setBusy(member.id); try { await api.updateMember(member.id, { [field]: value }); state.reload(); } finally { setBusy(''); } };
  return <PageFrame title="成员与角色" subtitle="登记本组织成员。新用户可直接开账号并加入；已有账号只需填写用户名。" action={<button className="button" onClick={() => setShowForm(true)}><Plus />登记成员</button>}>
    {showForm && <InviteForm api={api} close={() => setShowForm(false)} done={state.reload} />}
    <Resource state={state} empty="组织中还没有成员。">{members => <div className="card table-wrap"><table><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>更新时间</th></tr></thead><tbody>{members.map(m => <tr key={m.id}><td><div className="person"><span className="avatar">{m.displayName[0]}</span><div><strong>{m.displayName}</strong><small>{m.username}</small></div></div></td><td><select disabled={busy === m.id} value={m.role} onChange={e => change(m, 'role', e.target.value)}><option value="admin">组织管理员</option><option value="member">成员</option></select></td><td><select disabled={busy === m.id} value={m.status} onChange={e => change(m, 'status', e.target.value)}><option value="active">正常</option><option value="disabled">已停用</option></select></td><td>{formatDate(m.updatedAt)}</td></tr>)}</tbody></table></div>}</Resource>
  </PageFrame>;
}

function InviteForm({ api, close, done }: { api: AdminApiClient; close: () => void; done: () => void }) {
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'member' as Member['role'] });
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try {
      await api.inviteMember({
        username: form.username, role: form.role,
        ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
        ...(form.password ? { password: form.password } : {})
      });
      close(); done();
    } catch (x) { setError(messageOf(x)); }
  };
  return <form className="card inline-form" onSubmit={submit}>
    <label>用户名<input required pattern="[A-Za-z][A-Za-z0-9_-]{2,31}" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="新用户或已有账号" /></label>
    <label>显示名称<input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} /></label>
    <label>初始密码<input type="password" minLength={8} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="新用户必填" /></label>
    <label>角色<select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as Member['role'] })}><option value="member">成员</option><option value="admin">组织管理员</option></select></label>
    <button className="button" type="submit">登记并加入</button>
    <button className="button secondary" type="button" onClick={close}>取消</button>
    {error && <span className="form-error">{error}</span>}
  </form>;
}

function OrganizationsPage({ api, currentUsername, onChanged }: { api: AdminApiClient; currentUsername: string; onChanged: () => void }) {
  const state = useResource(() => api.organizations(), [api]);
  const [form, setForm] = useState({ name: '', slug: '', adminUsername: currentUsername, adminPassword: '', adminDisplayName: '' });
  const [assign, setAssign] = useState({ organizationId: '', username: '', password: '', displayName: '' });
  const [error, setError] = useState('');
  const updateName = (value: string) => {
    setForm(current => {
      const ascii = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
      return { ...current, name: value, slug: ascii.length >= 2 ? ascii : current.slug };
    });
  };
  const create = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try {
      await api.createOrganization({
        name: form.name, slug: form.slug,
        defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
        adminUsername: form.adminUsername,
        ...(form.adminPassword ? { adminPassword: form.adminPassword } : {}),
        ...(form.adminDisplayName.trim() ? { adminDisplayName: form.adminDisplayName.trim() } : {})
      });
      setForm({ name: '', slug: '', adminUsername: currentUsername, adminPassword: '', adminDisplayName: '' });
      state.reload();
      onChanged();
    } catch (x) { setError(messageOf(x)); }
  };
  const assignAdmin = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try {
      await api.assignAdmin(assign.organizationId, {
        username: assign.username,
        ...(assign.password ? { password: assign.password } : {}),
        ...(assign.displayName.trim() ? { displayName: assign.displayName.trim() } : {})
      });
      setAssign({ organizationId: '', username: '', password: '', displayName: '' });
      state.reload();
      onChanged();
    } catch (x) { setError(messageOf(x)); }
  };
  return <PageFrame title="组织" subtitle="超级管理员创建组织、停用组织，并指定该组织的组织管理员。超管默认不是组织成员，也不能查看该组织对话。">
    <form className="card inline-form" onSubmit={create}>
      <label>组织名称<input required value={form.name} onChange={e => updateName(e.target.value)} placeholder="例如：产品一部" /></label>
      <label>组织标识<input required minLength={2} value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value })} placeholder="product-one" /></label>
      <label>组织管理员用户名<input required pattern="[A-Za-z][A-Za-z0-9_-]{2,31}" value={form.adminUsername} onChange={e => setForm({ ...form, adminUsername: e.target.value })} /></label>
      <label>显示名称<input value={form.adminDisplayName} onChange={e => setForm({ ...form, adminDisplayName: e.target.value })} placeholder="新账号时使用" /></label>
      <label>初始密码<input type="password" minLength={8} value={form.adminPassword} onChange={e => setForm({ ...form, adminPassword: e.target.value })} placeholder="已有账号可留空" /></label>
      <button className="button">创建组织</button>
      {error && <span className="form-error">{error}</span>}
    </form>
    <Resource state={state} empty="还没有组织。">{orgs => <div className="card table-wrap"><table><thead><tr><th>组织</th><th>状态</th><th>管理员</th><th>成员</th><th>操作</th></tr></thead><tbody>{orgs.map(org => <tr key={org.id}><td><div><strong>{org.name}</strong><small>{org.slug}</small></div></td><td>{org.status === 'active' ? '正常' : '已停用'}</td><td>{org.adminCount}</td><td>{org.memberCount}</td><td>
      <button className="button secondary" type="button" onClick={() => void api.updateOrganization(org.id, { status: org.status === 'active' ? 'suspended' : 'active' }).then(() => { state.reload(); onChanged(); })}>{org.status === 'active' ? '停用' : '启用'}</button>
      <button className="button secondary" type="button" onClick={() => setAssign({ organizationId: org.id, username: '', password: '', displayName: '' })}>指定管理员</button>
    </td></tr>)}</tbody></table></div>}</Resource>
    {assign.organizationId && <form className="card inline-form" onSubmit={assignAdmin}>
      <label>管理员用户名<input required pattern="[A-Za-z][A-Za-z0-9_-]{2,31}" value={assign.username} onChange={e => setAssign({ ...assign, username: e.target.value })} /></label>
      <label>显示名称<input value={assign.displayName} onChange={e => setAssign({ ...assign, displayName: e.target.value })} /></label>
      <label>初始密码<input type="password" minLength={8} value={assign.password} onChange={e => setAssign({ ...assign, password: e.target.value })} placeholder="已有账号可留空" /></label>
      <button className="button">指定为组织管理员</button>
      <button className="button secondary" type="button" onClick={() => setAssign({ organizationId: '', username: '', password: '', displayName: '' })}>取消</button>
    </form>}
  </PageFrame>;
}

function PlatformPage({ api }: { api: AdminApiClient }) {
  const settings = useResource(() => api.platform(), [api]);
  const users = useResource(() => api.users(), [api]);
  const [form, setForm] = useState({ username: '', password: '', displayName: '' });
  const [error, setError] = useState('');
  const toggle = async (registrationEnabled: boolean) => {
    const next = await api.updatePlatform({ registrationEnabled });
    settings.setData(next);
  };
  const create = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try {
      await api.createUser(form);
      setForm({ username: '', password: '', displayName: '' });
      users.reload();
    } catch (x) { setError(messageOf(x)); }
  };
  return <PageFrame title="平台设置" subtitle="超级管理员控制自助注册，并在关闭注册时直接创建账号。">
    <Resource state={settings}>{p => <section className="card policy-card"><CardTitle title="自助注册" subtitle="关闭后，新用户只能由组织管理员在本组织入职，或由超级管理员创建账号。" /><PolicyRow title="允许注册" description="第一个用户始终可以注册并成为超级管理员。之后是否开放注册由超级管理员决定。"><label className="switch"><input type="checkbox" checked={p.registrationEnabled} onChange={e => void toggle(e.target.checked)} /><span /></label></PolicyRow></section>}</Resource>
    <form className="card inline-form" onSubmit={create}>
      <label>用户名<input required pattern="[A-Za-z][A-Za-z0-9_-]{2,31}" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} /></label>
      <label>显示名称<input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} /></label>
      <label>初始密码<input required type="password" minLength={8} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label>
      <button className="button">创建账号</button>
      {error && <span className="form-error">{error}</span>}
    </form>
    <Resource state={users} empty="还没有账号。">{items => <div className="card table-wrap"><table><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{(items as UserAccount[]).map(user => <tr key={user.userId}><td><div className="person"><span className="avatar">{user.displayName[0]}</span><div><strong>{user.displayName}</strong><small>{user.username}</small></div></div></td><td>{user.platformRole === 'super_admin' ? '超级管理员' : '用户'}</td><td>{user.status}</td><td>{formatDate(user.createdAt)}</td></tr>)}</tbody></table></div>}</Resource>
  </PageFrame>;
}

function ModelsPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.models(), [api]); const [showForm, setShowForm] = useState(false);
  return <PageFrame title="模型配置" subtitle="录入供应商、模型 ID 和 API Key。密钥只写不读，界面不会回显明文。" action={<button className="button" onClick={() => setShowForm(true)}><Plus />添加模型</button>}>
    {showForm && <ModelForm api={api} close={() => setShowForm(false)} done={state.reload} />}
    <Resource state={state} empty="尚未配置模型。请先添加一个带 API Key 的模型，工作区才能对话。">{models => <div className="card-grid">{models.map(m => <article className="card model-card" key={m.id}><div className="card-icon"><Cpu /></div><div className="grow"><div className="title-line"><h3>{m.name}</h3><Badge tone={m.status === 'active' ? 'green' : 'neutral'}>{m.status === 'active' ? '已启用' : '已停用'}</Badge></div><p>{m.provider} · {m.model}</p><small>{m.credentialHandleId ? '已关联凭证' : '尚未关联凭证'} · 更新于 {formatDate(m.updatedAt)}</small></div><label className="switch"><input type="checkbox" checked={m.status === 'active'} onChange={() => api.updateModel(m.id, { status: m.status === 'active' ? 'disabled' : 'active' }).then(state.reload)} /><span /></label></article>)}</div>}</Resource>
  </PageFrame>;
}

function ModelForm({ api, close, done }: { api: AdminApiClient; close: () => void; done: () => void }) {
  const [form, setForm] = useState({ name: '', provider: 'openai', model: '', apiKey: '', baseUrl: '' }); const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.createModel({
        name: form.name, provider: form.provider, model: form.model, apiKey: form.apiKey,
        ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {})
      });
      close(); done();
    } catch (x) { setError(messageOf(x)); }
  };
  return <form className="card inline-form model-form" onSubmit={submit}>
    <label>显示名称<input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="默认模型" /></label>
    <label>供应商<select required value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>
      <option value="openai">OpenAI</option>
      <option value="anthropic">Anthropic</option>
      <option value="openrouter">OpenRouter</option>
      <option value="deepseek">DeepSeek</option>
      <option value="xai">xAI</option>
    </select></label>
    <label>模型 ID<input required value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} placeholder="gpt-4.1-mini" /></label>
    <label>API Key<input required type="password" autoComplete="off" minLength={8} value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder="只写一次，不会回显" /></label>
    <label>兼容网关地址（可选）<input value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" /></label>
    <button className="button">保存</button>
    <button type="button" className="button secondary" onClick={close}>取消</button>
    {error && <span className="form-error">{error}</span>}
  </form>;
}

function PolicyPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.approvalPolicy(), [api]); const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
  const save = async (policy: ApprovalPolicy) => { setSaving(true); setSaved(false); try { const result = await api.updateApprovalPolicy(policy); state.setData(result); setSaved(true); } finally { setSaving(false); } };
  return <PageFrame title="审批策略" subtitle="定义 Agent 执行计划、外部操作和敏感能力的授权边界"><Resource state={state}>{p => <div className="policy-layout"><section className="card policy-card"><CardTitle title="组织默认策略" subtitle={`时区 ${p.defaultTimezone} · 数据保留 ${p.dataRetentionDays ?? '无限'} 天`} /><PolicyRow title="计划执行前审批" description="Agent 在开始执行计划之前等待人工确认"><label className="switch"><input type="checkbox" checked={p.approvalPolicy.requirePlanApproval} onChange={e => save({ ...p, approvalPolicy: { ...p.approvalPolicy, requirePlanApproval: e.target.checked } })} /><span /></label></PolicyRow><PolicyRow title="外部操作审批" description="发送消息、提交表单或修改第三方系统"><label className="switch"><input type="checkbox" checked={p.approvalPolicy.requireExternalActionApproval} onChange={e => save({ ...p, approvalPolicy: { ...p.approvalPolicy, requireExternalActionApproval: e.target.checked } })} /><span /></label></PolicyRow><PolicyRisk value={p.approvalPolicy.minimumToolRiskRequiringApproval} onChange={v => save({ ...p, approvalPolicy: { ...p.approvalPolicy, minimumToolRiskRequiringApproval: v } })} /><div className="save-state">{saving ? '正在保存…' : saved ? '策略已保存' : '修改后自动保存'}</div></section><aside className="card notice"><ShieldCheck /><h3>默认拒绝</h3><p>无法匹配策略或审批超时的操作将被拒绝。每次决策均记录操作者、时间和资源范围。</p></aside></div>}</Resource></PageFrame>;
}
function PolicyRisk({ value, onChange }: { value: ApprovalPolicy['approvalPolicy']['minimumToolRiskRequiringApproval']; onChange: (x: ApprovalPolicy['approvalPolicy']['minimumToolRiskRequiringApproval']) => void }) { return <PolicyRow title="工具审批风险阈值" description="达到此风险级别的工具调用必须审批"><select value={value} onChange={e => onChange(e.target.value as ApprovalPolicy['approvalPolicy']['minimumToolRiskRequiringApproval'])}><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option><option value="critical">严重风险</option></select></PolicyRow>; }

function AuditPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.auditLogs(), [api]);
  return <PageFrame title="审计日志" subtitle="追踪管理操作、权限决策和配置变更" action={<RefreshButton onClick={state.reload} />}><Resource state={state} empty="暂无审计事件。">{logs => <div className="card audit-list">{logs.map(log => <AuditRow key={log.id} log={log} />)}</div>}</Resource></PageFrame>;
}
function AuditRow({ log }: { log: AuditLog }) { return <div className="audit-row"><span className="result success"><CheckCircle2 /></span><div className="grow"><strong>{log.actorUserId ?? '系统'} · {log.action}</strong><p>{log.resourceType}{log.resourceId ? ` / ${log.resourceId}` : ''}</p></div><div className="audit-meta"><span>{formatDate(log.occurredAt)}</span><small>{Object.keys(log.payload).length ? '包含操作详情' : '无附加数据'}</small></div></div>; }

function PageFrame({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) { return <><div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>{children}</>; }
function Resource<T>({ state, children, empty = '暂无数据。' }: { state: { data?: T; loading: boolean; error: string; reload: () => void }; children: (data: T) => ReactNode; empty?: string }) { if (state.loading) return <div className="resource"><Spinner /><span>正在加载…</span></div>; if (state.error) return <div className="resource error"><AlertTriangle /><strong>加载失败</strong><span>{state.error}</span><button className="button secondary" onClick={state.reload}>重试</button></div>; if (Array.isArray(state.data) && state.data.length === 0) return <div className="resource empty"><ScrollText /><strong>{empty}</strong></div>; return state.data === undefined ? null : <>{children(state.data)}</>; }
function Metric({ label, value, icon, tone }: { label: string; value: string | number; icon: ReactNode; tone: string }) { return <article className="metric card"><span className={`metric-icon ${tone}`}>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></article>; }
function Health({ label, value, ok }: { label: string; value: number; ok: boolean }) { return <div><span>{ok ? <CheckCircle2 className="success" /> : <AlertTriangle className="warning" />}{label}</span><strong>{value}</strong></div>; }
function CardTitle({ title, subtitle }: { title: string; subtitle: string }) { return <div className="card-title"><h3>{title}</h3><p>{subtitle}</p></div>; }
function PolicyRow({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <div className="policy-row"><div><strong>{title}</strong><p>{description}</p></div>{children}</div>; }
function Badge({ children, tone }: { children: ReactNode; tone: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
function RefreshButton({ onClick }: { onClick: () => void }) { return <button className="button secondary" onClick={onClick}><RefreshCw />刷新</button>; }
function Spinner() { return <RefreshCw className="spinner" />; }
function Centered({ children }: { children: ReactNode }) { return <main className="centered">{children}</main>; }
function AuthGate({ mode, canRegister, error, busy, onLogin, onRegister, onToggle }: {
  mode: 'login' | 'register'; canRegister: boolean; error?: string; busy: boolean;
  onLogin(username: string, password: string): Promise<void>;
  onRegister(username: string, password: string, displayName: string): Promise<void>;
  onToggle(): void;
}) {
  const register = mode === 'register';
  return <main className="setup"><section className="setup-intro"><span className="brand-mark"><Bot /></span><h1>{register ? '创建管理员账号' : '登录管理中心'}</h1><p>{register ? '第一个注册的用户会成为超级管理员，之后是否开放注册由超级管理员决定。' : '使用用户名和密码管理组织、模型和成员。'}</p></section><section className="card setup-card">
    <small>{register ? '首次设置' : '账号登录'}</small>
    <h2>{register ? '注册' : '登录'}</h2>
    <form onSubmit={e => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      const username = String(data.get('username') ?? '').trim();
      const password = String(data.get('password') ?? '');
      const displayName = String(data.get('displayName') ?? '').trim();
      if (register) void onRegister(username, password, displayName);
      else void onLogin(username, password);
    }}>
      <label>用户名<input name="username" required autoFocus pattern="[A-Za-z][A-Za-z0-9_-]{2,31}" autoComplete="username" /></label>
      {register && <label>显示名称（可选）<input name="displayName" autoComplete="nickname" /></label>}
      <label>密码<input name="password" type="password" required minLength={8} autoComplete={register ? 'new-password' : 'current-password'} /></label>
      {error && <span className="form-error">{error}</span>}
      <button className="button wide" disabled={busy}>{busy ? '请稍候…' : register ? '注册并进入' : '登录'}</button>
    </form>
    {canRegister && <p className="setup-switch">{register ? '已有账号？' : '还没有账号？'}<button type="button" className="gate-link" onClick={onToggle}>{register ? '去登录' : '注册'}</button></p>}
  </section></main>;
}
function workbenchUrl() {
  const url = new URL(location.href);
  if (url.port === '8788') url.port = '8787';
  return url.origin;
}
function formatDate(value?: string) { return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'; }
function messageOf(error: unknown) { return error instanceof AdminApiError || error instanceof Error ? error.message : '发生未知错误'; }
