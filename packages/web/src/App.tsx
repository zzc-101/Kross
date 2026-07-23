import ReactMarkdown from 'react-markdown';
import type {
  AgentResult,
  CloudWorkspace,
  WorkspaceProgress
} from '@kross/protocol';
import { memo, useEffect, useRef, useState, type FormEvent } from 'react';

import { SetupPanel } from './SetupPanel';
import { ActionDialog, type DialogAction } from './OperationDialog';
import { InspectionPanel } from './InspectionPanel';
import { applyPwaUpdate, installPwa, usePwa } from './pwa';
import { fetchSetupStatus, type SetupStatus } from './setupApi';
import { useCloud, type UiMessage } from './useCloud';

interface AppProps {
  endpoint: string;
  token: string;
  onLogout: () => void;
}

export function App({ endpoint, token, onLogout }: AppProps) {
  const cloud = useCloud(endpoint, token);
  const pwa = usePwa();
  const { state, client, connection } = cloud;
  const selectedWorkspace = state.workspaces.find(
    (workspace) => workspace.id === state.workspaceId
  );
  const [input, setInput] = useState('');
  const [mobilePanel, setMobilePanel] = useState<'chat' | 'sessions' | 'todo'>('chat');
  const [sessionQuery, setSessionQuery] = useState('');
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [dialogAction, setDialogAction] = useState<DialogAction>();
  const [setupStatus, setSetupStatus] = useState<SetupStatus>();
  const bottomRef = useRef<HTMLDivElement>(null);
  const visibleSessions = state.sessions.filter((session) => {
    const query = sessionQuery.trim().toLocaleLowerCase();
    return !query ||
      session.title.toLocaleLowerCase().includes(query) ||
      session.preview.toLocaleLowerCase().includes(query);
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages, state.running]);

  useEffect(() => {
    if (connection !== 'online') return;
    const parameters = new URLSearchParams(window.location.search);
    const action = parameters.get('approval');
    const workspaceId = parameters.get('workspace');
    const sessionId = parameters.get('session');
    const runId = parameters.get('runId');
    if (
      (action === 'approve' || action === 'reject') &&
      workspaceId &&
      sessionId &&
      runId
    ) {
      client.send({
        type: 'session.approval',
        workspaceId,
        sessionId,
        runId,
        approved: action === 'approve'
      });
      parameters.delete('approval');
      parameters.delete('runId');
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${parameters.size ? `?${parameters}` : ''}`
      );
    }
  }, [client, connection]);

  useEffect(() => {
    if (state.workspaceId && state.sessions.length === 0 && !state.snapshot) {
      cloud.selectWorkspace(state.workspaceId);
    }
  }, [cloud.selectWorkspace, state.snapshot, state.sessions.length, state.workspaceId]);

  useEffect(() => {
    if (connection !== 'online') return;
    void fetchSetupStatus(endpoint, token)
      .then(setSetupStatus)
      .catch(() => setSetupStatus(undefined));
  }, [connection, endpoint, token]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (!value || state.running) return;
    cloud.sendInput(value);
    setInput('');
  };

  const inspect = (kind: 'trace' | 'diff', argument?: string) => {
    if (!state.workspaceId || !state.snapshot) return;
    client.send({
      type: 'session.inspect',
      workspaceId: state.workspaceId,
      sessionId: state.snapshot.summary.id,
      kind,
      argument
    });
  };

  const enableNotifications = async () => {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const registration = await navigator.serviceWorker.register('/sw.js');
    const httpEndpoint = endpoint
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
      .replace(/\/ws$/, '');
    const response = await fetch(`${httpEndpoint}/api/config`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const config = await response.json() as { vapidPublicKey?: string };
    if (!config.vapidPublicKey) throw new Error('网关尚未配置 Web Push');
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(config.vapidPublicKey)
    });
    const serialized = subscription.toJSON();
    if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
      throw new Error('浏览器未返回完整的推送订阅');
    }
    client.send({
      type: 'push.subscribe',
      subscription: {
        endpoint: serialized.endpoint,
        expirationTime: serialized.expirationTime,
        keys: {
          p256dh: serialized.keys.p256dh,
          auth: serialized.keys.auth
        }
      }
    });
  };

  const pushBranch = () => {
    if (!state.workspaceId || !state.snapshot) return;
    setDialogAction({
      kind: 'git-push',
      remote: 'origin',
      branch: selectedWorkspace?.defaultBranch ?? 'main'
    });
  };

  const createPullRequest = () => {
    if (!state.workspaceId || !state.snapshot) return;
    setDialogAction({
      kind: 'git-pr',
      head: '',
      base: selectedWorkspace?.defaultBranch ?? 'main',
      title: state.snapshot.summary.title,
      body: ''
    });
  };

  const submitDialogAction = (action: DialogAction) => {
    if (action.kind === 'rename-session' && state.workspaceId) {
      client.send({
        type: 'session.rename',
        workspaceId: state.workspaceId,
        sessionId: action.sessionId,
        title: action.title.trim()
      });
    } else if (action.kind === 'delete-session' && state.workspaceId) {
      client.send({
        type: 'session.delete',
        workspaceId: state.workspaceId,
        sessionId: action.sessionId
      });
    } else if (
      action.kind === 'model' &&
      state.workspaceId &&
      state.snapshot
    ) {
      client.send({
        type: 'session.settings',
        workspaceId: state.workspaceId,
        sessionId: state.snapshot.summary.id,
        model: action.model.trim()
      });
    } else if (
      action.kind === 'git-push' &&
      state.workspaceId &&
      state.snapshot
    ) {
      client.send({
        type: 'git.push',
        workspaceId: state.workspaceId,
        sessionId: state.snapshot.summary.id,
        remote: action.remote.trim(),
        branch: action.branch.trim(),
        setUpstream: true
      });
    } else if (
      action.kind === 'git-pr' &&
      state.workspaceId &&
      state.snapshot
    ) {
      client.send({
        type: 'git.pull-request',
        workspaceId: state.workspaceId,
        sessionId: state.snapshot.summary.id,
        head: action.head.trim(),
        base: action.base.trim(),
        title: action.title.trim(),
        body: action.body
      });
    } else if (action.kind === 'delete-workspace') {
      client.send({
        type: 'workspace.delete',
        workspaceId: action.workspaceId,
        removeVolume: action.removeVolume
      });
    }
    setDialogAction(undefined);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span>K</span> Kross Cloud</div>
        <div
          className={`connection ${connection}`}
          role="status"
          aria-live="polite"
          title={connectionLabel(connection)}
        >
          {connectionLabel(connection)}
        </div>
        <select
          aria-label="工作区"
          value={state.workspaceId ?? ''}
          onChange={(event) => cloud.selectWorkspace(event.target.value)}
        >
          <option value="" disabled>选择工作区</option>
          {state.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name} · {workspace.status}
            </option>
          ))}
        </select>
        <button className="icon-button" onClick={() => setShowWorkspaceForm(true)}>＋ 工作区</button>
        <button
          className={`icon-button setup-button ${setupStatus?.ready ? 'ready' : 'attention'}`}
          onClick={() => setShowSetup(true)}
        >
          环境
        </button>
        {pwa.installable && !pwa.installed && (
          <button
            className="icon-button install-button"
            onClick={() => void installPwa()}
          >
            安装
          </button>
        )}
        <button className="icon-button muted" onClick={onLogout}>退出</button>
      </header>

      {(pwa.offline || pwa.updateAvailable) && (
        <div className={`app-banner ${pwa.updateAvailable ? 'update' : 'offline'}`}>
          <span>
            {pwa.updateAvailable
              ? 'Kross Cloud 有新版本可用。'
              : '网络已断开；操作会排队，并在恢复连接后发送。'}
          </span>
          {pwa.updateAvailable && (
            <button onClick={applyPwaUpdate}>更新并重新载入</button>
          )}
        </div>
      )}

      <main className="layout">
        <aside className={`sidebar ${mobilePanel === 'sessions' ? 'mobile-active' : ''}`}>
          <button
            className="primary full"
            disabled={!state.workspaceId}
            onClick={() => state.workspaceId && cloud.createSession(state.workspaceId)}
          >
            新建会话
          </button>
          <h2>会话</h2>
          <input
            className="session-search"
            type="search"
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={sessionQuery}
            onChange={(event) => setSessionQuery(event.target.value)}
          />
          <div className="session-list">
            {visibleSessions.map((session) => (
              <div
                className={`session-row ${
                  state.snapshot?.summary.id === session.id ? 'active' : ''
                }`}
                key={session.id}
              >
                <button
                  className="session-open"
                  onClick={() => {
                    if (state.workspaceId) {
                      cloud.resumeSession(state.workspaceId, session.id);
                      setMobilePanel('chat');
                    }
                  }}
                >
                  <strong>{session.title}</strong>
                  <small>{session.preview || '空会话'}</small>
                </button>
                <button
                  className="session-rename"
                  aria-label={`重命名会话 ${session.title}`}
                  title="重命名"
                  onClick={() => {
                    setDialogAction({
                      kind: 'rename-session',
                      sessionId: session.id,
                      title: session.title
                    });
                  }}
                >
                  ✎
                </button>
                <button
                  className="session-delete"
                  aria-label={`删除会话 ${session.title}`}
                  title="删除"
                  onClick={() =>
                    setDialogAction({
                      kind: 'delete-session',
                      sessionId: session.id,
                      title: session.title
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
            {visibleSessions.length === 0 && (
              <p className="quiet session-empty">没有匹配的会话。</p>
            )}
          </div>
          {selectedWorkspace && (
            <WorkspaceActions
              workspace={selectedWorkspace}
              onCommand={(command) => client.send(command)}
              onDelete={() => setDialogAction({
                kind: 'delete-workspace',
                workspaceId: selectedWorkspace.id,
                name: selectedWorkspace.name,
                removeVolume: false
              })}
            />
          )}
        </aside>

        <section className={`chat ${mobilePanel === 'chat' ? 'mobile-active' : ''}`}>
          {!state.snapshot ? (
            <EmptyState
              hasWorkspace={Boolean(state.workspaceId)}
              setupStatus={setupStatus}
              onCreate={() => state.workspaceId && cloud.createSession(state.workspaceId)}
              onAddWorkspace={() => setShowWorkspaceForm(true)}
              onOpenSetup={() => setShowSetup(true)}
            />
          ) : (
            <>
              <div className="chat-head">
                <div>
                  <h1>{state.snapshot.summary.title}</h1>
                  <small>{state.snapshot.model ?? '未配置模型'} · {state.snapshot.thinkingEffort}</small>
                </div>
                <div className="head-actions">
                  <select
                    aria-label="Agent 模式"
                    value={state.snapshot.mode}
                    onChange={(event) =>
                      client.send({
                        type: 'session.settings',
                        workspaceId: state.workspaceId!,
                        sessionId: state.snapshot!.summary.id,
                        mode: event.target.value as 'auto' | 'plan' | 'conductor'
                      })
                    }
                  >
                    <option value="auto">Auto</option>
                    <option value="plan">Plan</option>
                    <option value="conductor">Conductor</option>
                  </select>
                  <button className="desktop-action" onClick={() => inspect('diff')}>Diff</button>
                  <button className="desktop-action" onClick={() => inspect('trace')}>Trace</button>
                  <button className="desktop-action" onClick={pushBranch}>Push</button>
                  <button className="desktop-action" onClick={createPullRequest}>PR</button>
                  {'Notification' in window && <button className="desktop-action" onClick={() => void enableNotifications()}>通知</button>}
                  <button onClick={() => setDialogAction({
                    kind: 'model',
                    model: state.snapshot?.model ?? state.models[0]?.id ?? '',
                    options: state.models.map((model) => model.id)
                  })}>模型</button>
                  <select
                    value={state.snapshot.thinkingEffort ?? 'off'}
                    aria-label="思考强度"
                    onChange={(event) =>
                      client.send({
                        type: 'session.settings',
                        workspaceId: state.workspaceId!,
                        sessionId: state.snapshot!.summary.id,
                        thinkingEffort: event.target.value as SessionThinkingEffort
                      })
                    }
                  >
                    {['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((effort) => (
                      <option key={effort}>{effort}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="messages">
                {state.messages.map((message) => (
                  <Message key={message.id} message={message} />
                ))}
                {state.traces
                  .filter((trace) => trace.type.startsWith('tool_call.'))
                  .slice(-4)
                  .map((trace) => (
                    <ToolCard
                      key={trace.id}
                      type={trace.type}
                      payload={trace.payload}
                    />
                  ))}
                {state.running && (
                  <div className="running" role="status" aria-live="polite">
                    <i /> Agent 正在工作
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
              {state.snapshot.pendingApproval && (
                <ApprovalCard
                  title={`${state.snapshot.pendingApproval.toolName} 请求执行`}
                  detail={[
                    state.snapshot.pendingApproval.command,
                    state.snapshot.pendingApproval.workDir
                      ? `工作目录：${state.snapshot.pendingApproval.workDir}`
                      : undefined,
                    state.snapshot.pendingApproval.inputPreview
                  ].filter(Boolean).join('\n\n')}
                  risk={state.snapshot.pendingApproval.risk}
                  onChoose={(approved, reason) =>
                    client.send({
                      type: 'session.approval',
                      workspaceId: state.workspaceId!,
                      sessionId: state.snapshot!.summary.id,
                      runId: state.snapshot!.pendingApproval!.runId,
                      approved,
                      reason
                    })
                  }
                />
              )}
              {state.snapshot.pendingPlan && (
                <ApprovalCard
                  title="计划已就绪"
                  detail="确认后 Agent 将按上方计划继续执行。"
                  risk="plan"
                  onChoose={(approved) => {
                    const prompt =
                      state.snapshot?.pendingPlan?.goal ??
                      [...state.messages]
                        .reverse()
                        .find((item) => item.from === 'user')?.text;
                    client.send({
                      type: 'session.plan-approval',
                      workspaceId: state.workspaceId!,
                      sessionId: state.snapshot!.summary.id,
                      approved,
                      input: approved ? prompt : undefined
                    });
                  }}
                />
              )}
              <form className="composer" onSubmit={submit}>
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="告诉 Kross 要完成什么…"
                  rows={2}
                />
                {state.running ? (
                  <button
                    type="button"
                    className="danger"
                    onClick={() =>
                      client.send({
                        type: 'session.abort',
                        workspaceId: state.workspaceId!,
                        sessionId: state.snapshot!.summary.id
                      })
                    }
                  >
                    停止
                  </button>
                ) : <button className="primary">发送</button>}
              </form>
            </>
          )}
        </section>

        <aside className={`details ${mobilePanel === 'todo' ? 'mobile-active' : ''}`}>
          <div className="mobile-utilities">
            <button onClick={() => inspect('diff')}>Diff</button>
            <button onClick={() => inspect('trace')}>Trace</button>
            <button onClick={pushBranch}>Push</button>
            <button onClick={createPullRequest}>PR</button>
            {'Notification' in window && (
              <button onClick={() => void enableNotifications()}>通知</button>
            )}
          </div>
          <h2>进度</h2>
          <ExecutionSummary
            running={state.running}
            pendingApproval={Boolean(state.snapshot?.pendingApproval)}
            result={state.lastResult}
          />
          {state.snapshot?.todos.length ? state.snapshot.todos.map((todo) => (
            <div className={`todo ${todo.status}`} key={todo.id}>
              <span>{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○'}</span>
              <p>{todo.content}</p>
            </div>
          )) : <p className="quiet">Agent 创建任务后会显示在这里。</p>}
          <h2>工具活动</h2>
          {state.traces.slice(-12).reverse().map((trace) => (
            <div className="trace" key={trace.id}>
              <strong>{trace.type}</strong>
              <small>{String(trace.payload.toolName ?? trace.payload.name ?? '')}</small>
            </div>
          ))}
        </aside>
      </main>

      <nav className="mobile-nav">
        <button
          className={mobilePanel === 'sessions' ? 'active' : ''}
          aria-current={mobilePanel === 'sessions' ? 'page' : undefined}
          onClick={() => setMobilePanel('sessions')}
        >
          会话
        </button>
        <button
          className={mobilePanel === 'chat' ? 'active' : ''}
          aria-current={mobilePanel === 'chat' ? 'page' : undefined}
          onClick={() => setMobilePanel('chat')}
        >
          对话
        </button>
        <button
          className={mobilePanel === 'todo' ? 'active' : ''}
          aria-current={mobilePanel === 'todo' ? 'page' : undefined}
          onClick={() => setMobilePanel('todo')}
        >
          进度
        </button>
      </nav>

      {state.inspection && (
        <InspectionPanel
          inspection={state.inspection}
          onInspect={inspect}
          onClose={cloud.clearInspection}
        />
      )}
      {showWorkspaceForm && (
        <WorkspaceForm
          onClose={() => setShowWorkspaceForm(false)}
          onCreate={(name, gitUrl, defaultBranch, credential) => {
            client.send({
              type: 'workspace.create',
              name,
              gitUrl,
              defaultBranch: defaultBranch || undefined,
              credential
            });
            setShowWorkspaceForm(false);
          }}
        />
      )}
      {state.workspaceProgress && (
        <WorkspaceProgressPanel
          progress={state.workspaceProgress}
          onClose={cloud.clearWorkspaceProgress}
          onRetry={() => {
            cloud.clearWorkspaceProgress();
            setShowWorkspaceForm(true);
          }}
        />
      )}
      {showSetup && (
        <SetupPanel
          endpoint={endpoint}
          token={token}
          workspaceCount={state.workspaces.length}
          onClose={() => setShowSetup(false)}
          onStatus={setSetupStatus}
        />
      )}
      {dialogAction && (
        <ActionDialog
          key={`${dialogAction.kind}-${
            'sessionId' in dialogAction
              ? dialogAction.sessionId
              : 'workspaceId' in dialogAction
                ? dialogAction.workspaceId
                : ''
          }`}
          action={dialogAction}
          onSubmit={submitDialogAction}
          onClose={() => setDialogAction(undefined)}
        />
      )}
      {state.errors.length > 0 && (
        <div className="toast-stack" aria-live="assertive">
          {state.errors.map((error) => (
            <button
              className="toast"
              role="alert"
              key={error.id}
              onClick={() => cloud.clearError(error.id)}
            >
              {error.message}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type SessionThinkingEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const Message = memo(function Message({ message }: { message: UiMessage }) {
  return (
    <article className={`message ${message.from}`}>
      <label>{message.from === 'user' ? '你' : message.from === 'thinking' ? '思考' : 'Kross'}</label>
      {message.from === 'thinking' ? (
        <details><summary>查看思考过程</summary><pre>{message.text}</pre></details>
      ) : <ReactMarkdown>{message.text}</ReactMarkdown>}
    </article>
  );
});

function ToolCard({
  type,
  payload
}: {
  type: string;
  payload: Record<string, unknown>;
}) {
  const status = type.split('.').at(-1) ?? 'running';
  return (
    <section className={`tool-card ${status}`}>
      <div>
        <span>工具</span>
        <strong>{String(payload.toolName ?? payload.name ?? 'Tool')}</strong>
      </div>
      <small>{status}</small>
      {(payload.input !== undefined || payload.contentPreview !== undefined) && (
        <pre>{formatToolValue(payload.input ?? payload.contentPreview)}</pre>
      )}
    </section>
  );
}

function EmptyState(props: {
  hasWorkspace: boolean;
  setupStatus?: SetupStatus;
  onCreate: () => void;
  onAddWorkspace: () => void;
  onOpenSetup: () => void;
}) {
  const providerReady = Boolean(
    props.setupStatus?.provider.hasApiKey &&
    props.setupStatus.provider.model
  );
  return (
    <div className="empty">
      <div className="empty-mark">K</div>
      <span className="eyebrow">Kross Cloud Agent</span>
      <h1>{props.hasWorkspace ? '开始一个新会话' : '准备你的第一个工作区'}</h1>
      <p>
        {props.hasWorkspace
          ? '会话、审批和运行记录都会保存在隔离的工作区中。'
          : '先完成模型配置，再连接 Git 仓库，Kross 会创建独立执行环境。'}
      </p>
      <div className="onboarding-steps">
        <button
          className={providerReady ? 'complete' : ''}
          onClick={props.onOpenSetup}
        >
          <span>{providerReady ? '✓' : '1'}</span>
          <div><strong>配置模型</strong><small>{providerReady ? `${props.setupStatus?.provider.provider} 已就绪` : '设置 Provider 和 API Key'}</small></div>
        </button>
        <button
          className={props.hasWorkspace ? 'complete' : ''}
          onClick={props.onAddWorkspace}
        >
          <span>{props.hasWorkspace ? '✓' : '2'}</span>
          <div><strong>连接仓库</strong><small>{props.hasWorkspace ? '工作区已经就绪' : '公开或私有 Git 仓库'}</small></div>
        </button>
        <button disabled={!props.hasWorkspace} onClick={props.onCreate}>
          <span>3</span>
          <div><strong>创建任务</strong><small>让 Agent 分析、修改并验证代码</small></div>
        </button>
      </div>
      {props.hasWorkspace && (
        <button className="primary" onClick={props.onCreate}>新建会话</button>
      )}
    </div>
  );
}

function ApprovalCard(props: {
  title: string;
  detail: string;
  risk: string;
  onChoose: (approved: boolean, reason?: string) => void;
}) {
  const risk = riskPresentation(props.risk);
  const [processing, setProcessing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const choose = (approved: boolean) => {
    if (!approved && !rejecting) {
      setRejecting(true);
      return;
    }
    setProcessing(true);
    props.onChoose(approved, approved ? undefined : reason.trim() || undefined);
  };
  return (
    <section
      className={`approval risk-${risk.level}`}
      role="region"
      aria-label={props.title}
    >
      <div className="approval-icon">{risk.icon}</div>
      <div className="approval-body">
        <div>
          <span className="risk">{risk.label}</span>
          <h3>{props.title}</h3>
        </div>
        <p>{risk.description}</p>
        <pre>{props.detail}</pre>
        {rejecting && (
          <textarea
            aria-label="拒绝原因"
            placeholder="可选：告诉 Agent 应该如何调整"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={processing}
            rows={2}
          />
        )}
      </div>
      <div className="approval-actions">
        <button disabled={processing} onClick={() => choose(false)}>
          {rejecting ? '确认拒绝' : '拒绝'}
        </button>
        <button
          className="primary"
          disabled={processing}
          onClick={() => choose(true)}
        >
          {processing ? '处理中…' : '仅批准这一次'}
        </button>
      </div>
    </section>
  );
}

type WorkspaceCredential =
  | { type: 'https-token'; token: string }
  | { type: 'ssh-key'; privateKey: string };

function WorkspaceForm(props: {
  onClose: () => void;
  onCreate: (
    name: string,
    url: string,
    defaultBranch: string,
    credential?: WorkspaceCredential
  ) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [credentialType, setCredentialType] = useState<'none' | 'https-token' | 'ssh-key'>('none');
  const [secret, setSecret] = useState('');
  const credential: WorkspaceCredential | undefined =
    credentialType === 'https-token'
      ? { type: 'https-token', token: secret }
      : credentialType === 'ssh-key'
        ? { type: 'ssh-key', privateKey: secret }
        : undefined;
  const validationError = validateWorkspaceInput(
    url,
    credentialType,
    secret
  );
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [props.onClose]);
  return (
    <div className="modal-backdrop">
      <form
        className="workspace-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-form-title"
        onSubmit={(event) => {
        event.preventDefault();
        if (!validationError) {
          props.onCreate(
            name.trim(),
            url.trim(),
            defaultBranch.trim(),
            credential
          );
        }
      }}>
        <h2 id="workspace-form-title">添加工作区</h2>
        <p>仓库会克隆到独立数据卷，创建过程可随时查看阶段进度。</p>
        <label>名称<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Git URL<input required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/org/repo.git" /></label>
        <label>默认分支（可选）
          <input
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
            placeholder="自动检测"
            pattern="[A-Za-z0-9][A-Za-z0-9._/-]*"
          />
        </label>
        <label>仓库凭证
          <select value={credentialType} onChange={(event) => {
            setCredentialType(event.target.value as typeof credentialType);
            setSecret('');
          }}>
            <option value="none">公开仓库 / 无凭证</option>
            <option value="https-token">HTTPS Token</option>
            <option value="ssh-key">SSH 私钥</option>
          </select>
        </label>
        {credentialType === 'https-token' && (
          <label>Token
            <input
              required
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="new-password"
            />
          </label>
        )}
        {credentialType === 'ssh-key' && (
          <label>私钥
            <textarea
              required
              rows={6}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="off"
            />
          </label>
        )}
        {url && validationError && <p className="form-error">{validationError}</p>}
        <p>凭证仅发送给对应工作区的初始化容器，不写入网关日志。</p>
        <div>
          <button type="button" onClick={props.onClose}>取消</button>
          <button className="primary" disabled={Boolean(validationError)}>
            创建工作区
          </button>
        </div>
      </form>
    </div>
  );
}

function WorkspaceActions(props: {
  workspace: CloudWorkspace;
  onCommand: (
    command:
      | {
          type: 'workspace.start' | 'workspace.stop';
          workspaceId: string;
        }
    ) => void;
  onDelete: () => void;
}) {
  const workspace = props.workspace;
  return (
    <section className="workspace-actions">
      <strong>{workspace.name}</strong>
      <small>{workspace.gitUrl}</small>
      <div>
        <button onClick={() => props.onCommand({
          type: workspace.status === 'stopped' ? 'workspace.start' : 'workspace.stop',
          workspaceId: workspace.id
        })}>
          {workspace.status === 'stopped' ? '启动' : '停止'}
        </button>
        <button className="danger" onClick={props.onDelete}>删除</button>
      </div>
    </section>
  );
}

function WorkspaceProgressPanel(props: {
  progress: WorkspaceProgress;
  onClose: () => void;
  onRetry: () => void;
}) {
  const stages: Array<{
    id: WorkspaceProgress['stage'];
    label: string;
  }> = [
    { id: 'validating', label: '校验仓库' },
    { id: 'provisioning', label: '准备环境' },
    { id: 'cloning', label: '克隆代码' },
    { id: 'starting', label: '启动 Worker' },
    { id: 'ready', label: '工作区就绪' }
  ];
  const currentIndex =
    props.progress.stage === 'failed'
      ? -1
      : stages.findIndex((stage) => stage.id === props.progress.stage);
  return (
    <div className="modal-backdrop">
      <section
        className={`provision-panel ${props.progress.stage}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="provision-title"
      >
        <span className="eyebrow">Workspace Provisioning</span>
        <h2 id="provision-title">{props.progress.name}</h2>
        <p role="status" aria-live="polite">{props.progress.message}</p>
        <div className="provision-steps">
          {stages.map((stage, index) => (
            <div
              key={stage.id}
              className={
                currentIndex > index || props.progress.stage === 'ready'
                  ? 'complete'
                  : currentIndex === index
                    ? 'active'
                    : ''
              }
            >
              <span>
                {currentIndex > index || props.progress.stage === 'ready'
                  ? '✓'
                  : index + 1}
              </span>
              <strong>{stage.label}</strong>
            </div>
          ))}
        </div>
        {props.progress.stage === 'failed' && (
          <p className="form-error">
            创建失败。请检查仓库地址、分支和凭据后重试。
          </p>
        )}
        <div className="form-actions">
          {props.progress.stage === 'failed' && (
            <button onClick={props.onRetry}>修改并重试</button>
          )}
          {(props.progress.stage === 'ready' ||
            props.progress.stage === 'failed') && (
            <button className="primary" onClick={props.onClose}>
              {props.progress.stage === 'ready' ? '进入工作区' : '关闭'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function ExecutionSummary(props: {
  running: boolean;
  pendingApproval: boolean;
  result?: AgentResult;
}) {
  const status = props.pendingApproval
    ? '等待审批'
    : props.running
      ? '执行中'
      : props.result
        ? resultLabel(props.result.status)
        : '尚未运行';
  return (
    <section className="execution-summary">
      <div>
        <span className={`run-status ${props.running ? 'running' : ''}`} />
        <strong>{status}</strong>
      </div>
      {props.result && (
        <>
          <small>{props.result.summary}</small>
          <dl>
            <div>
              <dt>修改文件</dt>
              <dd>{props.result.report.changedFiles.length}</dd>
            </div>
            <div>
              <dt>验证</dt>
              <dd>{verificationLabel(props.result.report.verification.status)}</dd>
            </div>
            <div>
              <dt>风险</dt>
              <dd>{props.result.report.risks.length}</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}

function riskPresentation(value: string): {
  level: 'low' | 'medium' | 'high';
  label: string;
  icon: string;
  description: string;
} {
  const normalized = value.toLowerCase();
  if (
    normalized.includes('high') ||
    normalized.includes('destructive') ||
    normalized.includes('danger')
  ) {
    return {
      level: 'high',
      label: '高风险',
      icon: '!',
      description: '该操作可能造成不可逆变化，请确认范围和参数。'
    };
  }
  if (normalized === 'plan' || normalized.includes('medium')) {
    return {
      level: 'medium',
      label: normalized === 'plan' ? '计划确认' : '需要确认',
      icon: '?',
      description: normalized === 'plan'
        ? '批准后 Agent 将按此计划开始执行。'
        : '该操作会改变工作区，请确认后继续。'
    };
  }
  return {
    level: 'low',
    label: '受控操作',
    icon: '✓',
    description: '审批只对本次工具调用生效。'
  };
}

function validateWorkspaceInput(
  value: string,
  credentialType: 'none' | 'https-token' | 'ssh-key',
  secret: string
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const scpStyle = /^[\w.-]+@[\w.-]+:.+/.test(trimmed);
  if (scpStyle) {
    if (credentialType === 'https-token') {
      return 'HTTPS Token 不能用于 SSH 仓库地址';
    }
  } else {
    try {
      const url = new URL(trimmed);
      if (!['https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol)) {
        return '仅支持 HTTPS 或 SSH Git 地址';
      }
      if (url.username || url.password) {
        return 'Git URL 不能内嵌凭据，请使用下方凭据字段';
      }
      if (credentialType === 'https-token' && url.protocol !== 'https:') {
        return 'HTTPS Token 只能用于 https:// 地址';
      }
      if (
        credentialType === 'ssh-key' &&
        !['ssh:', 'git+ssh:'].includes(url.protocol)
      ) {
        return 'SSH 私钥需要 ssh://、git+ssh:// 或 scp 风格地址';
      }
    } catch {
      return '请输入完整的 HTTPS、SSH 或 scp 风格 Git 地址';
    }
  }
  if (credentialType !== 'none' && !secret.trim()) {
    return credentialType === 'https-token'
      ? '请输入 HTTPS Token'
      : '请输入 SSH 私钥';
  }
  if (
    credentialType === 'ssh-key' &&
    secret &&
    !secret.includes('PRIVATE KEY')
  ) {
    return 'SSH 私钥格式不正确';
  }
  return undefined;
}

function resultLabel(status: AgentResult['status']): string {
  return {
    completed: '执行完成',
    failed: '执行失败',
    cancelled: '已取消',
    'approval-required': '等待审批'
  }[status];
}

function verificationLabel(
  status: AgentResult['report']['verification']['status']
): string {
  return {
    passed: '已通过',
    failed: '失败',
    'not-run': '未运行',
    'not-needed': '无需验证'
  }[status];
}

function connectionLabel(state: string): string {
  if (state === 'online') return '已连接';
  if (state === 'connecting') return '连接中';
  if (state === 'outdated') return '客户端版本过旧，请更新';
  return '正在重连';
}

function decodeVapidKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function formatToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
