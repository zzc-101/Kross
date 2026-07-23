import {
  type AgentResult,
  type CloudWorkspace,
  type EventEnvelope,
  type SessionSnapshot,
  type WorkspaceProgress
} from '@kross/protocol';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import { CloudClient, type ConnectionState } from './cloudClient';

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
  sessions: SessionSnapshot['summary'][];
  snapshot?: SessionSnapshot;
  messages: UiMessage[];
  traces: Array<{ id: string; type: string; payload: Record<string, unknown> }>;
  inspection?: { kind: 'trace' | 'diff'; content: string };
  workspaceProgress?: WorkspaceProgress;
  lastResult?: AgentResult;
  error?: string;
  running: boolean;
}

type Action =
  | { type: 'event'; envelope: EventEnvelope }
  | { type: 'select-workspace'; id: string }
  | { type: 'optimistic-user'; text: string }
  | { type: 'clear-error' }
  | { type: 'clear-inspection' }
  | { type: 'clear-workspace-progress' };

const initialState: CloudState = {
  workspaces: [],
  sessions: [],
  messages: [],
  traces: [],
  running: false
};

function reducer(state: CloudState, action: Action): CloudState {
  if (action.type === 'select-workspace') {
    return {
      ...state,
      workspaceId: action.id,
      sessions: [],
      snapshot: undefined,
      messages: [],
      traces: [],
      lastResult: undefined
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
  if (action.type === 'clear-error') return { ...state, error: undefined };
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
        snapshot: event.data,
        sessions: [
          event.data.summary,
          ...state.sessions.filter((session) => session.id !== event.data.summary.id)
        ],
        messages: [...persistedMessages, ...unpersistedMessages],
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
        ]
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
      return { ...state, running: false, error: event.message };
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
  const client = useMemo(() => new CloudClient(endpoint, token), [endpoint, token]);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const offEvent = client.onEvent((event) => dispatch({ type: 'event', envelope: event }));
    const offState = client.onState(setConnection);
    client.connect();
    return () => {
      offEvent();
      offState();
      client.close();
    };
  }, [client]);

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      client.clearActiveSession();
      dispatch({ type: 'select-workspace', id: workspaceId });
      client.send({ type: 'session.list', workspaceId, limit: 50 });
    },
    [client]
  );

  const resumeSession = useCallback(
    (workspaceId: string, sessionId: string) => {
      client.setActiveSession(workspaceId, sessionId);
      client.send({ type: 'session.resume', workspaceId, sessionId, lastSeq: 0 });
    },
    [client]
  );

  const createSession = useCallback(
    (workspaceId: string) => {
      client.send({ type: 'session.create', workspaceId });
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
    clearError: () => dispatch({ type: 'clear-error' }),
    clearInspection: () => dispatch({ type: 'clear-inspection' }),
    clearWorkspaceProgress: () =>
      dispatch({ type: 'clear-workspace-progress' })
  };
}
