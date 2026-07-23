import {
  type AgentResult,
  type CloudWorkspace,
  type EventEnvelope,
  type SessionSnapshot,
  type WorkspaceProgress
} from '@kross/protocol';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import { CloudClient, type ConnectionState } from './cloudClient';
import { checkForPwaUpdate } from './pwa';

export interface UiMessage {
  id: string;
  from: 'user' | 'agent' | 'system' | 'tool' | 'thinking';
  text: string;
  streaming?: boolean;
  transient?: boolean;
}

interface CloudState {
  workspaces: CloudWorkspace[];
  workspaceId?: string;
  activeSessionId?: string;
  pendingSessionCreateRequestId?: string;
  sessions: SessionSnapshot['summary'][];
  models: Array<{ id: string; label: string; provider: string }>;
  snapshot?: SessionSnapshot;
  messages: UiMessage[];
  traces: Array<{ id: string; type: string; payload: Record<string, unknown> }>;
  inspection?: Extract<
    EventEnvelope['event'],
    { type: 'inspection.result' }
  >['data'];
  workspaceProgress?: WorkspaceProgress;
  lastResult?: AgentResult;
  errors: Array<{ id: string; message: string }>;
  running: boolean;
}

type Action =
  | { type: 'event'; envelope: EventEnvelope }
  | { type: 'select-workspace'; id: string }
  | { type: 'select-session'; id: string }
  | { type: 'creating-session'; requestId: string }
  | { type: 'optimistic-user'; text: string }
  | { type: 'clear-error'; id: string }
  | { type: 'clear-inspection' }
  | { type: 'clear-workspace-progress' };

const initialState: CloudState = {
  workspaces: [],
  sessions: [],
  models: [],
  messages: [],
  traces: [],
  errors: [],
  running: false
};

function reducer(state: CloudState, action: Action): CloudState {
  if (action.type === 'select-workspace') {
    return {
      ...state,
      workspaceId: action.id,
      activeSessionId: undefined,
      pendingSessionCreateRequestId: undefined,
      sessions: [],
      snapshot: undefined,
      messages: [],
      traces: [],
      lastResult: undefined
    };
  }
  if (action.type === 'select-session') {
    return {
      ...state,
      activeSessionId: action.id,
      snapshot: undefined,
      messages: [],
      traces: [],
      lastResult: undefined
    };
  }
  if (action.type === 'creating-session') {
    return {
      ...state,
      pendingSessionCreateRequestId: action.requestId
    };
  }
  if (action.type === 'optimistic-user') {
    return {
      ...state,
      running: true,
      messages: [
        ...state.messages,
        {
          id: crypto.randomUUID(),
          from: 'user',
          text: action.text,
          transient: true
        }
      ]
    };
  }
  if (action.type === 'clear-error') {
    return {
      ...state,
      errors: state.errors.filter((error) => error.id !== action.id)
    };
  }
  if (action.type === 'clear-inspection') {
    return { ...state, inspection: undefined };
  }
  if (action.type === 'clear-workspace-progress') {
    const failedId =
      state.workspaceProgress?.stage === 'failed'
        ? state.workspaceProgress.workspaceId
        : undefined;
    const workspaces = failedId
      ? state.workspaces.filter((workspace) => workspace.id !== failedId)
      : state.workspaces;
    return {
      ...state,
      workspaces,
      workspaceId:
        state.workspaceId === failedId
          ? workspaces[0]?.id
          : state.workspaceId,
      workspaceProgress: undefined
    };
  }
  const { event } = action.envelope;
  if (
    action.envelope.sessionId &&
    event.type !== 'session.updated' &&
    action.envelope.sessionId !== state.activeSessionId &&
    !(
      event.type === 'session.snapshot' &&
      action.envelope.correlationId === state.pendingSessionCreateRequestId
    )
  ) {
    return state;
  }
  switch (event.type) {
    case 'workspace.list':
      return {
        ...state,
        workspaces: event.data,
        workspaceId: state.workspaceId ?? event.data[0]?.id
      };
    case 'workspace.updated': {
      const workspaces = [
        event.data,
        ...state.workspaces.filter((workspace) => workspace.id !== event.data.id)
      ];
      return { ...state, workspaces, workspaceId: state.workspaceId ?? event.data.id };
    }
    case 'workspace.progress':
      return { ...state, workspaceProgress: event.data };
    case 'session.list':
      return { ...state, sessions: event.data };
    case 'models.list':
      return { ...state, models: event.data };
    case 'session.updated': {
      const sessions = [
        event.data,
        ...state.sessions.filter((session) => session.id !== event.data.id)
      ];
      return {
        ...state,
        sessions,
        snapshot:
          state.snapshot?.summary.id === event.data.id
            ? { ...state.snapshot, summary: event.data }
            : state.snapshot
      };
    }
    case 'session.deleted': {
      const isActive = state.activeSessionId === event.data.sessionId;
      return {
        ...state,
        sessions: state.sessions.filter(
          (session) => session.id !== event.data.sessionId
        ),
        ...(isActive
          ? {
              activeSessionId: undefined,
              snapshot: undefined,
              messages: [],
              traces: [],
              lastResult: undefined
            }
          : {})
      };
    }
    case 'session.snapshot':
      const persistedMessages = event.data.messages.map((message) => ({
        id: String(message.id),
        from: message.from,
        text: message.text
      }));
      const unpersistedMessages = state.messages.filter(
        (message) =>
          message.transient &&
          !persistedMessages.some(
            (persisted) =>
              persisted.from === message.from && persisted.text === message.text
          )
      );
      return {
        ...state,
        workspaceId: action.envelope.workspaceId,
        activeSessionId: action.envelope.sessionId,
        pendingSessionCreateRequestId: undefined,
        snapshot: event.data,
        sessions: [
          event.data.summary,
          ...state.sessions.filter((session) => session.id !== event.data.summary.id)
        ],
        messages: [...persistedMessages, ...unpersistedMessages],
        traces: event.data.traces.map((trace) => ({
          id: trace.id,
          type: trace.type,
          payload: trace.payload
        })),
        running: false
      };
    case 'stream':
      return applyStream(state, event.data);
    case 'trace':
      return {
        ...state,
        traces: [
          ...state.traces.filter((trace) => trace.id !== event.data.id),
          event.data
        ].slice(-200)
      };
    case 'approval.pending':
      return {
        ...state,
        running: false,
        snapshot: state.snapshot
          ? { ...state.snapshot, pendingApproval: event.data }
          : state.snapshot
      };
    case 'todo.snapshot':
      return {
        ...state,
        snapshot: state.snapshot
          ? { ...state.snapshot, todos: event.data }
          : state.snapshot
      };
    case 'inspection.result':
      return { ...state, inspection: event.data };
    case 'git.result':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            from: 'system',
            text: `${event.data.operation === 'push' ? 'Git Push' : 'Pull Request'} ${event.data.ok ? '完成' : '失败'}\n\n${event.data.url ?? event.data.output}`
          }
        ]
      };
    case 'request.error':
      const errorId =
        action.envelope.correlationId ??
        event.requestId ??
        crypto.randomUUID();
      return {
        ...state,
        running: false,
        errors: [
          ...state.errors.filter((error) => error.id !== errorId),
          {
            id: errorId,
            message: event.message
          }
        ].slice(-5)
      };
    default:
      return state;
  }
}

function applyStream(
  state: CloudState,
  event: Extract<EventEnvelope['event'], { type: 'stream' }>['data']
): CloudState {
  if (event.type === 'turn-start') {
    return {
      ...state,
      running: true,
      messages: state.messages.map((message) => ({
        ...message,
        streaming: false
      }))
    };
  }
  if (event.type === 'thinking-delta' || event.type === 'text-delta') {
    const from = event.type === 'thinking-delta' ? 'thinking' : 'agent';
    const last = state.messages.at(-1);
    if (last?.streaming && last.from === from) {
      return {
        ...state,
        messages: [
          ...state.messages.slice(0, -1),
          { ...last, text: last.text + event.text }
        ]
      };
    }
    return {
      ...state,
      messages: [
        ...state.messages.map((message) => ({ ...message, streaming: false })),
        {
          id: crypto.randomUUID(),
          from,
          text: event.text,
          streaming: true,
          transient: true
        }
      ]
    };
  }
  if (event.type === 'tools-start') {
    return {
      ...state,
      messages: state.messages.map((message) => ({ ...message, streaming: false }))
    };
  }
  const pendingPlan =
    event.result.cancellationReason === 'approval-gate'
      ? state.snapshot?.pendingPlan
      : undefined;
  return {
    ...state,
    running: false,
    lastResult: event.result,
    messages: state.messages.map((message) => ({ ...message, streaming: false })),
    snapshot: state.snapshot
      ? {
          ...state.snapshot,
          pendingApproval: event.result.pendingApproval,
          pendingPlan
        }
      : state.snapshot
  };
}

export function useCloud(endpoint: string, token: string) {
  const client = useMemo(
    () =>
      new CloudClient(endpoint, token, {
        onProtocolMismatch: () => void checkForPwaUpdate()
      }),
    [endpoint, token]
  );
  const [state, dispatch] = useReducer(reducer, initialState);
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  useEffect(() => {
    let pendingDelta: EventEnvelope | undefined;
    let animationFrame: number | undefined;
    const flushDelta = () => {
      animationFrame = undefined;
      if (!pendingDelta) return;
      dispatch({ type: 'event', envelope: pendingDelta });
      pendingDelta = undefined;
    };
    const offEvent = client.onEvent((event) => {
      if (isStreamDelta(event)) {
        const merged = pendingDelta
          ? mergeStreamDeltas(pendingDelta, event)
          : undefined;
        if (pendingDelta && !merged) flushDelta();
        pendingDelta = merged ?? event;
        animationFrame ??= requestAnimationFrame(flushDelta);
        return;
      }
      flushDelta();
      dispatch({ type: 'event', envelope: event });
    });
    const offState = client.onState(setConnection);
    client.connect();
    return () => {
      offEvent();
      offState();
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      client.close();
    };
  }, [client]);

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      client.clearActiveSession();
      dispatch({ type: 'select-workspace', id: workspaceId });
      client.send({ type: 'session.list', workspaceId, limit: 50 });
      client.send({ type: 'models.list', workspaceId });
    },
    [client]
  );

  const resumeSession = useCallback(
    (workspaceId: string, sessionId: string) => {
      client.setActiveSession(workspaceId, sessionId);
      dispatch({ type: 'select-session', id: sessionId });
      client.send({ type: 'session.resume', workspaceId, sessionId, lastSeq: 0 });
    },
    [client]
  );

  const createSession = useCallback(
    (workspaceId: string) => {
      const requestId = client.send({ type: 'session.create', workspaceId });
      dispatch({ type: 'creating-session', requestId });
    },
    [client]
  );

  const sendInput = useCallback(
    (text: string, planApproved = false) => {
      if (!state.workspaceId || !state.snapshot) return;
      if (!planApproved) {
        dispatch({ type: 'optimistic-user', text });
      }
      client.send({
        type: 'session.input',
        workspaceId: state.workspaceId,
        sessionId: state.snapshot.summary.id,
        input: text,
        mode: state.snapshot.mode,
        planApproved
      });
    },
    [client, state.snapshot, state.workspaceId]
  );

  return {
    state,
    connection,
    client,
    selectWorkspace,
    resumeSession,
    createSession,
    sendInput,
    clearError: (id: string) => dispatch({ type: 'clear-error', id }),
    clearInspection: () => dispatch({ type: 'clear-inspection' }),
    clearWorkspaceProgress: () =>
      dispatch({ type: 'clear-workspace-progress' })
  };
}

function isStreamDelta(envelope: EventEnvelope): boolean {
  return (
    envelope.event.type === 'stream' &&
    (
      envelope.event.data.type === 'text-delta' ||
      envelope.event.data.type === 'thinking-delta'
    )
  );
}

function mergeStreamDeltas(
  previous: EventEnvelope,
  next: EventEnvelope
): EventEnvelope | undefined {
  if (
    previous.workspaceId !== next.workspaceId ||
    previous.sessionId !== next.sessionId ||
    previous.event.type !== 'stream' ||
    next.event.type !== 'stream' ||
    (
      previous.event.data.type !== 'text-delta' &&
      previous.event.data.type !== 'thinking-delta'
    ) ||
    previous.event.data.type !== next.event.data.type
  ) {
    return undefined;
  }
  return {
    ...next,
    event: {
      type: 'stream',
      data: {
        ...next.event.data,
        text: previous.event.data.text + next.event.data.text
      }
    }
  };
}
