import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, Bot, CheckCircle2, ChevronDown, CircleDollarSign, Cpu,
  LayoutDashboard, Menu, Plus, Plug, RefreshCw, ScrollText, ShieldCheck, Users, X, XCircle
} from 'lucide-react';
import { AdminApiClient, AdminApiError } from './apiClient';
import type { ApprovalPolicy, AuditLog, Bootstrap, Connector, Dashboard, Member, ModelConfig } from './contracts';

type Page = 'dashboard' | 'members' | 'models' | 'connectors' | 'policy' | 'audit';
const navigation: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: '概览', icon: LayoutDashboard },
  { id: 'members', label: '成员与角色', icon: Users },
  { id: 'models', label: '模型配置', icon: Cpu },
  { id: 'connectors', label: '连接器', icon: Plug },
  { id: 'policy', label: '审批策略', icon: ShieldCheck },
  { id: 'audit', label: '审计日志', icon: ScrollText }
];

export function App({ devUserId, onChangeIdentity }: { devUserId: string; onChangeIdentity: (id: string) => void }) {
  const [identity, setIdentity] = useState(devUserId);
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [organizationId, setOrganizationId] = useState('');
  const [page, setPage] = useState<Page>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const api = useMemo(() => new AdminApiClient({ devUserId }), [devUserId]);

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    api.me().then(data => {
      if (!active) return;
      const firstOrganizationId = data.memberships[0]?.organizationId || '';
      if (firstOrganizationId) api.selectOrganization(firstOrganizationId);
      setBootstrap(data); setOrganizationId(current => current || firstOrganizationId);
    }).catch(e => active && setError(messageOf(e))).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [api]);
  useEffect(() => { if (organizationId) api.selectOrganization(organizationId); }, [api, organizationId]);

  if (loading) return <Centered><Spinner /><h2>正在进入管理中心</h2><p>正在验证身份与组织权限…</p></Centered>;
  if (error) return <Centered><XCircle size={34} /><h2>无法进入管理中心</h2><p>{error}</p><button className="button" onClick={() => location.reload()}>重新加载</button></Centered>;
  if (!bootstrap?.memberships.length) return <OrganizationSetup api={api} identity={identity} setIdentity={setIdentity} changeIdentity={onChangeIdentity} done={data => { const id = data.memberships[0]?.organizationId ?? ''; if (id) api.selectOrganization(id); setBootstrap(data); setOrganizationId(id); }} />;

  const currentMembership = bootstrap.memberships.find(m => m.organizationId === organizationId);
  return <div className="shell">
    <aside className={sidebarOpen ? 'sidebar open' : 'sidebar'}>
      <div className="brand"><span className="brand-mark"><Bot /></span><div><strong>Kross</strong><small>管理中心</small></div><button className="icon mobile-close" onClick={() => setSidebarOpen(false)}><X /></button></div>
      <nav>{navigation.map(item => <button key={item.id} className={page === item.id ? 'nav-item active' : 'nav-item'} onClick={() => { setPage(item.id); setSidebarOpen(false); }}><item.icon />{item.label}</button>)}</nav>
      <div className="sidebar-foot"><span className="avatar">{bootstrap.user.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{bootstrap.user.displayName}</strong><small>{currentMembership?.role ?? 'member'}</small></div></div>
    </aside>
    <main>
      <header className="topbar"><button className="icon mobile-menu" onClick={() => setSidebarOpen(true)}><Menu /></button><div className="organization"><small>当前组织</small><select aria-label="选择组织" value={organizationId} onChange={e => { api.selectOrganization(e.target.value); setOrganizationId(e.target.value); }}>{bootstrap.memberships.map(m => <option key={m.id} value={m.organizationId}>{m.organizationId}</option>)}</select><ChevronDown /></div><div className="environment"><span />本地开发环境</div></header>
      <div className="content">
        {page === 'dashboard' && <DashboardPage api={api} />}
        {page === 'members' && <MembersPage api={api} />}
        {page === 'models' && <ModelsPage api={api} />}
        {page === 'connectors' && <ConnectorsPage api={api} />}
        {page === 'policy' && <PolicyPage api={api} />}
        {page === 'audit' && <AuditPage api={api} />}
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
    <div className="metrics"><Metric label="活跃成员" value={d.counts.activeMembers} icon={<Users />} tone="blue" /><Metric label="活跃项目" value={d.counts.activeProjects} icon={<LayoutDashboard />} tone="violet" /><Metric label="活跃运行" value={d.counts.activeRuns} icon={<Activity />} tone="green" /><Metric label="待审批" value={d.counts.pendingApprovals} icon={<ShieldCheck />} tone="amber" /></div>
    <div className="dashboard-grid"><section className="card"><CardTitle title="组织资源" subtitle="控制面当前可用资源" /><div className="health-list"><Health label="可用连接器" value={d.counts.activeConnectors} ok={d.counts.activeConnectors > 0} /><Health label="审批积压" value={d.counts.pendingApprovals} ok={d.counts.pendingApprovals < 5} /><Health label="运行中任务" value={d.counts.activeRuns} ok={true} /></div></section><section className="card callout"><Bot /><div><h3>Work Agent 控制面</h3><p>集中配置模型、访问能力与风险边界。所有管理操作都会进入审计日志。</p></div></section></div>
  </>}</Resource></PageFrame>;
}

function MembersPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.members(), [api]); const [showForm, setShowForm] = useState(false); const [busy, setBusy] = useState('');
  const change = async (member: Member, field: 'role' | 'status', value: string) => { setBusy(member.id); try { await api.updateMember(member.id, { [field]: value }); state.reload(); } finally { setBusy(''); } };
  return <PageFrame title="成员与角色" subtitle="管理组织成员的访问级别和账号状态" action={<button className="button" onClick={() => setShowForm(true)}><Plus />邀请成员</button>}>
    {showForm && <InviteForm api={api} close={() => setShowForm(false)} done={state.reload} />}
    <Resource state={state} empty="组织中还没有成员。">{members => <div className="card table-wrap"><table><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>更新时间</th></tr></thead><tbody>{members.map(m => <tr key={m.id}><td><div className="person"><span className="avatar">{m.displayName[0]}</span><div><strong>{m.displayName}</strong><small>{m.userId}</small></div></div></td><td><select disabled={busy === m.id} value={m.role} onChange={e => change(m, 'role', e.target.value)}><option value="owner">所有者</option><option value="admin">管理员</option><option value="member">成员</option><option value="viewer">访客</option></select></td><td><select disabled={busy === m.id} value={m.status} onChange={e => change(m, 'status', e.target.value)}><option value="active">正常</option><option value="invited">待加入</option><option value="disabled">已停用</option></select></td><td>{formatDate(m.updatedAt)}</td></tr>)}</tbody></table></div>}</Resource>
  </PageFrame>;
}

function InviteForm({ api, close, done }: { api: AdminApiClient; close: () => void; done: () => void }) {
  const [userId, setUserId] = useState(''); const [displayName, setDisplayName] = useState(''); const [role, setRole] = useState<Member['role']>('member'); const [error, setError] = useState('');
  const submit = async (e: FormEvent) => { e.preventDefault(); setError(''); try { await api.inviteMember({ userId, displayName, role }); close(); done(); } catch (x) { setError(messageOf(x)); } };
  return <form className="card inline-form" onSubmit={submit}><label>用户 ID<input required value={userId} onChange={e => setUserId(e.target.value)} placeholder="user-001" /></label><label>显示名称<input required value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="成员姓名" /></label><label>角色<select value={role} onChange={e => setRole(e.target.value as Member['role'])}><option value="admin">管理员</option><option value="member">成员</option><option value="viewer">访客</option></select></label><button className="button" type="submit">发送邀请</button><button className="button secondary" type="button" onClick={close}>取消</button>{error && <span className="form-error">{error}</span>}</form>;
}

function ModelsPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.models(), [api]); const [showForm, setShowForm] = useState(false);
  return <PageFrame title="模型配置" subtitle="录入供应商、模型 ID 和 API Key。密钥只写不读，界面不会回显明文。" action={<button className="button" onClick={() => setShowForm(true)}><Plus />添加模型</button>}>
    {showForm && <ModelForm api={api} close={() => setShowForm(false)} done={state.reload} />}
    <Resource state={state} empty="尚未配置模型。请先添加一个带 API Key 的模型，工作台才能执行任务。">{models => <div className="card-grid">{models.map(m => <article className="card model-card" key={m.id}><div className="card-icon"><Cpu /></div><div className="grow"><div className="title-line"><h3>{m.name}</h3><Badge tone={m.status === 'active' ? 'green' : 'neutral'}>{m.status === 'active' ? '已启用' : '已停用'}</Badge></div><p>{m.provider} · {m.model}</p><small>{m.credentialHandleId ? '已关联凭证' : '尚未关联凭证'} · 更新于 {formatDate(m.updatedAt)}</small></div><label className="switch"><input type="checkbox" checked={m.status === 'active'} onChange={() => api.updateModel(m.id, { status: m.status === 'active' ? 'disabled' : 'active' }).then(state.reload)} /><span /></label></article>)}</div>}</Resource>
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

function ConnectorsPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.connectors(), [api]);
  return <PageFrame title="连接器" subtitle="监控外部数据源的授权范围与连接状态" action={<RefreshButton onClick={state.reload} />}><Resource state={state} empty="尚未安装连接器。">{items => <div className="card-grid">{items.map(c => <ConnectorCard key={c.id} connector={c} />)}</div>}</Resource></PageFrame>;
}
function ConnectorCard({ connector: c }: { connector: Connector }) { const ok = c.status === 'available'; return <article className="card connector-card"><div className="connector-logo"><Plug /></div><div className="grow"><div className="title-line"><h3>{c.display_name}</h3><Badge tone={ok ? 'green' : 'amber'}>{ok ? '运行正常' : '不可用'}</Badge></div><p>{c.connector_name} · {c.granted_scopes.length ? c.granted_scopes.join('、') : '未授予访问范围'}</p><small>{c.last_error_code ? `错误：${c.last_error_code}` : `更新于 ${formatDate(c.updated_at)}`}</small></div></article>; }

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
function IdentityForm({ value, setValue, submit }: { value: string; setValue: (x: string) => void; submit: (x: string) => void }) { return <form className="identity-form" onSubmit={e => { e.preventDefault(); submit(value.trim()); }}><input required value={value} onChange={e => setValue(e.target.value)} aria-label="开发用户 ID" /><button className="button">切换开发身份</button></form>; }
function OrganizationSetup({ api, identity, setIdentity, changeIdentity, done }: { api: AdminApiClient; identity: string; setIdentity: (x: string) => void; changeIdentity: (x: string) => void; done: (x: Bootstrap) => void }) {
  const [name, setName] = useState(''); const [slug, setSlug] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const updateName = (value: string) => {
    setName(value);
    const ascii = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    setSlug(ascii.length >= 2 ? ascii : `org-${crypto.randomUUID().slice(0, 8)}`);
  };
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(''); try { done(await api.bootstrapOrganization({ organizationId: crypto.randomUUID(), name, slug, defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' })); } catch (x) { setError(messageOf(x)); } finally { setBusy(false); } };
  return <main className="setup"><section className="setup-intro"><span className="brand-mark"><Bot /></span><h1>建立你的管理空间</h1><p>创建第一个组织后，你将成为所有者，并可以邀请团队成员、配置模型和制定 Agent 的运行策略。</p><ul><li><ShieldCheck />权限边界和审批策略</li><li><Cpu />模型、成本与用量配置</li><li><ScrollText />完整的管理审计记录</li></ul></section><section className="card setup-card"><small>首次设置</small><h2>创建组织</h2><p>此信息之后仍可在组织设置中修改。</p><form onSubmit={submit}><label>组织名称<input autoFocus required value={name} onChange={e => updateName(e.target.value)} placeholder="例如：Kross 产品团队" /></label><label>组织标识<input required minLength={2} value={slug} onChange={e => setSlug(e.target.value)} placeholder="kross-team" /></label>{error && <span className="form-error">{error}</span>}<button className="button wide" disabled={busy}>{busy ? '正在创建…' : '创建并进入管理中心'}</button></form><div className="setup-divider">开发身份</div><IdentityForm value={identity} setValue={setIdentity} submit={changeIdentity} /></section></main>;
}
function formatDate(value?: string) { return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'; }
function messageOf(error: unknown) { return error instanceof AdminApiError || error instanceof Error ? error.message : '发生未知错误'; }
