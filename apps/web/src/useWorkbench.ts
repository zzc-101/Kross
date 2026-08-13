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
import { navigate, readRoute, type WorkbenchRoute } from './routeState';

export function useWorkbench(devUserId: string) {
  const api = useMemo(() => new WorkApiClient({ devUserId }), [devUserId]);
  const [organizationId, setOrganizationId] = useState('');
  const [memberships, setMemberships] = useState<Awaited<ReturnType<WorkApiClient['me']>>['memberships']>([]);
  const [route, setRoute] = useState<WorkbenchRoute>(() => typeof location === 'undefined' ? { view: 'home' } : readRoute(location));
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [task, setTask] = useState<TaskSnapshot>();
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [resolvedApprovalIds, setResolvedApprovalIds] = useState<Set<string>>(
    () => new Set()
  );
  const [runState, dispatch] = useReducer(reducePublicEvent, initialRunViewState);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'retrying'>('connecting');
  const [loading, setLoading] = useState(true);
  const [needsOrganization, setNeedsOrganization] = useState(false);
  const [error, setError] = useState<string>();

  const guarded = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    setError(undefined);
    try { return await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求失败'); return undefined; }
  }, []);

  useEffect(() => {
    setLoading(true);
    void guarded(() => api.me()).then((bootstrap) => {
      if (bootstrap) setMemberships(bootstrap.memberships);
      const requested = typeof localStorage === 'undefined' ? undefined : localStorage.getItem(`kross.organization.${devUserId}`);
      const first = bootstrap?.memberships.find((item) => item.organizationId === requested)?.organizationId ?? bootstrap?.memberships[0]?.organizationId;
      if (first) { api.selectOrganization(first); setOrganizationId(first); setNeedsOrganization(false); }
      else if (bootstrap) setNeedsOrganization(true);
    }).finally(() => setLoading(false));
  }, [api, guarded]);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute(location));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!organizationId) return;
    api.selectOrganization(organizationId);
    void guarded(() => api.listProjects()).then((items) => {
      if (!items) return;
      setProjects(items);
      setProjectId((current) => route.view === 'task' && items.some((item) => item.id === route.projectId)
        ? route.projectId : current && items.some((item) => item.id === current) ? current : items[0]?.id || '');
    });
  }, [api, guarded, organizationId, route]);

  useEffect(() => {
    if (!projectId) { setTasks([]); setSources([]); setTask(undefined); return; }
    setTask(undefined);
    setMessages([]);
    setArtifacts([]);
    setApprovals([]);
    dispatch({ kind: 'reset' });
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
    dispatch({ kind: 'reset' });
    setTask(selected);
    setResolvedApprovalIds(new Set());
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
    if (route.view !== 'task' || route.projectId !== projectId || !route.taskId || task?.id === route.taskId) return;
    void selectTask(route.taskId);
  }, [projectId, route, task?.id, selectTask]);

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

  const bootstrapOrganization = useCallback(async (name: string, slug: string) => {
    const bootstrap = await guarded(() => api.bootstrapOrganization({ name, slug }));
    if (!bootstrap) return false;
    setMemberships(bootstrap.memberships);
    const first = bootstrap.memberships[0]?.organizationId;
    if (!first) return false;
    api.selectOrganization(first);
    setOrganizationId(first);
    setNeedsOrganization(false);
    localStorage.setItem(`kross.organization.${devUserId}`, first);
    return true;
  }, [api, guarded, devUserId]);

  const createProject = useCallback(async (name: string) => {
    const project = await guarded(() => api.createProject({ name }));
    if (project) { setProjects((items) => [project, ...items]); setProjectId(project.id); navigate({ view: 'task', projectId: project.id }); }
  }, [api, guarded]);

  const createTask = useCallback(async (title: string, objective: string) => {
    if (!projectId) return;
    const created = await guarded(() => api.createTask(projectId, { type: 'general', title, objective }));
    if (created) { setTasks((items) => [created, ...items]); navigate({ view: 'task', projectId, taskId: created.id }); await selectTask(created.id); }
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

  const refreshApprovals = useCallback(async () => {
    if (!task?.latestRunId) { setApprovals([]); return; }
    const items = await api.listApprovals(task.latestRunId);
    setApprovals(items);
  }, [api, task?.latestRunId]);

  const decideApproval = useCallback(async (
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string
  ) => {
    await api.decideApproval(approvalId, decision, reason);
    // This is based on the authoritative successful response, not an optimistic update.
    setResolvedApprovalIds((current) => new Set(current).add(approvalId));
    await refreshApprovals();
    if (task?.latestRunId) {
      const run = await api.getRun(task.latestRunId);
      dispatch({ kind: 'snapshot', run });
    }
  }, [api, refreshApprovals, task?.latestRunId]);

  const selectOrganization = useCallback((nextOrganizationId: string) => {
    if (!memberships.some((item) => item.organizationId === nextOrganizationId)) return;
    localStorage.setItem(`kross.organization.${devUserId}`, nextOrganizationId);
    api.selectOrganization(nextOrganizationId);
    setOrganizationId(nextOrganizationId);
    setProjects([]); setProjectId(''); setTasks([]); setTask(undefined); setMessages([]);
    setSources([]); setArtifacts([]); setApprovals([]); dispatch({ kind: 'reset' });
    navigate({ view: 'home' });
  }, [api, devUserId, memberships]);

  const selectProject = useCallback((nextProjectId: string) => {
    setProjectId(nextProjectId);
    navigate({ view: 'task', projectId: nextProjectId });
  }, []);

  const chooseTask = useCallback(async (taskId: string) => {
    if (!projectId) return;
    navigate({ view: 'task', projectId, taskId });
    await selectTask(taskId);
  }, [projectId, selectTask]);

  const showHome = useCallback(() => navigate({ view: 'home' }), []);

  const appendMessage = useCallback(async (text: string) => {
    if (!task || !text.trim()) return false;
    const message = await guarded(() => api.appendMessage(task.id, text.trim()));
    if (!message) return false;
    setMessages((items) => [...items, message]);
    return true;
  }, [api, guarded, task]);

  const uploadSource = useCallback(async (file: File) => {
    if (!projectId) return false;
    const source = await guarded(() => api.uploadSource(projectId, file));
    if (!source) return false;
    setSources((items) => [source, ...items.filter((item) => item.id !== source.id)]);
    return true;
  }, [api, guarded, projectId]);

  const createInlineSource = useCallback(async (displayName: string, content: string) => {
    if (!projectId) return false;
    const source = await guarded(() => api.createInlineSource(projectId, displayName, content));
    if (!source) return false;
    setSources((items) => [source, ...items]);
    return true;
  }, [api, guarded, projectId]);

  const openArtifact = useCallback(async (artifactId: string) => {
    const url = await guarded(() => api.openArtifact(artifactId));
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, [api, guarded]);

  return {
    organizationId, memberships, selectOrganization, projects, projectId, selectProject, tasks, task, selectTask: chooseTask,
    route, showHome,
    messages: [...messages, ...runState.messages], sources,
    artifacts: mergeById(artifacts, runState.artifacts),
    approvals: mergeById(approvals, runState.approvals).filter(
      (approval) => !resolvedApprovalIds.has(approval.id)
    ),
    runState, connection, loading, error, needsOrganization, bootstrapOrganization, createProject, createTask, startRun,
    cancelRun, decideApproval, appendMessage, uploadSource, createInlineSource, openArtifact
  };
}

function mergeById<T extends { id: string }>(left: T[], right: T[]): T[] {
  return [...new Map([...left, ...right].map((item) => [item.id, item])).values()];
}
