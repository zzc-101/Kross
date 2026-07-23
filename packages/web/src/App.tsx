import ReactMarkdown from 'react-markdown';
import type {
  AgentResult,
  CloudWorkspace,
  WorkspaceProgress
} from '@kross/protocol';
import {
  Activity,
  Bell,
  Bot,
  ChevronRight,
  CircleCheck,
  Download,
  FolderGit2,
  GitCompare,
  GitPullRequest,
  ListTodo,
  LogOut,
  MessageSquareText,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Settings,
  Square,
  Trash2,
  Upload
} from 'lucide-react';
import {
  memo,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react';

import { SetupPanel } from './SetupPanel';
import { ActionDialog, type DialogAction } from './OperationDialog';
import { InspectionPanel } from './InspectionPanel';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from './components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from './components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './components/ui/dropdown-menu';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Progress } from './components/ui/progress';
import { ScrollArea } from './components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './components/ui/select';
import { Textarea } from './components/ui/textarea';
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
  const persistedToolCallIds = new Set(
    state.messages.flatMap((message) =>
      message.tool?.callId ? [message.tool.callId] : []
    )
  );

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
        <Select
          value={state.workspaceId ?? ''}
          onValueChange={cloud.selectWorkspace}
        >
          <SelectTrigger className="workspace-select" aria-label="工作区">
            <SelectValue placeholder="选择工作区" />
          </SelectTrigger>
          <SelectContent>
            {state.workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" className="icon-button" onClick={() => setShowWorkspaceForm(true)}>
          <Plus /> 工作区
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={`icon-button setup-button ${setupStatus?.ready ? 'ready' : 'attention'}`}
          onClick={() => setShowSetup(true)}
        >
          <Settings /> 环境
        </Button>
        {pwa.installable && !pwa.installed && (
          <Button
            variant="ghost"
            size="sm"
            className="icon-button install-button"
            onClick={() => void installPwa()}
          >
            <Download /> 安装
          </Button>
        )}
        <Button variant="ghost" size="sm" className="icon-button muted" onClick={onLogout}>
          <LogOut /> 退出
        </Button>
      </header>

      {(pwa.offline || pwa.updateAvailable) && (
        <div className={`app-banner ${pwa.updateAvailable ? 'update' : 'offline'}`}>
          <span>
            {pwa.updateAvailable
              ? 'Kross Cloud 有新版本可用。'
              : '网络已断开；操作会排队，并在恢复连接后发送。'}
          </span>
          {pwa.updateAvailable && (
            <Button variant="ghost" size="sm" onClick={applyPwaUpdate}>更新并重新载入</Button>
          )}
        </div>
      )}

      <main className="layout">
        <aside className={`sidebar ${mobilePanel === 'sessions' ? 'mobile-active' : ''}`}>
          <Button
            className="full"
            disabled={!state.workspaceId}
            onClick={() => state.workspaceId && cloud.createSession(state.workspaceId)}
          >
            <Plus /> 新建会话
          </Button>
          <h2>会话</h2>
          <Input
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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="session-menu"
                      aria-label={`会话操作 ${session.title}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() =>
                        setDialogAction({
                          kind: 'rename-session',
                          sessionId: session.id,
                          title: session.title
                        })
                      }
                    >
                      <Pencil /> 重命名
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() =>
                        setDialogAction({
                          kind: 'delete-session',
                          sessionId: session.id,
                          title: session.title
                        })
                      }
                    >
                      <Trash2 /> 删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
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
                  <Select
                    value={state.snapshot.mode}
                    onValueChange={(mode) =>
                      client.send({
                        type: 'session.settings',
                        workspaceId: state.workspaceId!,
                        sessionId: state.snapshot!.summary.id,
                        mode: mode as 'auto' | 'plan' | 'conductor'
                      })
                    }
                  >
                    <SelectTrigger className="head-select" aria-label="Agent 模式">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto</SelectItem>
                      <SelectItem value="plan">Plan</SelectItem>
                      <SelectItem value="conductor">Conductor</SelectItem>
                    </SelectContent>
                  </Select>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="desktop-action"
                        aria-label="更多会话操作"
                      >
                        <MoreHorizontal /> 更多
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>检查</DropdownMenuLabel>
                      <DropdownMenuItem onSelect={() => inspect('diff')}>
                        <GitCompare /> Diff
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => inspect('trace')}>
                        <Activity /> Trace
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Git</DropdownMenuLabel>
                      <DropdownMenuItem onSelect={pushBranch}>
                        <Upload /> Push
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={createPullRequest}>
                        <GitPullRequest /> 创建 PR
                      </DropdownMenuItem>
                      {'Notification' in window && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => void enableNotifications()}>
                            <Bell /> 启用通知
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button variant="outline" size="sm" onClick={() => setDialogAction({
                    kind: 'model',
                    model: state.snapshot?.model ?? state.models[0]?.id ?? '',
                    options: state.models.map((model) => model.id)
                  })}>模型</Button>
                  <Select
                    value={state.snapshot.thinkingEffort ?? 'off'}
                    onValueChange={(thinkingEffort) =>
                      client.send({
                        type: 'session.settings',
                        workspaceId: state.workspaceId!,
                        sessionId: state.snapshot!.summary.id,
                        thinkingEffort: thinkingEffort as SessionThinkingEffort
                      })
                    }
                  >
                    <SelectTrigger className="head-select" aria-label="思考强度">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((effort) => (
                        <SelectItem key={effort} value={effort}>{effort}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="messages">
                {state.messages.map((message) => (
                  <Message key={message.id} message={message} />
                ))}
                {state.traces
                  .filter(
                    (trace) =>
                      trace.type.startsWith('tool_call.') &&
                      !(
                        typeof trace.payload.callId === 'string' &&
                        persistedToolCallIds.has(trace.payload.callId)
                      )
                  )
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
                <Textarea
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
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() =>
                      client.send({
                        type: 'session.abort',
                        workspaceId: state.workspaceId!,
                        sessionId: state.snapshot!.summary.id
                      })
                    }
                  >
                    <Square /> 停止
                  </Button>
                ) : <Button><Send />发送</Button>}
              </form>
            </>
          )}
        </section>

        <aside className={`details ${mobilePanel === 'todo' ? 'mobile-active' : ''}`}>
          <div className="mobile-utilities">
            <Button variant="outline" size="sm" onClick={() => inspect('diff')}>Diff</Button>
            <Button variant="outline" size="sm" onClick={() => inspect('trace')}>Trace</Button>
            <Button variant="outline" size="sm" onClick={pushBranch}>Push</Button>
            <Button variant="outline" size="sm" onClick={createPullRequest}>PR</Button>
            {'Notification' in window && (
              <Button variant="outline" size="sm" onClick={() => void enableNotifications()}>通知</Button>
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
        <Button
          variant="ghost"
          className={mobilePanel === 'sessions' ? 'active' : ''}
          aria-current={mobilePanel === 'sessions' ? 'page' : undefined}
          onClick={() => setMobilePanel('sessions')}
        >
          <MessagesSquare /><span>会话</span>
        </Button>
        <Button
          variant="ghost"
          className={mobilePanel === 'chat' ? 'active' : ''}
          aria-current={mobilePanel === 'chat' ? 'page' : undefined}
          onClick={() => setMobilePanel('chat')}
        >
          <MessageSquareText /><span>对话</span>
        </Button>
        <Button
          variant="ghost"
          className={mobilePanel === 'todo' ? 'active' : ''}
          aria-current={mobilePanel === 'todo' ? 'page' : undefined}
          onClick={() => setMobilePanel('todo')}
        >
          <ListTodo /><span>进度</span>
        </Button>
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
  if (message.tool) {
    return (
      <article className="message tool">
        <div className="message-author">工具记录</div>
        <HistoricalToolCard
          tool={message.tool}
          fallbackText={message.text}
          verification={message.verification}
        />
      </article>
    );
  }
  return (
    <article className={`message ${message.from}`}>
      <div className="message-author">
        {message.from === 'user' ? '你' : message.from === 'thinking' ? '思考' : 'Kross'}
      </div>
      {message.from === 'thinking' ? (
        <ToolDisclosure label="查看思考过程">
          <pre>{message.text}</pre>
        </ToolDisclosure>
      ) : <ReactMarkdown>{message.text}</ReactMarkdown>}
    </article>
  );
});

function HistoricalToolCard({
  tool,
  fallbackText,
  verification
}: {
  tool: NonNullable<UiMessage['tool']>;
  fallbackText: string;
  verification?: UiMessage['verification'];
}) {
  const details = tool.detailLines ?? [];
  return (
    <Card className={`tool-card history ${tool.status}`}>
      <CardHeader className="tool-card-header">
        <div>
          <Badge variant="outline">工具</Badge>
          <CardTitle>{tool.name}</CardTitle>
        </div>
        <Badge variant={toolStatusVariant(tool.status)}>
          {toolStatusLabel(tool.status)}
        </Badge>
      </CardHeader>
      <CardContent className="tool-card-content">
        <CardDescription>{tool.summary || fallbackText}</CardDescription>
        {tool.inputPreview && (
          <ToolDisclosure label="查看输入">
            <pre>{tool.inputPreview}</pre>
          </ToolDisclosure>
        )}
        {details.length > 0 && (
          <ToolDisclosure
            label={
              `查看执行明细${tool.detailTruncated ? '（已截断）' : ''}`
            }
          >
            <pre className="tool-detail">
              {details.map((line, index) => (
                <span className={line.op ? `diff-${line.op}` : undefined} key={index}>
                  {line.lineNo ? `${line.lineNo} ` : ''}
                  {line.text}
                  {'\n'}
                </span>
              ))}
            </pre>
          </ToolDisclosure>
        )}
        {tool.items && tool.items.length > 0 && (
          <ul className="tool-items">
            {tool.items.map((item, index) => (
              <li key={`${item.callId ?? item.path ?? index}`}>
                <strong>{item.path ?? item.callId ?? `步骤 ${index + 1}`}</strong>
                <Badge variant={toolStatusVariant(item.status)}>
                  {toolStatusLabel(item.status)}
                </Badge>
                {(item.summary || item.preview) && (
                  <small>{item.summary ?? item.preview}</small>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter className="tool-card-footer">
        {tool.durationMs !== undefined && <span>{tool.durationMs} ms</span>}
        {(tool.linesAdded !== undefined || tool.linesRemoved !== undefined) && (
          <span>
            <ins>+{tool.linesAdded ?? 0}</ins>{' '}
            <del>-{tool.linesRemoved ?? 0}</del>
          </span>
        )}
        {verification && (
          <span>验证：{verificationLabel(verification.status)}</span>
        )}
      </CardFooter>
    </Card>
  );
}

function ToolDisclosure(props: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Collapsible className="tool-disclosure">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="tool-disclosure-trigger">
          <ChevronRight />
          {props.label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {props.children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCard({
  type,
  payload
}: {
  type: string;
  payload: Record<string, unknown>;
}) {
  const status = type.split('.').at(-1) ?? 'running';
  return (
    <Card className={`tool-card ${status}`}>
      <CardHeader className="tool-card-header">
        <div>
          <Badge variant="outline">工具</Badge>
          <CardTitle>
            {String(payload.toolName ?? payload.name ?? 'Tool')}
          </CardTitle>
        </div>
        <Badge variant={toolStatusVariant(status)}>
          {toolStatusLabel(status)}
        </Badge>
      </CardHeader>
      {(payload.input !== undefined || payload.contentPreview !== undefined) && (
        <CardContent className="tool-card-content">
          <ToolDisclosure label="查看调用内容">
            <pre>{formatToolValue(payload.input ?? payload.contentPreview)}</pre>
          </ToolDisclosure>
        </CardContent>
      )}
    </Card>
  );
}

function toolStatusVariant(
  status: string
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed' || status === 'denied') return 'destructive';
  if (status === 'completed') return 'secondary';
  if (status === 'running') return 'default';
  return 'outline';
}

function toolStatusLabel(status: string): string {
  return {
    awaiting: '等待中',
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    denied: '已拒绝',
    cancelled: '已取消'
  }[status] ?? status;
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
    <Card className="empty">
      <CardContent className="empty-content">
        <div className="empty-mark">K</div>
        <span className="eyebrow">Kross Cloud Agent</span>
        <h1>{props.hasWorkspace ? '开始一个新会话' : '准备你的第一个工作区'}</h1>
        <p>
          {props.hasWorkspace
            ? '会话、审批和运行记录都会保存在隔离的工作区中。'
            : '先完成模型配置，再连接 Git 仓库，Kross 会创建独立执行环境。'}
        </p>
        <div className="onboarding-steps">
          <Button
            variant="ghost"
            className={providerReady ? 'complete' : ''}
            onClick={props.onOpenSetup}
          >
            <span>{providerReady ? <CircleCheck /> : <Settings />}</span>
            <div><strong>配置模型</strong><small>{providerReady ? `${props.setupStatus?.provider.provider} 已就绪` : '设置 Provider 和 API Key'}</small></div>
          </Button>
          <Button
            variant="ghost"
            className={props.hasWorkspace ? 'complete' : ''}
            onClick={props.onAddWorkspace}
          >
            <span>{props.hasWorkspace ? <CircleCheck /> : <FolderGit2 />}</span>
            <div><strong>连接仓库</strong><small>{props.hasWorkspace ? '工作区已经就绪' : '公开或私有 Git 仓库'}</small></div>
          </Button>
          <Button variant="ghost" disabled={!props.hasWorkspace} onClick={props.onCreate}>
            <span><Bot /></span>
            <div><strong>创建任务</strong><small>让 Agent 分析、修改并验证代码</small></div>
          </Button>
        </div>
        {props.hasWorkspace && (
          <Button onClick={props.onCreate}><Plus /> 新建会话</Button>
        )}
      </CardContent>
    </Card>
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
    <Card
      className={`approval risk-${risk.level}`}
      role="region"
      aria-label={props.title}
    >
      <CardHeader className="approval-header">
        <div className="approval-icon">{risk.icon}</div>
        <div>
          <Badge variant={risk.level === 'high' ? 'destructive' : 'outline'}>
            {risk.label}
          </Badge>
          <CardTitle>{props.title}</CardTitle>
          <CardDescription>{risk.description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="approval-body">
        <ScrollArea className="approval-detail">
          <pre>{props.detail}</pre>
        </ScrollArea>
        {rejecting && (
          <Textarea
            aria-label="拒绝原因"
            placeholder="可选：告诉 Agent 应该如何调整"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={processing}
            rows={2}
          />
        )}
      </CardContent>
      <CardFooter className="approval-actions">
        <Button
          variant="outline"
          disabled={processing}
          onClick={() => choose(false)}
        >
          {rejecting ? '确认拒绝' : '拒绝'}
        </Button>
        <Button
          disabled={processing}
          onClick={() => choose(true)}
        >
          {processing ? '处理中…' : '仅批准这一次'}
        </Button>
      </CardFooter>
    </Card>
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="workspace-dialog">
        <form
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
          }}
        >
          <DialogHeader>
            <span className="eyebrow">工作区</span>
            <DialogTitle>添加工作区</DialogTitle>
            <DialogDescription>
              仓库会克隆到独立数据卷，创建过程可随时查看阶段进度。
            </DialogDescription>
          </DialogHeader>

          <Label className="dialog-field">
            名称
            <Input
              autoFocus
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Label>
          <Label className="dialog-field">
            Git URL
            <Input
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
          </Label>
          <Label className="dialog-field">
            默认分支（可选）
            <Input
              value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)}
              placeholder="自动检测"
              pattern="[A-Za-z0-9][A-Za-z0-9._/-]*"
            />
          </Label>
          <Label className="dialog-field">
            仓库凭证
            <Select
              value={credentialType}
              onValueChange={(value) => {
                setCredentialType(value as typeof credentialType);
                setSecret('');
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">公开仓库 / 无凭证</SelectItem>
                <SelectItem value="https-token">HTTPS Token</SelectItem>
                <SelectItem value="ssh-key">SSH 私钥</SelectItem>
              </SelectContent>
            </Select>
          </Label>

          {credentialType === 'https-token' && (
            <Label className="dialog-field">
              Token
              <Input
                required
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="new-password"
              />
            </Label>
          )}
          {credentialType === 'ssh-key' && (
            <Label className="dialog-field">
              私钥
              <Textarea
                required
                rows={6}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
              />
            </Label>
          )}

          {url && validationError && <p className="form-error">{validationError}</p>}
          <p className="credential-note">
            凭证仅发送给对应工作区的初始化容器，不写入网关日志。
          </p>
          <DialogFooter className="form-actions">
            <Button type="button" variant="outline" onClick={props.onClose}>
              取消
            </Button>
            <Button disabled={Boolean(validationError)}>创建工作区</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
    <Card className="workspace-actions">
      <CardHeader>
        <div className="workspace-status">
          <CardTitle>{workspace.name}</CardTitle>
          <Badge variant={workspace.status === 'ready' ? 'secondary' : 'outline'}>
            {workspaceStatusLabel(workspace.status)}
          </Badge>
        </div>
        <CardDescription>{workspace.gitUrl}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button
          variant="outline"
          size="sm"
          onClick={() => props.onCommand({
            type: workspace.status === 'stopped' ? 'workspace.start' : 'workspace.stop',
            workspaceId: workspace.id
          })}
        >
          {workspace.status === 'stopped' ? '启动' : '停止'}
        </Button>
        <Button variant="destructive" size="sm" onClick={props.onDelete}>
          删除
        </Button>
      </CardFooter>
    </Card>
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
  const terminal =
    props.progress.stage === 'ready' || props.progress.stage === 'failed';
  const progressValue =
    props.progress.stage === 'failed'
      ? 100
      : Math.max(0, ((currentIndex + 1) / stages.length) * 100);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && terminal) props.onClose();
      }}
    >
      <DialogContent className={`provision-panel ${terminal ? 'terminal' : ''}`}>
        <DialogHeader>
          <span className="eyebrow">Workspace Provisioning</span>
          <DialogTitle>{props.progress.name}</DialogTitle>
          <DialogDescription role="status" aria-live="polite">
            {props.progress.message}
          </DialogDescription>
        </DialogHeader>
        <Progress value={progressValue} aria-label="工作区创建进度" />
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
        <DialogFooter className="form-actions">
          {props.progress.stage === 'failed' && (
            <Button variant="outline" onClick={props.onRetry}>修改并重试</Button>
          )}
          {terminal && (
            <Button onClick={props.onClose}>
              {props.progress.stage === 'ready' ? '进入工作区' : '关闭'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <Card className="execution-summary">
      <CardHeader>
        <div>
          <span className={`run-status ${props.running ? 'running' : ''}`} />
          <CardTitle>{status}</CardTitle>
        </div>
      </CardHeader>
      {props.result && (
        <>
          <CardContent>
            <CardDescription>{props.result.summary}</CardDescription>
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
          </CardContent>
        </>
      )}
    </Card>
  );
}

function workspaceStatusLabel(status: CloudWorkspace['status']): string {
  return {
    ready: '运行中',
    stopped: '已停止',
    creating: '创建中',
    error: '异常'
  }[status] ?? status;
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
