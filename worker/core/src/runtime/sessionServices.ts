import { basename, resolve } from 'node:path';

import type { SessionContext } from '../context/sessionContext';
import type { AgentMode } from '../domain';
import {
  createApprovalPolicy,
  permissionModeAccessScope,
  type PermissionMode
} from '../tools/permissionModes';
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
import { SkillRegistry } from '../skills/skillRegistry';
import type { SkillsSnapshot } from '../skills/skillDiscovery';
import type { AgentRuntimeOptions } from './agentRuntimeTypes';
import {
  cloneSessionWorkState,
  isSessionWorkState,
  type SessionWorkStateV1
} from '../session/sessionWorkState';

export interface SessionServicesOptions {
  options: AgentRuntimeOptions;
  sessionContext: SessionContext;
  toolGateway?: ToolGateway;
  emitModeChanged: (event: {
    mode: AgentMode;
    previous: AgentMode;
  }) => void;
  emitPermissionChanged: (event: {
    mode: PermissionMode;
    previous: PermissionMode;
  }) => void;
  emitWorkStateChanged: () => void;
}

/** Session-scoped policy state and prompt-source synchronization. */
export class SessionServices {
  private permissionMode: PermissionMode = 'default';
  private sessionMode: AgentMode = 'auto';
  private pendingModeExecution: PendingModeExecution | undefined;
  private projectInstructionSourceIds = new Set<string>();
  private projectInstructions = loadProjectInstructions({ roots: [] });
  private skillIds = new Set<string>();
  private readonly skillRegistry: SkillRegistry;
  private skills: SkillsSnapshot;
  private restoringWorkState = false;

  constructor(private readonly deps: SessionServicesOptions) {
    this.skillRegistry =
      deps.options.skillRegistry ??
      new SkillRegistry({
        getRoots: () => this.getInstructionRoots(),
        personalSkillsDir: deps.options.personalSkillsDir
      });
    this.skills = this.skillRegistry.getSnapshot();
    deps.options.todoStore?.onChange(() => {
      this.syncTodoContextSource();
      if (!this.restoringWorkState) {
        this.deps.emitWorkStateChanged();
      }
    });
    this.deps.toolGateway?.setApprovalPolicy(
      createApprovalPolicy(this.permissionMode)
    );
    this.deps.toolGateway?.setAccessScope(
      permissionModeAccessScope(this.permissionMode)
    );
    this.syncPermissionModeSource();
    this.syncModelProfilesSource();
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
    this.deps.emitWorkStateChanged();
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
    this.deps.emitWorkStateChanged();
  }

  clearPendingModeExecution(): void {
    if (!this.pendingModeExecution) return;
    this.pendingModeExecution = undefined;
    this.deps.emitWorkStateChanged();
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.permissionMode === mode) {
      this.syncPermissionModeSource();
      return;
    }
    const previous = this.permissionMode;
    this.permissionMode = mode;
    this.deps.toolGateway?.setApprovalPolicy(createApprovalPolicy(mode));
    this.deps.toolGateway?.setAccessScope(permissionModeAccessScope(mode));
    this.syncPermissionModeSource();
    this.deps.emitPermissionChanged({ mode, previous });
    this.deps.emitWorkStateChanged();
  }

  /**
   * 把当前权限边界作为受 runtime 管理的 pinned context 注入模型。
   * 这只帮助模型选择正确工具；最终授权仍完全由 ToolGateway 强制执行。
   */
  syncPermissionModeSource(): void {
    const workspace =
      this.deps.options.workspaceRoots?.primary ??
      (this.deps.options.workspaceRoot
        ? resolve(this.deps.options.workspaceRoot)
        : resolve(process.cwd()));
    const accessScope = permissionModeAccessScope(this.permissionMode);
    const modeRules: Record<PermissionMode, string[]> = {
      default: [
        '工作区内的读取工具自动允许。',
        '编辑、执行、网络及其他非读取操作必须请求用户审批。'
      ],
      classifier: [
        '工作区内的读取和编辑工具自动允许。',
        'Shell 执行、网络及不熟悉的操作必须请求用户审批；已知危险命令会被阻止。'
      ],
      auto: [
        '所有工具调用自动允许，文件访问范围扩展到整个系统。',
        '可以使用任意目录的绝对路径，但仍须遵守用户授权与任务范围。'
      ]
    };
    this.deps.sessionContext.addSource({
      id: 'tool-permissions',
      kind: 'workspace',
      title: 'Runtime tool permissions',
      content: [
        `当前工具权限模式：${this.permissionMode}`,
        `文件访问范围：${accessScope}`,
        `主工作目录：${workspace}`,
        ...modeRules[this.permissionMode].map((rule) => `- ${rule}`),
        '- 相对路径始终以主工作目录为基准；不要重复拼接工作区目录名。',
        '- 读取/搜索优先使用 Read、List、Glob、Grep 或 Rg；Git 操作优先使用 Git；仅在没有对应结构化工具时使用 Bash。',
        '- 本上下文用于工具选择，不授予额外权限；ToolGateway 的实时判定是最终权限边界。'
      ].join('\n'),
      priority: 98,
      pinned: true
    });
  }

  getWorkspaceRoots(): WorkspaceRoots | undefined {
    return this.deps.options.workspaceRoots;
  }

  syncModelProfilesSource(): void {
    const profiles = this.deps.options.getModelProfiles?.() ?? [];
    if (profiles.length === 0) {
      this.deps.sessionContext.removeSource('model-profiles');
      return;
    }
    this.deps.sessionContext.addSource({
      id: 'model-profiles',
      kind: 'workspace',
      title: 'Configured model profiles',
      content: [
        '可用于 Task/Conductor 子代理的模型档案：',
        ...profiles.map(
          (profile) =>
            `- id=${profile.id}; name=${profile.name}; provider=${profile.provider}; model=${profile.model}` +
            (profile.contextWindow
              ? `; contextWindow=${profile.contextWindow}`
              : '')
        ),
        '- 派生子代理时，可在 Task 的 modelProfileId 中填写上述 id；不填则继承当前模型。',
        '- 只能选择此列表中存在的档案，不要猜测 id。'
      ].join('\n'),
      priority: 97,
      pinned: true
    });
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
    const roots = this.getInstructionRoots();
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

  refreshSkills(): SkillsSnapshot {
    const next = this.skillRegistry.refresh();
    if (next.signature === this.skills.signature) {
      return this.skills;
    }
    for (const id of this.skillIds) {
      this.deps.sessionContext.removeSkill(id);
    }
    this.skillIds.clear();
    for (const skill of next.skills) {
      this.deps.sessionContext.registerSkill({
        id: skill.descriptorId,
        name: skill.name,
        description: skill.description,
        location: [
          `id=${skill.id}`,
          `scope=${skill.scope}`,
          `rootId=${skill.rootId}`,
          `path=${skill.entryPath}`
        ].join(' ')
      });
      this.skillIds.add(skill.descriptorId);
    }
    this.skills = next;
    return next;
  }

  getSkills(): SkillsSnapshot {
    return this.skills;
  }

  exportWorkState(): SessionWorkStateV1 {
    return {
      version: 1,
      todos: this.deps.options.todoStore?.list() ?? [],
      pendingModeExecution: this.pendingModeExecution
        ? JSON.parse(JSON.stringify(this.pendingModeExecution))
        : undefined,
      sessionMode: this.sessionMode,
      permissionMode: this.permissionMode
    };
  }

  restoreWorkState(state: SessionWorkStateV1): boolean {
    if (!isSessionWorkState(state)) return false;
    const restored = cloneSessionWorkState(state);
    const previousMode = this.sessionMode;
    this.restoringWorkState = true;
    try {
      this.pendingModeExecution = restored.pendingModeExecution;
      this.sessionMode = restored.sessionMode;
      this.permissionMode = restored.permissionMode ?? 'default';
      this.deps.toolGateway?.setApprovalPolicy(
        createApprovalPolicy(this.permissionMode)
      );
      this.deps.toolGateway?.setAccessScope(
        permissionModeAccessScope(this.permissionMode)
      );
      this.deps.options.todoStore?.restore(restored.todos);
      this.syncSessionModeSource();
      this.syncPermissionModeSource();
      this.syncTodoContextSource();
    } finally {
      this.restoringWorkState = false;
    }
    if (previousMode !== this.sessionMode) {
      this.deps.emitModeChanged({ mode: this.sessionMode, previous: previousMode });
    }
    this.deps.emitWorkStateChanged();
    return true;
  }

  private getInstructionRoots() {
    return this.deps.options.workspaceRoots?.list() ??
      (this.deps.options.workspaceRoot
        ? [
            {
              id: basename(resolve(this.deps.options.workspaceRoot)) || 'primary',
              path: this.deps.options.workspaceRoot,
              primary: true
            }
          ]
        : []);
  }
}
