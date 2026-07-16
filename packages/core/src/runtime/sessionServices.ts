import { basename, resolve } from 'node:path';

import type { SessionContext } from '../context/sessionContext';
import type { AgentMode } from '../domain';
import { createApprovalPolicy, type PermissionMode } from '../tools/permissionModes';
import type { ToolGateway } from '../tools/toolGateway';
import {
  formatRegistryForPrompt,
  selectActiveProject
} from '../workspace/projectRegistry';
import {
  formatProjectInstructionSource,
  loadProjectInstructions,
  type ProjectInstructionsSnapshot
} from '../workspace/projectInstructions';
import type { WorkspaceRoots } from '../workspace/workspaceRoots';
import type {
  PendingConductorExecution,
  PendingModeExecution
} from '../modes/pendingExecution';
import type { TodoStore } from '../todo/todoStore';
import type { AgentRuntimeOptions } from './agentRuntimeTypes';

export interface SessionServicesOptions {
  options: AgentRuntimeOptions;
  sessionContext: SessionContext;
  toolGateway?: ToolGateway;
  emitModeChanged: (event: {
    mode: AgentMode;
    previous: AgentMode;
  }) => void;
}

/** Session-scoped policy state and prompt-source synchronization. */
export class SessionServices {
  private permissionMode: PermissionMode = 'default';
  private sessionMode: AgentMode = 'auto';
  private pendingModeExecution: PendingModeExecution | undefined;
  private projectInstructionSourceIds = new Set<string>();
  private projectInstructions = loadProjectInstructions({ roots: [] });

  constructor(private readonly deps: SessionServicesOptions) {
    this.deps.toolGateway?.setApprovalPolicy(
      createApprovalPolicy(this.permissionMode)
    );
  }

  getSessionMode(): AgentMode {
    return this.sessionMode;
  }

  setSessionMode(mode: AgentMode): void {
    if (this.sessionMode === mode) {
      this.syncSessionModeSource();
      return;
    }
    const previous = this.sessionMode;
    this.sessionMode = mode;
    this.syncSessionModeSource();
    this.deps.emitModeChanged({ mode, previous });
  }

  syncSessionModeSource(): void {
    this.deps.sessionContext.addSource({
      id: 'session-mode',
      kind: 'user',
      title: 'Session mode',
      content: [
        `当前会话 Mode：${this.sessionMode}`,
        '- auto：默认 agent 工具环',
        '- plan：先计划后开发（需确认）',
        '- conductor：高级模型拆任务 → worker 执行 → 高级模型验收',
        '用户要求切换时调用 SetMode 工具；多目录用 /add-dir，与 Mode 无关。'
      ].join('\n'),
      priority: 97,
      pinned: true
    });
  }

  getPendingModeExecution(): PendingModeExecution | undefined {
    return this.pendingModeExecution;
  }

  getPendingConductorPlan(): PendingConductorExecution | undefined {
    const pending = this.pendingModeExecution;
    return pending?.kind === 'conductor' ? pending : undefined;
  }

  setPendingModeExecution(pending: PendingModeExecution | undefined): void {
    this.pendingModeExecution = pending;
  }

  clearPendingModeExecution(): void {
    this.pendingModeExecution = undefined;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.deps.toolGateway?.setApprovalPolicy(createApprovalPolicy(mode));
  }

  getWorkspaceRoots(): WorkspaceRoots | undefined {
    return this.deps.options.workspaceRoots;
  }

  getTodoStore(): TodoStore | undefined {
    return this.deps.options.todoStore;
  }

  syncTodoContextSource(): void {
    const store = this.deps.options.todoStore;
    if (!store) {
      return;
    }
    const text = store.formatForPrompt();
    if (!text) {
      this.deps.sessionContext.removeSource('session-todos');
      return;
    }
    this.deps.sessionContext.addSource({
      id: 'session-todos',
      kind: 'user',
      title: 'Session todos',
      content: text,
      priority: 95,
      pinned: true
    });
  }

  syncProjectRegistrySource(): void {
    const { options, sessionContext } = this.deps;
    const roots = options.workspaceRoots;
    if (roots) {
      sessionContext.addSource({
        id: 'workspace-roots',
        kind: 'workspace',
        title: 'Workspace roots',
        content: roots.formatForPrompt(),
        priority: 92,
        pinned: true
      });
    } else {
      sessionContext.removeSource('workspace-roots');
    }

    const registry = options.projectRegistry;
    if (!registry) {
      sessionContext.removeSource('project-registry');
      return;
    }
    const selection = selectActiveProject(registry, {
      activeProjectId: options.activeProjectId,
      workspaceRoot: options.workspaceRoot
    });
    if (!selection) {
      sessionContext.addSource({
        id: 'project-registry',
        kind: 'repo',
        title: 'Project registry',
        content:
          'Project registry is configured but no active project could be selected. ' +
          'Set defaultProjectId or ensure workspace is inside a registered repo path.\n' +
          `Projects: ${Object.keys(registry.projects).join(', ')}`,
        priority: 90,
        pinned: true
      });
      return;
    }
    sessionContext.addSource({
      id: 'project-registry',
      kind: 'repo',
      title: 'Project registry',
      content: formatRegistryForPrompt(selection, options.projectRegistryPath),
      priority: 90,
      pinned: true
    });
  }

  refreshProjectInstructions(): ProjectInstructionsSnapshot {
    const roots = this.deps.options.workspaceRoots?.list() ??
      (this.deps.options.workspaceRoot
        ? [
            {
              id: basename(resolve(this.deps.options.workspaceRoot)) || 'primary',
              path: this.deps.options.workspaceRoot,
              primary: true
            }
          ]
        : []);
    const next = loadProjectInstructions({ roots });
    if (next.signature === this.projectInstructions.signature) {
      return this.projectInstructions;
    }

    for (const sourceId of this.projectInstructionSourceIds) {
      this.deps.sessionContext.removeSource(sourceId);
    }
    this.projectInstructionSourceIds.clear();

    for (const file of next.files) {
      this.deps.sessionContext.addSource({
        id: file.sourceId,
        kind: 'repo',
        title: `Project instructions: ${file.rootId}/${file.filename}`,
        content: formatProjectInstructionSource(file),
        priority: 99,
        pinned: true
      });
      this.projectInstructionSourceIds.add(file.sourceId);
    }
    this.projectInstructions = next;
    return next;
  }

  getProjectInstructions(): ProjectInstructionsSnapshot {
    return this.projectInstructions;
  }
}
