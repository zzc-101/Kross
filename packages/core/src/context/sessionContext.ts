import type { AgentMode } from '../domain';
import type { LlmClient, LlmMessage } from '../llm/types';
import { resolveModelContextWindow } from '../llm/modelContextWindows';
import type { ToolMetadata } from '../tools/toolGateway';
import { createContextPolicy, type ContextPolicy } from './contextPolicy';
import {
  ContextGovernor,
  type ContextMaintenanceResult,
  type ContextMaintenanceReason
} from './contextGovernor';
import { ConversationThread } from './conversationThread';
import { LlmSummarizer } from './summarizer';
import { TokenEstimator } from './tokenEstimator';

export type {
  ContextMaintenanceReason,
  ContextMaintenanceResult,
  GovernanceStage
} from './contextGovernor';

export interface ContextSource {
  id: string;
  kind: 'workspace' | 'repo' | 'trace' | 'memory' | 'user' | 'skill' | 'compaction';
  title: string;
  content: string;
  priority?: number;
  /** 固定注入，不因预算被静默 drop */
  pinned?: boolean;
}

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  location: string;
  body?: string;
}

export interface SessionContextOptions {
  contextWindow?: number;
  isSubagent?: boolean;
  llmClient?: LlmClient;
  policy?: ContextPolicy;
  thread?: ConversationThread;
  estimator?: TokenEstimator;
}

export interface BuildContextInput {
  systemPrompt: string;
  mode: Exclude<AgentMode, 'auto'>;
  tools?: ToolMetadata[];
}

export type ContextSection =
  | 'system'
  | 'thread'
  | 'history'
  | 'sources'
  | 'skills'
  | 'tools';

export type ContextContributorStatus = 'included' | 'dropped' | 'pruned' | 'elided';

export interface ContextContributor {
  id: string;
  section: ContextSection;
  title: string;
  rawTokens: number;
  injectedTokens: number;
  status: ContextContributorStatus;
}

export interface ContextReport {
  totalTokens: number;
  /** 兼容 TUI / trace */
  totalChars: number;
  sections: Record<ContextSection, number>;
  contributors: ContextContributor[];
}

export interface ContextSnapshot {
  messages: LlmMessage[];
  includedSources: string[];
  droppedSources: string[];
  /** pinned 源 id 列表（可能同时在 included 中） */
  pinnedSources: string[];
  estimatedTokens: number;
  /** 兼容旧字段 */
  estimatedChars: number;
  report: ContextReport;
  inputBudget: number;
  compactThreshold: number;
}

export interface PrepareRequestResult extends ContextSnapshot {
  maintenance: ContextMaintenanceResult[];
}

/**
 * 会话上下文门面：Thread + Governor + sources/skills。
 * prepareRequest 触发治理；snapshot 纯读无副作用。
 */
export class SessionContext {
  private readonly thread: ConversationThread;
  private readonly estimator: TokenEstimator;
  private readonly policy: ContextPolicy;
  private readonly governor: ContextGovernor;
  private readonly sources = new Map<string, ContextSource>();
  private readonly skills = new Map<string, SkillMetadata>();
  private lastMaintenance: ContextMaintenanceResult[] = [];
  private llmClient: LlmClient | undefined;

  constructor(options: SessionContextOptions = {}) {
    this.estimator = options.estimator ?? new TokenEstimator();
    this.thread =
      options.thread ?? new ConversationThread({ estimator: this.estimator });
    this.llmClient = options.llmClient;
    this.policy =
      options.policy ??
      createContextPolicy({
        contextWindow: options.contextWindow,
        isSubagent: options.isSubagent
      });
    this.governor = new ContextGovernor({
      policy: this.policy,
      estimator: this.estimator,
      summarizer: new LlmSummarizer(this.llmClient)
    });
  }

  setLlmClient(client: LlmClient | undefined): void {
    this.llmClient = client;
  }

  getCommittedDialog(): LlmMessage[] {
    const dialog: LlmMessage[] = [];
    for (const turnId of this.thread.getTurnIdsInOrder()) {
      const status = this.thread.getTurnStatus(turnId);
      if (status !== 'committed' && status !== 'aborted') {
        continue;
      }
      const entries = this.thread.getEntriesForTurn(turnId);
      const userEntry = entries.find((entry) => entry.kind === 'user');
      const assistantEntries = entries.filter((entry) => entry.kind === 'assistant');
      const lastAssistant = assistantEntries.at(-1);
      if (userEntry && userEntry.message.role !== 'tool') {
        dialog.push({
          role: 'user',
          content: userEntry.message.content
        });
      }
      if (lastAssistant && lastAssistant.message.role === 'assistant') {
        dialog.push({
          role: 'assistant',
          content: lastAssistant.message.content
        });
      }
    }
    return dialog;
  }

  getThread(): ConversationThread {
    return this.thread;
  }

  getPolicy(): ContextPolicy {
    return this.policy;
  }

  getEstimator(): TokenEstimator {
    return this.estimator;
  }

  beginTurn(userInput: string): string {
    return this.thread.beginTurn(userInput);
  }

  commitTurn(): void {
    this.thread.commitTurn();
  }

  abortTurn(reason: string): void {
    this.thread.abortTurn(reason);
  }

  appendAssistant(content: string, toolCalls?: import('../llm/types').LlmToolCall[]): void {
    this.thread.appendAssistant(content, toolCalls);
  }

  appendToolResult(input: {
    toolCallId: string;
    name: string;
    content: string;
    summary?: string;
    iteration?: number;
  }): void {
    this.thread.appendToolResult(input);
  }

  setIteration(iteration: number): void {
    this.thread.setCurrentIteration(iteration);
  }

  addSource(source: ContextSource): void {
    this.sources.set(source.id, source);
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  registerSkill(skill: SkillMetadata): void {
    this.skills.set(skill.id, skill);
  }

  clearSources(): void {
    this.sources.clear();
  }

  getLastMaintenance(): ContextMaintenanceResult | undefined {
    return this.lastMaintenance.at(-1);
  }

  getAllMaintenance(): ContextMaintenanceResult[] {
    return [...this.lastMaintenance];
  }

  /**
   * 手动触发 Stage2 轮次压缩；无可压缩轮次时 compacted=false。
   */
  async compactNow(input: BuildContextInput): Promise<ContextMaintenanceResult> {
    const result = await this.governor.compactTurnsNow(this.thread);
    if (result.compacted) {
      this.rememberMaintenance(result);
    }
    return result;
  }

  clearMaintenanceHistory(): void {
    this.lastMaintenance = [];
  }

  restoreConversation(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): ContextMaintenanceResult {
    const beforeEntries = this.thread.getEntries().length;
    const beforeTokens = this.thread
      .getEntries()
      .reduce((sum, entry) => sum + entry.tokensEst, 0);

    this.thread.restoreFromConversation(messages);

    const afterTokens = this.thread
      .getEntries()
      .reduce((sum, entry) => sum + entry.tokensEst, 0);

    const result: ContextMaintenanceResult = {
      compacted: false,
      reason: 'restore_truncation',
      droppedMessageCount: Math.max(0, beforeEntries),
      preservedMessageCount: this.thread.getEntries().length,
      tokensBefore: beforeTokens,
      tokensAfter: afterTokens,
      historyCharsBefore: beforeTokens * 4,
      historyCharsAfter: afterTokens * 4
    };

    if (afterTokens > this.policy.compactThreshold) {
      // 恢复后若超预算，由下次 prepareRequest 治理；此处仅记录
      result.reason = 'restore_truncation';
    }

    this.rememberMaintenance(result);
    return result;
  }

  /**
   * 请求前治理 + 组装完整 messages（含 system）。
   */
  async prepareRequest(input: BuildContextInput): Promise<PrepareRequestResult> {
    const systemBlock = this.buildSystemBlock(input);
    const systemTokens = this.estimator.estimate([
      { role: 'system', content: systemBlock.content }
    ]);
    const threadBudget = Math.max(0, this.policy.compactThreshold - systemTokens);

    const governResult = await this.governor.govern({
      thread: this.thread,
      threadTokenBudget: threadBudget
    });

    for (const item of governResult.maintenance) {
      this.rememberMaintenance(item);
    }

    const threadMessages = this.thread.buildMessages();
    const messages: LlmMessage[] = [
      { role: 'system', content: systemBlock.content },
      ...threadMessages
    ];

    const estimatedTokens = this.estimator.estimate(messages);
    const report = this.buildReport({
      systemContent: systemBlock.content,
      threadMessages,
      systemBlock,
      estimatedTokens
    });

    return {
      messages,
      includedSources: systemBlock.includedSources,
      droppedSources: systemBlock.droppedSources,
      pinnedSources: this.listPinnedSourceIds(),
      estimatedTokens,
      estimatedChars: estimatedTokens * 4,
      report,
      inputBudget: this.policy.inputBudget,
      compactThreshold: this.policy.compactThreshold,
      maintenance: governResult.maintenance
    };
  }

  /** 纯读快照，不触发治理 */
  snapshot(input: BuildContextInput): ContextSnapshot {
    const systemBlock = this.buildSystemBlock(input);
    const threadMessages = this.thread.buildMessages();
    const messages: LlmMessage[] = [
      { role: 'system', content: systemBlock.content },
      ...threadMessages
    ];
    const estimatedTokens = this.estimator.estimate(messages);
    const report = this.buildReport({
      systemContent: systemBlock.content,
      threadMessages,
      systemBlock,
      estimatedTokens
    });

    return {
      messages,
      includedSources: systemBlock.includedSources,
      droppedSources: systemBlock.droppedSources,
      pinnedSources: this.listPinnedSourceIds(),
      estimatedTokens,
      estimatedChars: estimatedTokens * 4,
      report,
      inputBudget: this.policy.inputBudget,
      compactThreshold: this.policy.compactThreshold
    };
  }

  calibrateFromUsage(actualInputTokens: number | undefined, messages: LlmMessage[]): void {
    if (actualInputTokens === undefined || actualInputTokens <= 0) {
      return;
    }
    const rawEstimate = this.estimator.estimate(messages);
    if (rawEstimate > 0) {
      this.estimator.calibrate(rawEstimate, actualInputTokens);
    }
  }

  resetCalibration(): void {
    this.estimator.resetCalibration();
  }

  private rememberMaintenance(result: ContextMaintenanceResult): void {
    if (
      result.compacted ||
      result.droppedMessageCount > 0 ||
      (result.droppedTurnCount ?? 0) > 0
    ) {
      this.lastMaintenance.push({
        ...result,
        at: result.at ?? new Date().toISOString()
      });
    }
  }

  private listPinnedSourceIds(): string[] {
    return [...this.sources.values()]
      .filter((source) => source.pinned)
      .map((source) => source.id);
  }

  private buildSystemBlock(input: BuildContextInput): {
    content: string;
    includedSources: string[];
    droppedSources: string[];
    skillContributors: ContextContributor[];
    toolContributors: ContextContributor[];
    sourceContributors: ContextContributor[];
  } {
    const skillBlock = renderSkills([...this.skills.values()], this.estimator);
    const toolBlock = renderTools(input.tools ?? []);
    const toolTokens = this.estimator.estimateText(toolBlock);

    const threadTokens = this.thread
      .getEntries()
      .reduce((sum, entry) => sum + entry.tokensEst, 0);
    const baseTokens =
      this.estimator.estimateText(input.systemPrompt) +
      this.estimator.estimateText(`Mode: ${input.mode}`) +
      skillBlock.tokens +
      toolTokens +
      threadTokens;

    const sourceBudget = Math.max(
      0,
      this.policy.inputBudget - baseTokens
    );
    const selected = selectSources(
      [...this.sources.values()],
      sourceBudget,
      this.estimator
    );

    const systemContent = [
      input.systemPrompt,
      '',
      `Mode: ${input.mode}`,
      toolBlock,
      skillBlock.content,
      renderSources(selected.included)
    ]
      .filter((part) => part.trim().length > 0)
      .join('\n');

    const sourceContributors = [
      ...selected.included.map((source) =>
        sourceContributor(source, 'included', this.estimator)
      ),
      ...selected.dropped.map((source) =>
        sourceContributor(source, 'dropped', this.estimator)
      )
    ];

    const toolContributors = (input.tools ?? []).map((tool) => {
      const rendered = renderTool(tool);
      const tokens = this.estimator.estimateText(rendered);
      return {
        id: `tool:${tool.name}`,
        section: 'tools' as const,
        title: tool.name,
        rawTokens: tokens,
        injectedTokens: tokens,
        status: 'included' as const
      };
    });

    return {
      content: systemContent,
      includedSources: selected.included.map((source) => source.id),
      droppedSources: selected.dropped.map((source) => source.id),
      skillContributors: skillBlock.contributors,
      toolContributors,
      sourceContributors
    };
  }

  private buildReport(input: {
    systemContent: string;
    threadMessages: LlmMessage[];
    systemBlock: {
      skillContributors: ContextContributor[];
      toolContributors: ContextContributor[];
      sourceContributors: ContextContributor[];
    };
    estimatedTokens: number;
  }): ContextReport {
    const systemTokens = this.estimator.estimateText(input.systemContent);
    const threadTokens = this.estimator.estimate(input.threadMessages);

    const threadContributors: ContextContributor[] = [];
    for (const entry of this.thread.getEntries()) {
      threadContributors.push({
        id: entry.id,
        section: 'thread',
        title: `${entry.kind}:${entry.turnId}`,
        rawTokens: entry.originalTokens ?? entry.tokensEst,
        injectedTokens: entry.tokensEst,
        status: entry.elided ? 'elided' : 'included'
      });
    }

    const contributors: ContextContributor[] = [
      {
        id: 'system',
        section: 'system',
        title: 'System prompt',
        rawTokens: systemTokens,
        injectedTokens: systemTokens,
        status: 'included'
      },
      {
        id: 'history',
        section: 'history',
        title: 'Conversation history',
        rawTokens: threadTokens,
        injectedTokens: threadTokens,
        status: 'included'
      },
      ...input.systemBlock.sourceContributors,
      ...input.systemBlock.toolContributors,
      ...input.systemBlock.skillContributors,
      ...threadContributors.filter((item) => item.id !== 'thread')
    ];

    const sections: Record<ContextSection, number> = {
      system: 0,
      thread: 0,
      history: 0,
      sources: 0,
      skills: 0,
      tools: 0
    };

    for (const contributor of contributors) {
      if (contributor.id === 'thread' || contributor.section === 'thread') {
        if (contributor.id === 'thread') {
          sections.thread += contributor.injectedTokens;
        }
        continue;
      }
      sections[contributor.section] += contributor.injectedTokens;
    }
    sections.thread = threadTokens;
    sections.history = threadTokens;

    return {
      totalTokens: input.estimatedTokens,
      totalChars: input.estimatedTokens * 4,
      sections,
      contributors
    };
  }
}

export function createSessionContext(
  options: SessionContextOptions & {
    env?: Record<string, string | undefined>;
    model?: string;
    client?: LlmClient;
  } = {}
): SessionContext {
  const contextWindow =
    options.contextWindow ??
    options.client?.contextWindow ??
    resolveModelContextWindow(options.model, options.env);
  return new SessionContext({
    ...options,
    contextWindow,
    llmClient: options.llmClient ?? options.client
  });
}

function selectSources(
  sources: ContextSource[],
  budgetTokens: number,
  estimator: TokenEstimator
): { included: ContextSource[]; dropped: ContextSource[] } {
  const pinned = sources.filter((source) => source.pinned);
  const unpinned = sources
    .filter((source) => !source.pinned)
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));

  const included: ContextSource[] = [...pinned];
  const dropped: ContextSource[] = [];
  let used = pinned.reduce(
    (sum, source) => sum + estimator.estimateText(renderSource(source)),
    0
  );

  for (const source of unpinned) {
    const tokens = estimator.estimateText(renderSource(source));
    if (used + tokens <= budgetTokens) {
      included.push(source);
      used += tokens;
    } else {
      dropped.push(source);
    }
  }

  return { included, dropped };
}

function renderTools(tools: ToolMetadata[]): string {
  if (tools.length === 0) {
    return '';
  }
  const lines = tools.map(renderTool);
  return ['Available tools:', ...lines].join('\n');
}

function renderSkills(
  skills: SkillMetadata[],
  estimator: TokenEstimator
): {
  content: string;
  tokens: number;
  contributors: ContextContributor[];
} {
  if (skills.length === 0) {
    return { content: '', tokens: 0, contributors: [] };
  }

  const lines = skills.map(
    (skill) =>
      `- ${skill.name}: ${skill.description} (${skill.location})`
  );
  const content = [
    'Available skills (metadata only; load body only when needed):',
    ...lines
  ].join('\n');
  const contributors = skills.map((skill) => {
    const injected = `${skill.name}: ${skill.description} (${skill.location})`;
    const injectedTokens = estimator.estimateText(injected);
    const rawTokens = estimator.estimateText(skill.body ?? injected);
    return {
      id: `skill:${skill.id}`,
      section: 'skills' as const,
      title: skill.name,
      rawTokens,
      injectedTokens,
      status: 'included' as const
    };
  });

  return {
    content,
    tokens: estimator.estimateText(content),
    contributors
  };
}

function renderSources(sources: ContextSource[]): string {
  if (sources.length === 0) {
    return '';
  }
  return ['Context sources:', ...sources.map(renderSource)].join('\n');
}

function renderSource(source: ContextSource): string {
  return `### ${source.title} (${source.kind})\n${source.content}`;
}

function renderTool(tool: ToolMetadata): string {
  const details = [
    `risk: ${tool.risk}`,
    tool.category ? `category: ${tool.category}` : undefined,
    tool.parameters ? `parameters: ${JSON.stringify(tool.parameters)}` : undefined
  ].filter(Boolean);

  return `- ${tool.name} (${details.join('; ')}): ${tool.description}`;
}

function sourceContributor(
  source: ContextSource,
  status: ContextContributorStatus,
  estimator: TokenEstimator
): ContextContributor {
  const rendered = renderSource(source);
  const rawTokens = estimator.estimateText(rendered);
  return {
    id: source.id,
    section: 'sources',
    title: source.title,
    rawTokens,
    injectedTokens: status === 'included' ? rawTokens : 0,
    status
  };
}

/** @deprecated 兼容旧测试注入名 */
export const InMemoryContextManager = SessionContext;

/** @deprecated 兼容旧类型名 */
export type ContextManager = SessionContext;
