import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { InspectionPanel } from './InspectionPanel';
import { ActionDialog, type DialogAction } from './OperationDialog';
import { SetupPanel } from './SetupPanel';
import { AppLayout } from './components/app/AppLayout';
import {
  WorkspaceForm,
  WorkspaceProgressPanel
} from './components/workspace/WorkspacePanels';
import { usePwa } from './pwa';
import { fetchSetupStatus, type SetupStatus } from './setupApi';
import { parseWebSlashCommand } from './slashCommands';
import { useCloud } from './useCloud';

interface AppProps {
  endpoint: string;
  token: string;
  onLogout: () => void;
}

export function App({ endpoint, token, onLogout }: AppProps) {
  const { t } = useTranslation();
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

  const sendSessionSettings = (settings: {
    mode?: 'auto' | 'plan' | 'conductor';
    model?: string;
    thinkingEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    permissionMode?: 'default' | 'classifier' | 'auto';
  }) => {
    if (!state.workspaceId || !state.snapshot) return;
    client.send({
      type: 'session.settings',
      workspaceId: state.workspaceId,
      sessionId: state.snapshot.summary.id,
      ...settings
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (!value || state.running) return;
    if (!value.startsWith('/')) {
      cloud.sendInput(value);
      setInput('');
      return;
    }

    const { command, argument } = parseWebSlashCommand(value);
    if (!command) {
      cloud.appendLocalMessage('system', t('commands.unknown', {
        command: value.split(/\s+/)[0]
      }));
      setInput('');
      return;
    }

    const rejectUsage = () =>
      cloud.appendLocalMessage('system', t('commands.usage', {
        usage: command.usage
      }));
    if (command.id === 'help') {
      cloud.appendLocalMessage('agent', t('commands.helpText'));
    } else if (command.id === 'new') {
      if (state.workspaceId) cloud.createSession(state.workspaceId);
    } else if (command.id === 'mode') {
      if (['auto', 'plan', 'conductor'].includes(argument)) {
        sendSessionSettings({ mode: argument as 'auto' | 'plan' | 'conductor' });
      } else {
        rejectUsage();
      }
    } else if (command.id === 'model') {
      if (argument) {
        if (state.models.some((model) => model.id === argument)) {
          sendSessionSettings({ model: argument });
        } else {
          cloud.appendLocalMessage('system', t('commands.modelUnavailable', {
            model: argument
          }));
        }
      } else if (state.models.length === 0) {
        cloud.appendLocalMessage('system', t('commands.noConfiguredModels'));
      } else {
        setDialogAction({
          kind: 'model',
          model: state.models.some((model) => model.id === state.snapshot?.model)
            ? state.snapshot!.model!
            : state.models[0]!.id,
          options: state.models.map((model) => model.id)
        });
      }
    } else if (command.id === 'think') {
      if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(argument)) {
        sendSessionSettings({
          thinkingEffort: argument as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
        });
      } else {
        rejectUsage();
      }
    } else if (command.id === 'perm') {
      if (['default', 'classifier', 'auto'].includes(argument)) {
        sendSessionSettings({
          permissionMode: argument as 'default' | 'classifier' | 'auto'
        });
      } else {
        rejectUsage();
      }
    } else if (command.id === 'context') {
      const usage = state.snapshot?.contextUsage;
      cloud.appendLocalMessage(
        'agent',
        usage
          ? t('commands.contextReport', {
              used: usage.usedTokens.toLocaleString(),
              max: usage.maxTokens.toLocaleString(),
              threshold: usage.compactThreshold.toLocaleString(),
              percent: Math.round(usage.headerRatio * 100)
            })
          : t('commands.contextUnavailable')
      );
    } else if (command.id === 'compact') {
      if (state.workspaceId && state.snapshot) {
        client.send({
          type: 'session.compact',
          workspaceId: state.workspaceId,
          sessionId: state.snapshot.summary.id,
          ...(argument ? { instructions: argument } : {})
        });
      }
    } else if (command.id === 'status') {
      cloud.appendLocalMessage('agent', t('commands.statusReport', {
        mode: state.snapshot?.mode ?? '-',
        model: state.snapshot?.model ?? '-',
        thinking: state.snapshot?.thinkingEffort ?? '-',
        permission: state.snapshot?.permissionMode ?? '-',
        todos: state.snapshot?.todos.length ?? 0,
        running: state.running ? t('status.running') : t('execution.idle')
      }));
    } else if (
      command.id === 'instructions' ||
      command.id === 'skills' ||
      command.id === 'processes' ||
      command.id === 'undo'
    ) {
      if (state.workspaceId && state.snapshot) {
        client.send({
          type: 'session.runtime-command',
          workspaceId: state.workspaceId,
          sessionId: state.snapshot.summary.id,
          name: command.id,
          ...(argument ? { argument } : {})
        });
      }
    } else if (command.id === 'diff' || command.id === 'trace') {
      inspect(command.id);
    }
    setInput('');
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
    if (!config.vapidPublicKey) {
      throw new Error(t('notifications.gatewayNotConfigured'));
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(config.vapidPublicKey)
    });
    const serialized = subscription.toJSON();
    if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
      throw new Error(t('notifications.incompleteSubscription'));
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
      <AppLayout
        cloud={cloud}
        pwa={pwa}
        setupStatus={setupStatus}
        selectedWorkspace={selectedWorkspace}
        visibleSessions={visibleSessions}
        input={input}
        onInputChange={setInput}
        onSubmit={submit}
        mobilePanel={mobilePanel}
        onMobilePanelChange={setMobilePanel}
        sessionQuery={sessionQuery}
        onSessionQueryChange={setSessionQuery}
        bottomRef={bottomRef}
        onLogout={onLogout}
        onOpenWorkspaceForm={() => setShowWorkspaceForm(true)}
        onOpenSetup={() => setShowSetup(true)}
        onDialogAction={setDialogAction}
        onInspect={inspect}
        onEnableNotifications={enableNotifications}
        onPushBranch={pushBranch}
        onCreatePullRequest={createPullRequest}
      />

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
