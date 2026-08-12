import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { Project } from './contracts';
import type {
  ApprovalSummary,
  ArtifactSummary,
  SourceSummary,
  TaskMessage,
  TaskSnapshot,
  TaskSummary
} from '@kross/protocol';

import { WorkApiClient } from './apiClient';
import { consumePublicEvents } from './eventStream';
import { initialRunViewState, reducePublicEvent } from './runReducer';

export function useWorkbench(devUserId: string) {
  const api = useMemo(() => new WorkApiClient({ devUserId }), [devUserId]);
  const [organizationId, setOrganizationId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [task, setTask] = useState<TaskSnapshot>();
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [runState, dispatch] = useReducer(reducePublicEvent, initialRunViewState);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'retrying'>('connecting');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const guarded = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    setError(undefined);
    try { return await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求失败'); return undefined; }
  }, []);

  useEffect(() => {
    setLoading(true);
    void guarded(() => api.me()).then((bootstrap) => {
      const first = bootstrap?.memberships[0]?.organizationId;
      if (first) { api.selectOrganization(first); setOrganizationId(first); }
      else if (bootstrap) setError('当前账号尚未加入任何组织');
    }).finally(() => setLoading(false));
  }, [api, guarded]);

  useEffect(() => {
    if (!organizationId) return;
    api.selectOrganization(organizationId);
    void guarded(() => api.listProjects()).then((items) => {
      if (!items) return;
      setProjects(items);
      setProjectId((current) => current || items[0]?.id || '');
    });
  }, [api, guarded, organizationId]);

  useEffect(() => {
    if (!projectId) { setTasks([]); setSources([]); return; }
    void Promise.all([
      guarded(() => api.listTasks(projectId)),
      guarded(() => api.listSources(projectId))
    ]).then(([taskItems, sourceItems]) => {
      if (taskItems) setTasks(taskItems);
      if (sourceItems) setSources(sourceItems);
    });
  }, [api, guarded, projectId]);

  const selectTask = useCallback(async (taskId: string) => {
    const selected = await guarded(() => api.getTask(taskId));
    if (!selected) return;
    setTask(selected);
    const [messageItems, artifactItems] = await Promise.all([
      guarded(() => api.listMessages(taskId)),
      guarded(() => api.listArtifacts(taskId))
    ]);
    if (messageItems) setMessages(messageItems);
    if (artifactItems) setArtifacts(artifactItems);
    if (selected.latestRunId) {
      const run = await guarded(() => api.getRun(selected.latestRunId!));
      if (run) dispatch({ kind: 'snapshot', run });
      const approvalItems = await guarded(() => api.listApprovals(selected.latestRunId));
      if (approvalItems) setApprovals(approvalItems);
    }
  }, [api, guarded]);

  useEffect(() => {
    if (!organizationId || !task?.latestRunId) return;
    const controller = new AbortController();
    void consumePublicEvents({
      organizationId, devUserId, runId: task.latestRunId,
      cursor: runState.lastEventId, signal: controller.signal,
      onEvent: dispatch, onConnection: setConnection
    });
    return () => controller.abort();
  }, [devUserId, organizationId, task?.latestRunId]);

  const createProject = useCallback(async (name: string) => {
    const project = await guarded(() => api.createProject({ name }));
    if (project) { setProjects((items) => [project, ...items]); setProjectId(project.id); }
  }, [api, guarded]);

  const createTask = useCallback(async (title: string, objective: string) => {
    if (!projectId) return;
    const created = await guarded(() => api.createTask(projectId, { type: 'general', title, objective }));
    if (created) { setTasks((items) => [created, ...items]); await selectTask(created.id); }
  }, [api, guarded, projectId, selectTask]);

  const startRun = useCallback(async (mode: 'auto' | 'plan') => {
    if (!task) return;
    const run = await guarded(() => api.createRun(task.id, mode));
    if (run) {
      setTask({ ...task, latestRunId: run.id, runCount: task.runCount + 1 });
      dispatch({ kind: 'snapshot', run });
    }
  }, [api, guarded, task]);

  const cancelRun = useCallback(async () => {
    if (!task?.latestRunId) return;
    await guarded(() => api.cancelRun(task.latestRunId!));
    await selectTask(task.id);
  }, [api, guarded, selectTask, task]);

  return {
    organizationId, projects, projectId, setProjectId, tasks, task, selectTask,
    messages: [...messages, ...runState.messages], sources,
    artifacts: mergeById(artifacts, runState.artifacts),
    approvals: mergeById(approvals, runState.approvals),
    runState, connection, loading, error, createProject, createTask, startRun, cancelRun
  };
}

function mergeById<T extends { id: string }>(left: T[], right: T[]): T[] {
  return [...new Map([...left, ...right].map((item) => [item.id, item])).values()];
}
