import { resolve } from 'node:path';

import type { SessionContext } from '../context/sessionContext';
import { saasToolApprovalPolicy } from '../tools/saasToolPolicy';
import type { ToolGateway } from '../tools/toolGateway';
import {
  formatProjectInstructionSource,
  loadProjectInstructions,
  type ProjectInstructionsSnapshot
} from '../workspace/projectInstructions';
import type { TodoStore } from '../todo/todoStore';
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
  private restoringWorkState = false;

  constructor(private readonly deps: SessionServicesOptions) {
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
      this.deps.options.workspaceRoot
        ? resolve(this.deps.options.workspaceRoot)
        : resolve(process.cwd());
    this.deps.sessionContext.addSource({
      id: 'tool-permissions',
      kind: 'workspace',
      title: 'Runtime tool permissions',
      content: [
        '当前使用固定的 Cloud 工具策略。',
        '文件访问范围：workspace',
        `主工作目录：${workspace}`,
        '- 工作区内读取、检索和文件产物操作自动执行。',
        '- 外部系统写入和未知网络操作需要用户确认。',
        '- 破坏工作区或容器边界的操作会直接拒绝。',
        '- 相对路径始终以主工作目录为基准；不要重复拼接工作区目录名。',
        '- 使用当前提供的结构化工具完成任务，不要假设 Bash、Git 或其他未提供工具可用。',
        '- 本上下文用于工具选择，不授予额外权限；ToolGateway 的实时判定是最终权限边界。'
      ].join('\n'),
      priority: 98,
      pinned: true
    });
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
        '可用于 Task 子代理的模型档案：',
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
    return this.deps.options.workspaceRoot
      ? [
          {
            id: 'workspace',
            path: this.deps.options.workspaceRoot,
            primary: true
          }
        ]
      : [];
  }
}
