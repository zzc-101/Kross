import { useState, type FormEvent } from 'react';
import { Archive, Bot, Boxes, CircleAlert, FileText, FolderKanban, LoaderCircle, Play, Plus, Square, Wifi, WifiOff } from 'lucide-react';
import type { ApprovalSummary } from '@kross/protocol';

import { useWorkbench } from './useWorkbench';

export function App({ devUserId, onChangeIdentity }: { devUserId: string; onChangeIdentity(): void }) {
  const workbench = useWorkbench(devUserId);
  const [newProject, setNewProject] = useState(false);
  const [newTask, setNewTask] = useState(false);

  if (workbench.loading) return <StatePage icon={<LoaderCircle className="spin" />} title="正在进入工作空间" detail="正在加载身份与组织信息…" />;
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/"><span>K</span><div><strong>Kross Work</strong><small>让 Agent 把工作交付出来</small></div></a>
        <div className="top-actions">
          <span className={`connection ${workbench.connection}`}>{workbench.connection === 'connected' ? <Wifi size={14} /> : <WifiOff size={14} />}{connectionLabel(workbench.connection)}</span>
          <button className="ghost" onClick={onChangeIdentity}>{devUserId}</button>
        </div>
      </header>
      {workbench.error && <div className="error-banner" role="alert"><CircleAlert size={17} />{workbench.error}</div>}
      <main className="workspace">
        <aside className="sidebar">
          <div className="section-title"><span>项目</span><button aria-label="创建项目" onClick={() => setNewProject(true)}><Plus size={16} /></button></div>
          {workbench.projects.length === 0 ? <Empty compact title="还没有项目" detail="创建一个普通项目开始工作。" /> : workbench.projects.map((project) => (
            <button key={project.id} className={`nav-item ${workbench.projectId === project.id ? 'active' : ''}`} onClick={() => workbench.setProjectId(project.id)}>
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
          {!workbench.task ? <Empty hero title="选择一个任务" detail="任务是目标、资料、运行记录和最终交付物的长期容器。" /> : (
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
            </>
          )}
        </section>
        <aside className="inspector">
          <InspectorSection icon={<Boxes size={16} />} title="资料" empty="项目还没有可用资料">{workbench.sources.map((source) => <Resource key={source.id} name={source.displayName} meta={`${source.kind} · ${statusLabel(source.status)}`} />)}</InspectorSection>
          <InspectorSection icon={<Archive size={16} />} title="交付物" empty="运行完成后在这里查看交付物">{workbench.artifacts.map((artifact) => <Resource key={artifact.id} name={artifact.displayName} meta={`${artifact.kind} · ${statusLabel(artifact.status)}`} />)}</InspectorSection>
          <InspectorSection icon={<CircleAlert size={16} />} title="审批" empty="当前没有待处理审批">{workbench.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onDecide={workbench.decideApproval} />)}</InspectorSection>
          {workbench.runState.run && <InspectorSection icon={<Bot size={16} />} title="当前运行"><dl className="run-meta"><div><dt>状态</dt><dd>{statusLabel(workbench.runState.run.status)}</dd></div><div><dt>模式</dt><dd>{workbench.runState.run.mode === 'plan' ? '只做计划' : '自动执行'}</dd></div><div><dt>尝试</dt><dd>#{workbench.runState.run.attempt}</dd></div></dl></InspectorSection>}
        </aside>
      </main>
      {newProject && <CreateDialog title="创建项目" fields={[['name', '项目名称'], ['description', '项目说明（可选）']]} onClose={() => setNewProject(false)} onSubmit={(data) => workbench.createProject(data.name ?? '')} />}
      {newTask && <CreateDialog title="创建任务" fields={[['title', '任务标题'], ['objective', '明确描述目标和期望交付']]} textarea="objective" onClose={() => setNewTask(false)} onSubmit={(data) => workbench.createTask(data.title ?? '', data.objective ?? '')} />}
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

function InspectorSection({ icon, title, empty, children }: { icon: React.ReactNode; title: string; empty?: string; children?: React.ReactNode }) { return <section className="inspect-section"><h2>{icon}{title}</h2>{children ? <div className="resource-list">{children}</div> : empty && <p className="muted">{empty}</p>}</section>; }
function Resource({ name, meta }: { name: string; meta: string }) { return <div className="resource"><div className="resource-icon"><FileText size={16} /></div><div><strong>{name}</strong><small>{meta}</small></div></div>; }
function Empty({ title, detail, compact, hero }: { title: string; detail: string; compact?: boolean; hero?: boolean }) { return <div className={`empty ${compact ? 'compact' : ''} ${hero ? 'hero' : ''}`}><div className="empty-mark">K</div><strong>{title}</strong><p>{detail}</p></div>; }
function StatePage({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) { return <main className="state-page">{icon}<h1>{title}</h1><p>{detail}</p></main>; }
function statusLabel(value: string) { return ({ open: '进行中', completed: '已完成', cancelled: '已取消', archived: '已归档', queued: '排队中', provisioning: '准备中', running: '运行中', waiting_for_approval: '等待审批', cancelling: '取消中', failed: '失败', ready: '可用', pending: '处理中', processing: '处理中', uploading: '上传中', approved: '已批准', rejected: '已拒绝', expired: '已过期' } as Record<string, string>)[value] ?? value; }
function phaseLabel(value: string) { return ({ planning: '制定计划', gathering_sources: '整理资料', executing: '执行任务', using_tool: '使用工具', waiting_for_approval: '等待审批', creating_artifact: '生成交付物', verifying: '验证结果', finalizing: '整理结果' } as Record<string, string>)[value] ?? value; }
function connectionLabel(value: string) { return value === 'connected' ? '实时连接' : value === 'retrying' ? '正在重连' : '正在连接'; }
function riskLabel(value: string) { return ({ low: '低', medium: '中', high: '高', critical: '严重' } as Record<string, string>)[value] ?? value; }
function approvalKindLabel(value: string) { return ({ plan: '执行计划', tool: '工具调用', external_action: '外部动作', elevated_access: '提升权限' } as Record<string, string>)[value] ?? value; }
