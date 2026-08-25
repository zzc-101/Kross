import { basename, resolve } from 'node:path';

import type { SessionContext } from '../context/sessionContext';
import { saasToolApprovalPolicy } from '../tools/saasToolPolicy';
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
  emitWorkStateChanged: () => void;
}

/** Session-scoped policy state and prompt-source synchronization. */
export class SessionServices {
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
    this.deps.toolGateway?.setApprovalPolicy(saasToolApprovalPolicy);
    this.syncToolPolicySource();
    this.syncModelProfilesSource();
  }

  /**
   * 把当前权限边界作为受 runtime 管理的 pinned context 注入模型。
   * 这只帮助模型选择正确工具；最终授权仍完全由 ToolGateway 强制执行。
   */
  syncToolPolicySource(): void {
    const workspace =
      this.deps.options.workspaceRoots?.primary ??
      (this.deps.options.workspaceRoot
        ? resolve(this.deps.options.workspaceRoot)
        : resolve(process.cwd()));
    this.deps.sessionContext.addSource({
      id: 'tool-permissions',
      kind: 'workspace',
      title: 'Runtime tool permissions',
      content: [
        '当前使用固定的 Cloud 工具策略。',
        '文件访问范围：workspace',
        `主工作目录：${workspace}`,
        '- 工作区内读写、构建、测试和普通本地命令自动执行。',
        '- 外部系统写入和未知网络操作需要用户确认。',
        '- 破坏工作区或容器边界的命令会直接拒绝。',
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
      todos: this.deps.options.todoStore?.list() ?? []
    };
  }

  restoreWorkState(state: SessionWorkStateV1): boolean {
    if (!isSessionWorkState(state)) return false;
    const restored = cloneSessionWorkState(state);
    this.restoringWorkState = true;
    try {
      this.deps.toolGateway?.setApprovalPolicy(saasToolApprovalPolicy);
      this.deps.options.todoStore?.restore(restored.todos);
      this.syncToolPolicySource();
      this.syncTodoContextSource();
    } finally {
      this.restoringWorkState = false;
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
