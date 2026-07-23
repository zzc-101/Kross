import type { CloudWorkspace } from '@kross/protocol';
import type { TFunction } from 'i18next';
import {
  Activity,
  Bell,
  Download,
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
import type {
  Dispatch,
  FormEventHandler,
  RefObject,
  SetStateAction
} from 'react';
import { useTranslation } from 'react-i18next';

import type { DialogAction } from '../../OperationDialog';
import { applyPwaUpdate, installPwa, type usePwa } from '../../pwa';
import type { SetupStatus } from '../../setupApi';
import type { useCloud } from '../../useCloud';
import {
  ApprovalCard,
  ExecutionSummary,
  Message,
  ToolCard
} from '../session/SessionSurface';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Textarea } from '../ui/textarea';
import {
  EmptyState,
  WorkspaceActions
} from '../workspace/WorkspacePanels';
import { LanguageSwitcher } from './LanguageSwitcher';

type CloudController = ReturnType<typeof useCloud>;
type CloudState = CloudController['state'];
type PwaState = ReturnType<typeof usePwa>;
type MobilePanel = 'chat' | 'sessions' | 'todo';
type SessionThinkingEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

interface AppLayoutProps {
  cloud: CloudController;
  pwa: PwaState;
  setupStatus?: SetupStatus;
  selectedWorkspace?: CloudWorkspace;
  visibleSessions: CloudState['sessions'];
  persistedToolCallIds: Set<string>;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  mobilePanel: MobilePanel;
  onMobilePanelChange: (panel: MobilePanel) => void;
  sessionQuery: string;
  onSessionQueryChange: (value: string) => void;
  bottomRef: RefObject<HTMLDivElement>;
  onLogout: () => void;
  onOpenWorkspaceForm: () => void;
  onOpenSetup: () => void;
  onDialogAction: Dispatch<SetStateAction<DialogAction | undefined>>;
  onInspect: (kind: 'trace' | 'diff', argument?: string) => void;
  onEnableNotifications: () => Promise<void>;
  onPushBranch: () => void;
  onCreatePullRequest: () => void;
}

export function AppLayout(props: AppLayoutProps) {
  const { state, client, connection } = props.cloud;
  return (
    <>
      <AppHeader
        connection={connection}
        state={state}
        cloud={props.cloud}
        pwa={props.pwa}
        setupStatus={props.setupStatus}
        onLogout={props.onLogout}
        onOpenWorkspaceForm={props.onOpenWorkspaceForm}
        onOpenSetup={props.onOpenSetup}
      />

      <main className="layout">
        <SessionSidebar
          state={state}
          selectedWorkspace={props.selectedWorkspace}
          visibleSessions={props.visibleSessions}
          sessionQuery={props.sessionQuery}
          mobilePanel={props.mobilePanel}
          onSessionQueryChange={props.onSessionQueryChange}
          onMobilePanelChange={props.onMobilePanelChange}
          onDialogAction={props.onDialogAction}
          cloud={props.cloud}
        />

        <ChatPanel
          state={state}
          client={client}
          setupStatus={props.setupStatus}
          input={props.input}
          mobilePanel={props.mobilePanel}
          persistedToolCallIds={props.persistedToolCallIds}
          bottomRef={props.bottomRef}
          onInputChange={props.onInputChange}
          onSubmit={props.onSubmit}
          onOpenWorkspaceForm={props.onOpenWorkspaceForm}
          onOpenSetup={props.onOpenSetup}
          onDialogAction={props.onDialogAction}
          onInspect={props.onInspect}
          onEnableNotifications={props.onEnableNotifications}
          onPushBranch={props.onPushBranch}
          onCreatePullRequest={props.onCreatePullRequest}
          cloud={props.cloud}
        />

        <SessionDetails
          state={state}
          mobilePanel={props.mobilePanel}
          onInspect={props.onInspect}
          onEnableNotifications={props.onEnableNotifications}
          onPushBranch={props.onPushBranch}
          onCreatePullRequest={props.onCreatePullRequest}
        />
      </main>

      <MobileNavigation
        active={props.mobilePanel}
        onChange={props.onMobilePanelChange}
      />
    </>
  );
}

function AppHeader(props: {
  connection: CloudController['connection'];
  state: CloudState;
  cloud: CloudController;
  pwa: PwaState;
  setupStatus?: SetupStatus;
  onLogout: () => void;
  onOpenWorkspaceForm: () => void;
  onOpenSetup: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <header className="topbar">
        <div className="brand"><span>K</span> Kross Cloud</div>
        <div
          className={`connection ${props.connection}`}
          role="status"
          aria-live="polite"
          title={connectionLabel(props.connection, t)}
        >
          {connectionLabel(props.connection, t)}
        </div>
        <Select
          value={props.state.workspaceId ?? ''}
          onValueChange={props.cloud.selectWorkspace}
        >
          <SelectTrigger className="workspace-select" aria-label={t('header.workspace')}>
            <SelectValue placeholder={t('header.selectWorkspace')} />
          </SelectTrigger>
          <SelectContent>
            {props.state.workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" className="icon-button" onClick={props.onOpenWorkspaceForm}>
          <Plus /> {t('header.addWorkspace')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={`icon-button setup-button ${props.setupStatus?.ready ? 'ready' : 'attention'}`}
          onClick={props.onOpenSetup}
        >
          <Settings /> {t('header.environment')}
        </Button>
        {props.pwa.installable && !props.pwa.installed && (
          <Button
            variant="ghost"
            size="sm"
            className="icon-button install-button"
            onClick={() => void installPwa()}
          >
            <Download /> {t('header.install')}
          </Button>
        )}
        <LanguageSwitcher compact />
        <Button variant="ghost" size="sm" className="icon-button muted" onClick={props.onLogout}>
          <LogOut /> {t('header.logout')}
        </Button>
      </header>

      {(props.pwa.offline || props.pwa.updateAvailable) && (
        <div className={`app-banner ${props.pwa.updateAvailable ? 'update' : 'offline'}`}>
          <span>
            {props.pwa.updateAvailable
              ? t('connection.updateBanner')
              : t('connection.offlineBanner')}
          </span>
          {props.pwa.updateAvailable && (
            <Button variant="ghost" size="sm" onClick={applyPwaUpdate}>{t('connection.updateAction')}</Button>
          )}
        </div>
      )}
    </>
  );
}

function SessionSidebar(props: {
  state: CloudState;
  cloud: CloudController;
  selectedWorkspace?: CloudWorkspace;
  visibleSessions: CloudState['sessions'];
  sessionQuery: string;
  mobilePanel: MobilePanel;
  onSessionQueryChange: (value: string) => void;
  onMobilePanelChange: (panel: MobilePanel) => void;
  onDialogAction: Dispatch<SetStateAction<DialogAction | undefined>>;
}) {
  const { t } = useTranslation();
  return (
    <aside className={`sidebar ${props.mobilePanel === 'sessions' ? 'mobile-active' : ''}`}>
      <Button
        className="full"
        disabled={!props.state.workspaceId}
        onClick={() => props.state.workspaceId && props.cloud.createSession(props.state.workspaceId)}
      >
        <Plus /> {t('session.new')}
      </Button>
      <h2>{t('session.title')}</h2>
      <Input
        className="session-search"
        type="search"
        aria-label={t('session.search')}
        placeholder={t('session.search')}
        value={props.sessionQuery}
        onChange={(event) => props.onSessionQueryChange(event.target.value)}
      />
      <div className="session-list">
        {props.visibleSessions.map((session) => (
          <div
            className={`session-row ${
              props.state.snapshot?.summary.id === session.id ? 'active' : ''
            }`}
            key={session.id}
          >
            <button
              className="session-open"
              onClick={() => {
                if (props.state.workspaceId) {
                  props.cloud.resumeSession(props.state.workspaceId, session.id);
                  props.onMobilePanelChange('chat');
                }
              }}
            >
              <strong>{session.title}</strong>
              <small>{session.preview || t('session.emptySession')}</small>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="session-menu"
                  aria-label={t('session.actions', { title: session.title })}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() =>
                    props.onDialogAction({
                      kind: 'rename-session',
                      sessionId: session.id,
                      title: session.title
                    })
                  }
                >
                  <Pencil /> {t('session.rename')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() =>
                    props.onDialogAction({
                      kind: 'delete-session',
                      sessionId: session.id,
                      title: session.title
                    })
                  }
                >
                  <Trash2 /> {t('common.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
        {props.visibleSessions.length === 0 && (
          <p className="quiet session-empty">{t('session.empty')}</p>
        )}
      </div>
      {props.selectedWorkspace && (
        <WorkspaceActions
          workspace={props.selectedWorkspace}
          onToggle={() => props.cloud.client.send({
            type: props.selectedWorkspace!.status === 'stopped'
              ? 'workspace.start'
              : 'workspace.stop',
            workspaceId: props.selectedWorkspace!.id
          })}
          onDelete={() => props.onDialogAction({
            kind: 'delete-workspace',
            workspaceId: props.selectedWorkspace!.id,
            name: props.selectedWorkspace!.name,
            removeVolume: false
          })}
        />
      )}
    </aside>
  );
}

function ChatPanel(props: {
  state: CloudState;
  client: CloudController['client'];
  cloud: CloudController;
  setupStatus?: SetupStatus;
  input: string;
  mobilePanel: MobilePanel;
  persistedToolCallIds: Set<string>;
  bottomRef: RefObject<HTMLDivElement>;
  onInputChange: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onOpenWorkspaceForm: () => void;
  onOpenSetup: () => void;
  onDialogAction: Dispatch<SetStateAction<DialogAction | undefined>>;
  onInspect: (kind: 'trace' | 'diff', argument?: string) => void;
  onEnableNotifications: () => Promise<void>;
  onPushBranch: () => void;
  onCreatePullRequest: () => void;
}) {
  const { t } = useTranslation();
  const snapshot = props.state.snapshot;
  return (
    <section className={`chat ${props.mobilePanel === 'chat' ? 'mobile-active' : ''}`}>
      {!snapshot ? (
        <EmptyState
          hasWorkspace={Boolean(props.state.workspaceId)}
          setupStatus={props.setupStatus}
          onCreate={() => props.state.workspaceId && props.cloud.createSession(props.state.workspaceId)}
          onAddWorkspace={props.onOpenWorkspaceForm}
          onOpenSetup={props.onOpenSetup}
        />
      ) : (
        <>
          <div className="chat-head">
            <div>
              <h1>{snapshot.summary.title}</h1>
              <small>{snapshot.model ?? t('session.unconfiguredModel')} · {snapshot.thinkingEffort}</small>
            </div>
            <div className="head-actions">
              <Select
                value={snapshot.mode}
                onValueChange={(mode) =>
                  props.client.send({
                    type: 'session.settings',
                    workspaceId: props.state.workspaceId!,
                    sessionId: snapshot.summary.id,
                    mode: mode as 'auto' | 'plan' | 'conductor'
                  })
                }
              >
                <SelectTrigger className="head-select" aria-label={t('session.agentMode')}>
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
                    aria-label={t('session.moreActions')}
                  >
                    <MoreHorizontal /> {t('session.more')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{t('session.inspect')}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => props.onInspect('diff')}>
                    <GitCompare /> Diff
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => props.onInspect('trace')}>
                    <Activity /> Trace
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t('session.git')}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={props.onPushBranch}>
                    <Upload /> Push
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={props.onCreatePullRequest}>
                    <GitPullRequest /> {t('session.createPr')}
                  </DropdownMenuItem>
                  {'Notification' in window && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => void props.onEnableNotifications()}>
                        <Bell /> {t('session.enableNotifications')}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="outline" size="sm" onClick={() => props.onDialogAction({
                kind: 'model',
                model: snapshot.model ?? props.state.models[0]?.id ?? '',
                options: props.state.models.map((model) => model.id)
              })}>{t('session.model')}</Button>
              <Select
                value={snapshot.thinkingEffort ?? 'off'}
                onValueChange={(thinkingEffort) =>
                  props.client.send({
                    type: 'session.settings',
                    workspaceId: props.state.workspaceId!,
                    sessionId: snapshot.summary.id,
                    thinkingEffort: thinkingEffort as SessionThinkingEffort
                  })
                }
              >
                <SelectTrigger className="head-select" aria-label={t('session.thinkingEffort')}>
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
            {props.state.messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {props.state.traces
              .filter(
                (trace) =>
                  trace.type.startsWith('tool_call.') &&
                  !(
                    typeof trace.payload.callId === 'string' &&
                    props.persistedToolCallIds.has(trace.payload.callId)
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
            {props.state.running && (
              <div className="running" role="status" aria-live="polite">
                <i /> {t('session.agentWorking')}
              </div>
            )}
            <div ref={props.bottomRef} />
          </div>
          {snapshot.pendingApproval && (
            <ApprovalCard
              title={t('session.pendingApproval', { tool: snapshot.pendingApproval.toolName })}
              detail={[
                snapshot.pendingApproval.command,
                snapshot.pendingApproval.workDir
                  ? t('session.workDir', { path: snapshot.pendingApproval.workDir })
                  : undefined,
                snapshot.pendingApproval.inputPreview
              ].filter(Boolean).join('\n\n')}
              risk={snapshot.pendingApproval.risk}
              onChoose={(approved, reason) =>
                props.client.send({
                  type: 'session.approval',
                  workspaceId: props.state.workspaceId!,
                  sessionId: snapshot.summary.id,
                  runId: snapshot.pendingApproval!.runId,
                  approved,
                  reason
                })
              }
            />
          )}
          {snapshot.pendingPlan && (
            <ApprovalCard
              title={t('session.planReady')}
              detail={t('session.planDetail')}
              risk="plan"
              onChoose={(approved) => {
                const prompt =
                  snapshot.pendingPlan?.goal ??
                  [...props.state.messages]
                    .reverse()
                    .find((item) => item.from === 'user')?.text;
                props.client.send({
                  type: 'session.plan-approval',
                  workspaceId: props.state.workspaceId!,
                  sessionId: snapshot.summary.id,
                  approved,
                  input: approved ? prompt : undefined
                });
              }}
            />
          )}
          <form className="composer" onSubmit={props.onSubmit}>
            <Textarea
              value={props.input}
              onChange={(event) => props.onInputChange(event.target.value)}
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
              placeholder={t('session.composerPlaceholder')}
              rows={2}
            />
            {props.state.running ? (
              <Button
                type="button"
                variant="destructive"
                onClick={() =>
                  props.client.send({
                    type: 'session.abort',
                    workspaceId: props.state.workspaceId!,
                    sessionId: snapshot.summary.id
                  })
                }
              >
                <Square /> {t('session.stop')}
              </Button>
            ) : <Button><Send />{t('session.send')}</Button>}
          </form>
        </>
      )}
    </section>
  );
}

function SessionDetails(props: {
  state: CloudState;
  mobilePanel: MobilePanel;
  onInspect: (kind: 'trace' | 'diff', argument?: string) => void;
  onEnableNotifications: () => Promise<void>;
  onPushBranch: () => void;
  onCreatePullRequest: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className={`details ${props.mobilePanel === 'todo' ? 'mobile-active' : ''}`}>
      <div className="mobile-utilities">
        <Button variant="outline" size="sm" onClick={() => props.onInspect('diff')}>Diff</Button>
        <Button variant="outline" size="sm" onClick={() => props.onInspect('trace')}>Trace</Button>
        <Button variant="outline" size="sm" onClick={props.onPushBranch}>Push</Button>
        <Button variant="outline" size="sm" onClick={props.onCreatePullRequest}>PR</Button>
        {'Notification' in window && (
          <Button variant="outline" size="sm" onClick={() => void props.onEnableNotifications()}>{t('session.notifications')}</Button>
        )}
      </div>
      <h2>{t('execution.progress')}</h2>
      <ExecutionSummary
        running={props.state.running}
        pendingApproval={Boolean(props.state.snapshot?.pendingApproval)}
        result={props.state.lastResult}
      />
      {props.state.snapshot?.todos.length ? props.state.snapshot.todos.map((todo) => (
        <div className={`todo ${todo.status}`} key={todo.id}>
          <span>{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○'}</span>
          <p>{todo.content}</p>
        </div>
      )) : <p className="quiet">{t('execution.noTodos')}</p>}
      <h2>{t('execution.toolActivity')}</h2>
      {props.state.traces.slice(-12).reverse().map((trace) => (
        <div className="trace" key={trace.id}>
          <strong>{trace.type}</strong>
          <small>{String(trace.payload.toolName ?? trace.payload.name ?? '')}</small>
        </div>
      ))}
    </aside>
  );
}

function MobileNavigation(props: {
  active: MobilePanel;
  onChange: (panel: MobilePanel) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="mobile-nav">
      <Button
        variant="ghost"
        className={props.active === 'sessions' ? 'active' : ''}
        aria-current={props.active === 'sessions' ? 'page' : undefined}
        onClick={() => props.onChange('sessions')}
      >
        <MessagesSquare /><span>{t('navigation.sessions')}</span>
      </Button>
      <Button
        variant="ghost"
        className={props.active === 'chat' ? 'active' : ''}
        aria-current={props.active === 'chat' ? 'page' : undefined}
        onClick={() => props.onChange('chat')}
      >
        <MessageSquareText /><span>{t('navigation.chat')}</span>
      </Button>
      <Button
        variant="ghost"
        className={props.active === 'todo' ? 'active' : ''}
        aria-current={props.active === 'todo' ? 'page' : undefined}
        onClick={() => props.onChange('todo')}
      >
        <ListTodo /><span>{t('navigation.progress')}</span>
      </Button>
    </nav>
  );
}

function connectionLabel(state: string, t: TFunction): string {
  if (state === 'online') return t('connection.online');
  if (state === 'connecting') return t('connection.connecting');
  if (state === 'outdated') return t('connection.outdated');
  return t('connection.reconnecting');
}
