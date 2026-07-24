import type { CloudWorkspace } from '@kross/protocol';
import type { TFunction } from 'i18next';
import {
  Activity,
  Bell,
  ChevronDown,
  ChevronRight,
  Command,
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
  ShieldCheck,
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
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DialogAction } from '../../OperationDialog';
import { approvalIdentity } from '../../approvalIdentity';
import { applyPwaUpdate, installPwa, type usePwa } from '../../pwa';
import { sessionPresentationState } from '../../sessionPresentation';
import type { SetupStatus } from '../../setupApi';
import { filterWebSlashCommands, type WebSlashCommand } from '../../slashCommands';
import { latestToolActivities } from '../../toolActivity';
import { deriveSubagentActivities } from '../../subagentActivity';
import { groupMessagesForDisplay } from '../../messageGrouping';
import type { useCloud } from '../../useCloud';
import {
  ApprovalCard,
  Message
} from '../session/SessionSurface';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import { EmptyState } from '../workspace/WorkspacePanels';
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
        selectedWorkspace={props.selectedWorkspace}
        onDialogAction={props.onDialogAction}
      />

      <main className="layout">
        <SessionSidebar
          state={state}
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
  selectedWorkspace?: CloudWorkspace;
  onLogout: () => void;
  onOpenWorkspaceForm: () => void;
  onOpenSetup: () => void;
  onDialogAction: Dispatch<SetStateAction<DialogAction | undefined>>;
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="icon-button"
              aria-label={t('header.workspaceActions')}
            >
              <Plus /> {t('header.addWorkspace')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={props.onOpenWorkspaceForm}>
              <Plus /> {t('workspace.add')}
            </DropdownMenuItem>
            {props.selectedWorkspace && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{props.selectedWorkspace.name}</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => props.cloud.client.send({
                    type: props.selectedWorkspace!.status === 'stopped'
                      ? 'workspace.start'
                      : 'workspace.stop',
                    workspaceId: props.selectedWorkspace!.id
                  })}
                >
                  <Square />
                  {props.selectedWorkspace.status === 'stopped'
                    ? t('workspace.start')
                    : t('workspace.stop')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() =>
                    props.onDialogAction({
                      kind: 'delete-workspace',
                      workspaceId: props.selectedWorkspace!.id,
                      name: props.selectedWorkspace!.name,
                      removeVolume: false
                    })
                  }
                >
                  <Trash2 /> {t('common.delete')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
  const presentationState = sessionPresentationState(props.state);
  const pendingSessionTitle = props.state.sessions.find(
    (session) => session.id === props.state.activeSessionId
  )?.title;
  const configuredModel = props.state.models.find(
    (model) => model.id === snapshot?.model
  );
  const slashCommands = filterWebSlashCommands(props.input);
  const [selectedSlashCommand, setSelectedSlashCommand] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [modelPanelSection, setModelPanelSection] = useState<
    'model' | 'thinking' | 'mode'
  >();
  const displayMessages = groupMessagesForDisplay(props.state.messages);
  useEffect(() => {
    setSelectedSlashCommand(0);
    setSlashDismissed(false);
  }, [props.input]);
  const showSlashCommands = slashCommands.length > 0 && !slashDismissed;
  const chooseSlashCommand = (command: WebSlashCommand) => {
    props.onInputChange(`${command.name}${command.acceptsArgument ? ' ' : ''}`);
  };
  return (
    <section className={`chat ${props.mobilePanel === 'chat' ? 'mobile-active' : ''}`}>
      {!snapshot ? (
        presentationState === 'loading' ? (
          <SessionLoadingState title={pendingSessionTitle} />
        ) : (
          <EmptyState
            hasWorkspace={Boolean(props.state.workspaceId)}
            setupStatus={props.setupStatus}
            onCreate={() => props.state.workspaceId && props.cloud.createSession(props.state.workspaceId)}
            onAddWorkspace={props.onOpenWorkspaceForm}
            onOpenSetup={props.onOpenSetup}
          />
        )
      ) : (
        <>
          <div className="chat-head">
            <h1>{snapshot.summary.title}</h1>
          </div>
          <div className="messages">
            {displayMessages.map(({ message, thinking }) => (
              <Message key={message.id} message={message} thinking={thinking} />
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
              key={approvalIdentity(snapshot.pendingApproval)}
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
          <div className="composer-wrap">
            {showSlashCommands && (
              <div className="slash-menu" role="listbox" aria-label={t('commands.menu')}>
                {slashCommands.map((command, index) => (
                  <button
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={selectedSlashCommand === index}
                    className={selectedSlashCommand === index ? 'active' : ''}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSlashCommand(command)}
                  >
                    <code>{command.name}</code>
                    <span>{t(`commands.${command.id}`)}</span>
                    <small>{command.usage}</small>
                  </button>
                ))}
              </div>
            )}
            <form className="composer" onSubmit={props.onSubmit}>
              <Textarea
                className="composer-input"
                value={props.input}
                onChange={(event) => props.onInputChange(event.target.value)}
                onKeyDown={(event) => {
                  if (showSlashCommands && event.key === 'ArrowDown') {
                    event.preventDefault();
                    setSelectedSlashCommand((selectedSlashCommand + 1) % slashCommands.length);
                    return;
                  }
                  if (showSlashCommands && event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSelectedSlashCommand(
                      (selectedSlashCommand - 1 + slashCommands.length) % slashCommands.length
                    );
                    return;
                  }
                  if (showSlashCommands && event.key === 'Escape') {
                    event.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                  if (
                    showSlashCommands &&
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    chooseSlashCommand(slashCommands[selectedSlashCommand]!);
                    return;
                  }
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
                rows={3}
              />
              <div className="composer-toolbar">
                <div className="composer-controls">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="composer-command"
                    aria-label={t('commands.open')}
                    title={t('commands.open')}
                    onClick={() => props.onInputChange('/')}
                  >
                    <Command />
                  </Button>
                  <Select
                    value={snapshot.permissionMode}
                    onValueChange={(permissionMode) =>
                      props.client.send({
                        type: 'session.settings',
                        workspaceId: props.state.workspaceId!,
                        sessionId: snapshot.summary.id,
                        permissionMode: permissionMode as 'default' | 'classifier' | 'auto'
                      })
                    }
                  >
                    <SelectTrigger className="composer-select permission-select" aria-label={t('session.permissionMode')}>
                      <ShieldCheck />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">{t('session.permissionDefault')}</SelectItem>
                      <SelectItem value="classifier">{t('session.permissionClassifier')}</SelectItem>
                      <SelectItem value="auto">{t('session.permissionAuto')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <SessionMoreMenu
                    onInspect={props.onInspect}
                    onEnableNotifications={props.onEnableNotifications}
                    onPushBranch={props.onPushBranch}
                    onCreatePullRequest={props.onCreatePullRequest}
                  />
                </div>
                <div className="composer-actions">
                  <DropdownMenu
                    open={modelPanelOpen}
                    onOpenChange={(open) => {
                      setModelPanelOpen(open);
                      if (!open) setModelPanelSection(undefined);
                    }}
                  >
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="composer-model-trigger"
                        aria-label={t('session.modelAndThinking')}
                      >
                        <span className="composer-model-name">
                          {configuredModel?.label ?? t('session.selectConfiguredModel')}
                        </span>
                        <span className="composer-effort">
                          {thinkingEffortLabel(snapshot.thinkingEffort ?? 'off', t)}
                        </span>
                        <ChevronDown />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      side="top"
                      className="composer-model-panel"
                    >
                      <DropdownMenuItem
                        className="composer-setting-row"
                        onSelect={(event) => {
                          event.preventDefault();
                          setModelPanelSection(
                            modelPanelSection === 'model' ? undefined : 'model'
                          );
                        }}
                      >
                        <strong>{t('session.model')}</strong>
                        <span>
                          {configuredModel?.label ?? t('session.selectConfiguredModel')}
                        </span>
                        <ChevronRight />
                      </DropdownMenuItem>
                      {modelPanelSection === 'model' && (
                        <DropdownMenuRadioGroup
                          className="composer-panel-options"
                          value={configuredModel?.id ?? ''}
                          onValueChange={(model) => {
                            props.client.send({
                              type: 'session.settings',
                              workspaceId: props.state.workspaceId!,
                              sessionId: snapshot.summary.id,
                              model
                            });
                            setModelPanelOpen(false);
                          }}
                        >
                          {props.state.models.length === 0 ? (
                            <DropdownMenuItem disabled>
                              {t('session.noConfiguredModels')}
                            </DropdownMenuItem>
                          ) : (
                            props.state.models.map((model) => (
                              <DropdownMenuRadioItem key={model.id} value={model.id}>
                                {model.label}
                              </DropdownMenuRadioItem>
                            ))
                          )}
                        </DropdownMenuRadioGroup>
                      )}
                      <DropdownMenuItem
                        className="composer-setting-row"
                        onSelect={(event) => {
                          event.preventDefault();
                          setModelPanelSection(
                            modelPanelSection === 'thinking' ? undefined : 'thinking'
                          );
                        }}
                      >
                        <strong>{t('session.thinkingEffort')}</strong>
                        <span>
                          {thinkingEffortLabel(snapshot.thinkingEffort ?? 'off', t)}
                        </span>
                        <ChevronRight />
                      </DropdownMenuItem>
                      {modelPanelSection === 'thinking' && (
                        <DropdownMenuRadioGroup
                          className="composer-panel-options effort-options"
                          value={snapshot.thinkingEffort ?? 'off'}
                          onValueChange={(thinkingEffort) => {
                            props.client.send({
                              type: 'session.settings',
                              workspaceId: props.state.workspaceId!,
                              sessionId: snapshot.summary.id,
                              thinkingEffort: thinkingEffort as SessionThinkingEffort
                            });
                            setModelPanelOpen(false);
                          }}
                        >
                          {(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const).map((effort) => (
                            <DropdownMenuRadioItem key={effort} value={effort}>
                              {thinkingEffortLabel(effort, t)}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      )}
                      <DropdownMenuItem
                        className="composer-setting-row"
                        onSelect={(event) => {
                          event.preventDefault();
                          setModelPanelSection(
                            modelPanelSection === 'mode' ? undefined : 'mode'
                          );
                        }}
                      >
                        <strong>{t('session.agentMode')}</strong>
                        <span>{agentModeLabel(snapshot.mode)}</span>
                        <ChevronRight />
                      </DropdownMenuItem>
                      {modelPanelSection === 'mode' && (
                        <DropdownMenuRadioGroup
                          className="composer-panel-options"
                          value={snapshot.mode}
                          onValueChange={(mode) => {
                            props.client.send({
                              type: 'session.settings',
                              workspaceId: props.state.workspaceId!,
                              sessionId: snapshot.summary.id,
                              mode: mode as 'auto' | 'plan' | 'conductor'
                            });
                            setModelPanelOpen(false);
                          }}
                        >
                          {(['auto', 'plan', 'conductor'] as const).map((mode) => (
                            <DropdownMenuRadioItem key={mode} value={mode}>
                              {agentModeLabel(mode)}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {props.state.running ? (
                    <Button
                      type="button"
                      variant="destructive"
                      className="composer-submit"
                      onClick={() =>
                        props.client.send({
                          type: 'session.abort',
                          workspaceId: props.state.workspaceId!,
                          sessionId: snapshot.summary.id
                        })
                      }
                    >
                      <Square /> <span>{t('session.stop')}</span>
                    </Button>
                  ) : (
                    <Button className="composer-submit">
                      <Send /> <span>{t('session.send')}</span>
                    </Button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </>
      )}
    </section>
  );
}

function SessionLoadingState(props: { title?: string }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="chat-head">
        <h1>{props.title ?? t('session.loading')}</h1>
      </div>
      <div className="session-loading" role="status" aria-live="polite">
        <i />
        <span>{t('session.loading')}</span>
      </div>
    </>
  );
}

function SessionMoreMenu(props: {
  onInspect: (kind: 'trace' | 'diff', argument?: string) => void;
  onEnableNotifications: () => Promise<void>;
  onPushBranch: () => void;
  onCreatePullRequest: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="composer-command"
          aria-label={t('session.moreActions')}
          title={t('session.moreActions')}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
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
  );
}

function agentModeLabel(mode: 'auto' | 'plan' | 'conductor'): string {
  return mode === 'auto' ? 'Auto' : mode === 'plan' ? 'Plan' : 'Conductor';
}

function thinkingEffortLabel(
  effort: SessionThinkingEffort,
  t: TFunction
): string {
  return t(`session.thinkingEffortValues.${effort}`);
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
  const todos = props.state.snapshot?.todos ?? [];
  const completedTodos = todos.filter(
    (todo) => todo.status === 'completed'
  ).length;
  const todoProgress = todos.length
    ? Math.round((completedTodos / todos.length) * 100)
    : 0;
  const subagents = deriveSubagentActivities(props.state.traces);
  const contextUsage = props.state.snapshot?.contextUsage;
  const toolActivities = latestToolActivities(
    props.state.traces,
    new Set(),
    6
  ).reverse();
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
      {todos.length > 0 && <section className="details-section">
        <div className="details-heading">
          <h2>{t('execution.todos')}</h2>
          <small>{completedTodos}/{todos.length}</small>
        </div>
        <div className="todo-progress" aria-label={`${todoProgress}%`}>
          <span style={{ width: `${todoProgress}%` }} />
        </div>
        {todos.map((todo) => (
          <div className={`todo ${todo.status}`} key={todo.id}>
            <span>{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : todo.status === 'cancelled' ? '×' : '○'}</span>
            <p>{todo.content}</p>
          </div>
        ))}
      </section>}
      {subagents.length > 0 && (
        <section className="details-section">
          <div className="details-heading">
            <h2>{t('execution.subagents')}</h2>
            <small>{subagents.filter((item) => item.status === 'running').length} {t('status.running')}</small>
          </div>
          {subagents.map((activity) => (
            <div className={`subagent ${activity.status}`} key={activity.subRunId}>
              <span className="subagent-dot" />
              <div>
                <strong>{activity.title || t('execution.subagent')}</strong>
                <small>
                  {activity.currentTool
                    ? `${activity.currentTool} · ${activity.toolCount}`
                    : activity.summary || t(`status.${activity.status}`)}
                </small>
              </div>
            </div>
          ))}
        </section>
      )}
      {contextUsage && (
        <section className="details-section context-usage">
          <div className="details-heading">
            <h2>{t('execution.context')}</h2>
            <small>{contextUsage.label}</small>
          </div>
          <div className={`context-progress ${contextUsage.ratio >= .8 ? 'warning' : ''}`}>
            <span style={{ width: `${Math.min(100, contextUsage.ratio * 100)}%` }} />
          </div>
        </section>
      )}
      {toolActivities.length > 0 && (
        <section className="details-section">
          <h2>{t('execution.toolActivity')}</h2>
          {toolActivities.map((trace) => (
            <div className="trace" key={trace.id}>
              <strong>{String(trace.payload.toolName ?? trace.payload.name ?? t('session.tool'))}</strong>
              <small>{toolActivityStatus(trace.type, t)}</small>
            </div>
          ))}
        </section>
      )}
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

function toolActivityStatus(type: string, t: TFunction): string {
  const status = type.split('.').at(-1);
  if (status === 'started') return t('status.running');
  if (status === 'completed') return t('status.completed');
  if (status === 'failed') return t('status.failed');
  if (status === 'denied') return t('status.denied');
  return status ?? '';
}
