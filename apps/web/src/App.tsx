import { useState, type FormEvent } from 'react';
import { Archive, Bot, Boxes, CircleAlert, Clock3, Download, FileText, FolderKanban, Home, LoaderCircle, Play, Plus, Square, Upload, Wifi, WifiOff } from 'lucide-react';
import type { ApprovalSummary } from '@kross/protocol';

import { useWorkbench } from './useWorkbench';

export function App({ devUserId, onChangeIdentity }: { devUserId: string; onChangeIdentity(): void }) {
  const workbench = useWorkbench(devUserId);
  const [newProject, setNewProject] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [newSource, setNewSource] = useState(false);

  if (workbench.loading) return <StatePage icon={<LoaderCircle className="spin" />} title="正在进入工作空间" detail="正在加载身份与组织信息…" />;
  if (workbench.needsOrganization) {
    return <OrganizationSetup
      devUserId={devUserId}
      error={workbench.error}
      onChangeIdentity={onChangeIdentity}
      onCreate={(name, slug) => workbench.bootstrapOrganization(name, slug)}
    />;
  }
  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand brand-button" onClick={workbench.showHome}><span>K</span><div><strong>Kross Work</strong><small>让 Agent 把工作交付出来</small></div></button>
        <div className="top-actions">
          <span className={`connection ${workbench.connection}`}>{workbench.connection === 'connected' ? <Wifi size={14} /> : <WifiOff size={14} />}{connectionLabel(workbench.connection)}</span>
          <select className="organization-picker" aria-label="切换组织" value={workbench.organizationId} onChange={(event) => workbench.selectOrganization(event.target.value)}>{workbench.memberships.map((membership) => <option value={membership.organizationId} key={membership.id}>{membership.organizationId} · {roleLabel(membership.role)}</option>)}</select>
          <button className="ghost" onClick={onChangeIdentity}>{devUserId}</button>
        </div>
      </header>
      {workbench.error && <div className="error-banner" role="alert"><CircleAlert size={17} />{workbench.error}</div>}
      <main className="workspace">
        <aside className="sidebar">
          <button className={`nav-item home-nav ${workbench.route.view === 'home' ? 'active' : ''}`} onClick={workbench.showHome}><Home size={17} /><span>概览</span></button>
          <div className="section-title"><span>项目</span><button aria-label="创建项目" onClick={() => setNewProject(true)}><Plus size={16} /></button></div>
          {workbench.projects.length === 0 ? <Empty compact title="还没有项目" detail="创建一个普通项目开始工作。" /> : workbench.projects.map((project) => (
            <button key={project.id} className={`nav-item ${workbench.route.view === 'task' && workbench.projectId === project.id ? 'active' : ''}`} onClick={() => workbench.selectProject(project.id)}>
              <FolderKanban size={17} /><span>{project.name}</span><small>{project.kind === 'general' ? '普通' : '仓库'}</small>
            </button>
          ))}
          <div className="section-title task-title"><span>任务</span><button aria-label="创建任务" disabled={!workbench.projectId} onClick={() => setNewTask(true)}><Plus size={16} /></button></div>
          {workbench.tasks.map((task) => (
            <button key={task.id} className={`task-item ${workbench.task?.id === task.id ? 'active' : ''}`} onClick={() => void workbench.selectTask(task.id)}>
              <span>{task.title}</span><small><i className={`status-dot ${task.status}`} />{statusLabel(task.status)}</small>
            </button>
          ))}
        </aside>
        <section className="task-stage">
          {workbench.route.view === 'home' ? <HomeView projects={workbench.projects} tasks={workbench.tasks} onOpenProject={workbench.selectProject} onCreateProject={() => setNewProject(true)} /> : !workbench.task ? <Empty hero title="选择一个任务" detail="任务是目标、资料、运行记录和最终交付物的长期容器。" /> : (
            <>
              <div className="task-header">
                <div><span className="eyebrow">{workbench.task.type} · {statusLabel(workbench.task.status)}</span><h1>{workbench.task.title}</h1><p>{workbench.task.objective}</p></div>
                <div className="run-actions">
                  {workbench.runState.run && !['completed', 'failed', 'cancelled'].includes(workbench.runState.run.status)
                    ? <button className="secondary" onClick={() => void workbench.cancelRun()}><Square size={15} />取消运行</button>
                    : <><button className="secondary" onClick={() => void workbench.startRun('plan')}><FileText size={15} />只做计划</button><button className="primary" onClick={() => void workbench.startRun('auto')}><Play size={15} />执行任务</button></>}
                </div>
              </div>
              <div className="conversation">
                <article className="message user"><span className="avatar">你</span><div><strong>目标</strong><p>{workbench.task.objective}</p></div></article>
                {workbench.messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span className="avatar">{message.role === 'agent' ? <Bot size={18} /> : message.role === 'user' ? '你' : '系'}</span><div>{message.content.map((block, index) => block.type === 'text' ? <p key={index}>{block.text}</p> : <span className="reference" key={index}>{block.label ?? (block.type === 'source_reference' ? '资料' : '交付物')}</span>)}</div></article>)}
                {Object.entries(workbench.runState.drafts).map(([id, text]) => <article className="message agent streaming" key={id}><span className="avatar"><Bot size={18} /></span><div><p>{text}</p><i /></div></article>)}
                {workbench.runState.progress && <div className="progress-card"><LoaderCircle className="spin" size={18} /><div><strong>{phaseLabel(workbench.runState.progress.phase)}</strong><p>{workbench.runState.progress.message}</p>{workbench.runState.progress.percent !== undefined && <div className="progress-track"><span style={{ width: `${workbench.runState.progress.percent}%` }} /></div>}</div></div>}
              </div>
              <Composer onSubmit={workbench.appendMessage} />
            </>
          )}
        </section>
        <aside className="inspector">
          <InspectorSection icon={<Boxes size={16} />} title="资料" action={<button className="icon-button" aria-label="添加资料" disabled={!workbench.projectId} onClick={() => setNewSource(true)}><Plus size={15} /></button>} empty="项目还没有可用资料">{workbench.sources.map((source) => <Resource key={source.id} name={source.displayName} meta={`${source.kind} · ${statusLabel(source.status)}${source.sizeBytes != null ? ` · ${formatBytes(source.sizeBytes)}` : ''}`} />)}</InspectorSection>
          <InspectorSection icon={<Archive size={16} />} title="交付物" empty="运行完成后在这里查看交付物">{workbench.artifacts.map((artifact) => <Resource key={artifact.id} name={artifact.displayName} meta={`${artifact.kind} · ${statusLabel(artifact.status)}`} action={artifact.status === 'ready' ? <button className="icon-button" aria-label={`打开 ${artifact.displayName}`} onClick={() => void workbench.openArtifact(artifact.id)}><Download size={14} /></button> : undefined} />)}</InspectorSection>
          <InspectorSection icon={<CircleAlert size={16} />} title="审批" empty="当前没有待处理审批">{workbench.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onDecide={workbench.decideApproval} />)}</InspectorSection>
          {workbench.runState.run && <InspectorSection icon={<Bot size={16} />} title="运行详情"><dl className="run-meta"><div><dt>状态</dt><dd>{statusLabel(workbench.runState.run.status)}</dd></div><div><dt>模式</dt><dd>{workbench.runState.run.mode === 'plan' ? '只做计划' : '自动执行'}</dd></div><div><dt>尝试</dt><dd>#{workbench.runState.run.attempt}</dd></div><div><dt>运行 ID</dt><dd title={workbench.runState.run.id}>{shortId(workbench.runState.run.id)}</dd></div>{workbench.runState.run.startedAt && <div><dt>开始</dt><dd>{formatTime(workbench.runState.run.startedAt)}</dd></div>}{workbench.runState.lastEventId && <div><dt>最新事件</dt><dd title={workbench.runState.lastEventId}>{shortId(workbench.runState.lastEventId)}</dd></div>}</dl>{Object.values(workbench.runState.tools).length > 0 && <div className="tool-events"><strong><Clock3 size={13} />工具事件</strong>{Object.values(workbench.runState.tools).map((tool) => <div key={tool.toolCallId}><span>{tool.displayName || tool.name}</span><small>{statusLabel(tool.status)}</small></div>)}</div>}</InspectorSection>}
        </aside>
      </main>
      {newProject && <CreateDialog title="创建项目" fields={[['name', '项目名称'], ['description', '项目说明（可选）']]} onClose={() => setNewProject(false)} onSubmit={(data) => workbench.createProject(data.name ?? '')} />}
      {newTask && <CreateDialog title="创建任务" fields={[['title', '任务标题'], ['objective', '明确描述目标和期望交付']]} textarea="objective" onClose={() => setNewTask(false)} onSubmit={(data) => workbench.createTask(data.title ?? '', data.objective ?? '')} />}
      {newSource && <SourceDialog onClose={() => setNewSource(false)} onUpload={workbench.uploadSource} onInline={workbench.createInlineSource} />}
    </div>
  );
}

export function ApprovalCard({ approval, onDecide }: {
  approval: ApprovalSummary;
  onDecide(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string
  ): Promise<void>;
}) {
  const [choice, setChoice] = useState<'approved' | 'rejected'>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = approval.status === 'pending';
  const requiresReason = choice === 'rejected';

  async function confirm(): Promise<void> {
    if (!choice || (requiresReason && !reason.trim())) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDecide(approval.id, choice, reason);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '审批提交失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return <article className={`approval risk-${approval.riskLevel}`}>
    <div className="approval-heading">
      <span className={`risk ${approval.riskLevel}`}>{riskLabel(approval.riskLevel)}风险</span>
      <span className="approval-kind">{approvalKindLabel(approval.kind)}</span>
    </div>
    <strong>{approval.actionPreview}</strong>
    {approval.expiresAt && <p>有效期至 {new Date(approval.expiresAt).toLocaleString('zh-CN')}</p>}
    {!pending && <p className="decision-status">{statusLabel(approval.status)}</p>}
    {pending && !choice && <div className="approval-actions">
      <button className="approve" disabled={busy} onClick={() => setChoice('approved')}>批准</button>
      <button className="reject" disabled={busy} onClick={() => setChoice('rejected')}>拒绝</button>
    </div>}
    {pending && choice && <div className="approval-confirm">
      <p className="confirm-copy">确认{choice === 'approved' ? '批准这项动作' : '拒绝这项动作'}？服务端将记录本次决定。</p>
      <label><span>{requiresReason ? '拒绝理由（必填）' : '备注（可选）'}</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2_000} disabled={busy} /></label>
      {error && <p className="approval-error" role="alert">{error}</p>}
      <div className="approval-actions">
        <button className="ghost" disabled={busy} onClick={() => { setChoice(undefined); setError(undefined); }}>返回</button>
        <button className={choice === 'approved' ? 'approve' : 'reject'} disabled={busy || (requiresReason && !reason.trim())} onClick={() => void confirm()}>{busy ? '提交中…' : '确认提交'}</button>
      </div>
    </div>}
  </article>;
}

function CreateDialog({ title, fields, textarea, onClose, onSubmit }: { title: string; fields: Array<[string, string]>; textarea?: string; onClose(): void; onSubmit(data: Record<string, string>): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="dialog" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); const data = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>; void onSubmit(data).finally(() => { setBusy(false); onClose(); }); }}><h2>{title}</h2>{fields.map(([name, label]) => <label key={name}><span>{label}</span>{textarea === name ? <textarea name={name} required /> : <input name={name} required={name !== 'description'} autoFocus={name === fields[0]?.[0]} />}</label>)}<div className="dialog-actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '创建中…' : '创建'}</button></div></form></div>;
}

function HomeView({ projects, tasks, onOpenProject, onCreateProject }: { projects: Array<{ id: string; name: string; description?: string }>; tasks: Array<{ id: string; status: string }>; onOpenProject(id: string): void; onCreateProject(): void }) {
  return <div className="home-view"><span className="eyebrow">Workspace overview</span><h1>今天想交付什么？</h1><p>从一个项目开始，把目标、资料、运行和交付物留在同一个工作空间。</p><div className="stat-grid"><div><strong>{projects.length}</strong><span>项目</span></div><div><strong>{tasks.length}</strong><span>当前项目任务</span></div><div><strong>{tasks.filter((task) => task.status === 'open').length}</strong><span>进行中</span></div></div><div className="home-heading"><h2>最近项目</h2><button className="primary" onClick={onCreateProject}><Plus size={15} />创建项目</button></div><div className="project-grid">{projects.map((project) => <button key={project.id} onClick={() => onOpenProject(project.id)}><FolderKanban size={20} /><strong>{project.name}</strong><span>{project.description || '进入项目查看任务与资料'}</span></button>)}</div></div>;
}

function Composer({ onSubmit }: { onSubmit(text: string): Promise<boolean> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() { if (!text.trim() || busy) return; setBusy(true); if (await onSubmit(text)) setText(''); setBusy(false); }
  return <div className="composer"><textarea aria-label="追加任务消息" placeholder="补充要求、反馈或下一步…" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} /><button className="primary" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? '发送中…' : '发送'}</button><small>Enter 发送 · Shift + Enter 换行</small></div>;
}

function SourceDialog({ onClose, onUpload, onInline }: { onClose(): void; onUpload(file: File): Promise<boolean>; onInline(name: string, content: string): Promise<boolean> }) {
  const [mode, setMode] = useState<'file' | 'inline'>('file');
  const [file, setFile] = useState<File>();
  const [name, setName] = useState('工作说明.txt');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); const ok = mode === 'file' ? file ? await onUpload(file) : false : await onInline(name.trim(), content.trim()); setBusy(false); if (ok) onClose(); }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="dialog source-dialog" onSubmit={(event) => void submit(event)}><h2>添加资料</h2><div className="source-tabs"><button type="button" className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}><Upload size={15} />上传文件</button><button type="button" className={mode === 'inline' ? 'active' : ''} onClick={() => setMode('inline')}><FileText size={15} />粘贴文本</button></div>{mode === 'file' ? <label className="file-drop"><Upload size={22} /><span>{file ? file.name : '选择不超过 100 MB 的文件'}</span><input type="file" onChange={(event) => setFile(event.target.files?.[0])} required /></label> : <><label><span>资料名称</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label><label><span>文本内容</span><textarea value={content} onChange={(event) => setContent(event.target.value)} required /></label></>}<div className="dialog-actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={busy || (mode === 'file' ? !file : !name.trim() || !content.trim())}>{busy ? '处理中…' : '添加资料'}</button></div></form></div>;
}

function InspectorSection({ icon, title, action, empty, children }: { icon: React.ReactNode; title: string; action?: React.ReactNode; empty?: string; children?: React.ReactNode }) { return <section className="inspect-section"><div className="inspect-heading"><h2>{icon}{title}</h2>{action}</div>{children ? <div className="resource-list">{children}</div> : empty && <p className="muted">{empty}</p>}</section>; }
function Resource({ name, meta, action }: { name: string; meta: string; action?: React.ReactNode }) { return <div className="resource"><div className="resource-icon"><FileText size={16} /></div><div><strong>{name}</strong><small>{meta}</small></div>{action}</div>; }
function Empty({ title, detail, compact, hero }: { title: string; detail: string; compact?: boolean; hero?: boolean }) { return <div className={`empty ${compact ? 'compact' : ''} ${hero ? 'hero' : ''}`}><div className="empty-mark">K</div><strong>{title}</strong><p>{detail}</p></div>; }
function StatePage({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) { return <main className="state-page">{icon}<h1>{title}</h1><p>{detail}</p></main>; }
function OrganizationSetup({ devUserId, error, onChangeIdentity, onCreate }: {
  devUserId: string; error?: string; onChangeIdentity(): void;
  onCreate(name: string, slug: string): Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  function updateName(value: string) {
    setName(value);
    setSlug(slugFromName(value));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await onCreate(name.trim(), slug.trim());
    setBusy(false);
  }
  return <main className="identity-page"><form onSubmit={(event) => void submit(event)}>
    <div className="empty-mark">K</div>
    <h1>创建第一个组织</h1>
    <p>工作台和管理端需要同一个开发用户 ID（当前为 {devUserId}）。创建组织后即可添加项目、配置模型并执行任务。</p>
    <label><span>组织名称</span><input required value={name} onChange={(event) => updateName(event.target.value)} autoFocus /></label>
    <label><span>组织标识</span><input required minLength={2} pattern="[a-z0-9][a-z0-9-]{1,62}" value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
    {error && <p className="approval-error" role="alert">{error}</p>}
    <button className="primary" disabled={busy}>{busy ? '正在创建…' : '创建并进入工作台'}</button>
    <button type="button" className="ghost" onClick={onChangeIdentity}>切换开发身份</button>
  </form></main>;
}
function slugFromName(value: string): string {
  const ascii = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return ascii.length >= 2 ? ascii : `org-${Math.random().toString(36).slice(2, 10)}`;
}
function statusLabel(value: string) { return ({ open: '进行中', completed: '已完成', cancelled: '已取消', archived: '已归档', queued: '排队中', provisioning: '准备中', running: '运行中', waiting_for_approval: '等待审批', cancelling: '取消中', failed: '失败', ready: '可用', pending: '处理中', processing: '处理中', uploading: '上传中', approved: '已批准', rejected: '已拒绝', expired: '已过期' } as Record<string, string>)[value] ?? value; }
function phaseLabel(value: string) { return ({ planning: '制定计划', gathering_sources: '整理资料', executing: '执行任务', using_tool: '使用工具', waiting_for_approval: '等待审批', creating_artifact: '生成交付物', verifying: '验证结果', finalizing: '整理结果' } as Record<string, string>)[value] ?? value; }
function connectionLabel(value: string) { return value === 'connected' ? '实时连接' : value === 'retrying' ? '正在重连' : '正在连接'; }
function riskLabel(value: string) { return ({ low: '低', medium: '中', high: '高', critical: '严重' } as Record<string, string>)[value] ?? value; }
function approvalKindLabel(value: string) { return ({ plan: '执行计划', tool: '工具调用', external_action: '外部动作', elevated_access: '提升权限' } as Record<string, string>)[value] ?? value; }
function roleLabel(value: string) { return ({ owner: '所有者', admin: '管理员', member: '成员', viewer: '访客' } as Record<string, string>)[value] ?? value; }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`; }
function shortId(value: string) { return value.length > 12 ? `${value.slice(0, 8)}…` : value; }
function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
