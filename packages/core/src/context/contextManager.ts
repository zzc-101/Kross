import type { AgentMode } from '../domain';
import type { LlmMessage } from '../llm/types';
import type { ToolMetadata } from '../tools/toolGateway';
import {
  buildExtractiveHistorySummary,
  emptyMaintenanceResult,
  estimateMessageChars,
  formatCompactionMessage,
  isCompactionMessage,
  type ContextMaintenanceReason,
  type ContextMaintenanceResult
} from './contextMaintenance';

export type {
  ContextMaintenanceReason,
  ContextMaintenanceResult
} from './contextMaintenance';
export {
  COMPACTION_MARKER,
  buildExtractiveHistorySummary,
  isCompactionMessage
} from './contextMaintenance';

export interface ContextSource {
  id: string;
  kind: 'workspace' | 'repo' | 'trace' | 'memory' | 'user' | 'skill' | 'tool-result' | 'compaction';
  title: string;
  content: string;
  priority?: number;
}

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  location: string;
  body?: string;
}

export interface ToolResultContext {
  id: string;
  toolName: string;
  inputPreview: string;
  output: string;
  summary: string;
}

export interface CompactHistoryInput {
  summary: string;
  preserveLastN?: number;
  reason?: ContextMaintenanceReason;
}

export interface ContextManagerOptions {
  maxContextChars?: number;
  maxHistoryMessages?: number;
  /** When true (default), overflow history is compacted instead of hard-dropped. */
  autoCompact?: boolean;
  /** Recent turns kept after auto compaction (default 6). */
  compactPreserveLastN?: number;
  /**
   * Auto-compact when history char estimate exceeds this.
   * Default: 8_000.
   */
  autoCompactHistoryChars?: number;
  /** Keep at most N tool-result summaries (default 24). */
  maxToolResults?: number;
}

export interface BuildContextInput {
  systemPrompt: string;
  currentUserInput: string;
  mode: Exclude<AgentMode, 'auto'>;
  tools?: ToolMetadata[];
}

export interface ContextSnapshot {
  messages: LlmMessage[];
  includedSources: string[];
  droppedSources: string[];
  estimatedChars: number;
  report: ContextReport;
}

export type ContextSection =
  | 'system'
  | 'history'
  | 'sources'
  | 'skills'
  | 'tools'
  | 'tool-results';

export type ContextContributorStatus = 'included' | 'dropped' | 'pruned';

export interface ContextContributor {
  id: string;
  section: ContextSection;
  title: string;
  rawChars: number;
  injectedChars: number;
  status: ContextContributorStatus;
}

export interface ContextReport {
  totalChars: number;
  sections: Record<ContextSection, number>;
  contributors: ContextContributor[];
}

export interface ContextHistoryStats {
  messageCount: number;
  charCount: number;
  maxHistoryMessages: number;
  toolResultCount: number;
}

export interface ContextManager {
  appendConversation(message: LlmMessage): void;
  replaceConversation(messages: LlmMessage[]): ContextMaintenanceResult;
  addSource(source: ContextSource): void;
  removeSource(id: string): void;
  registerSkill(skill: SkillMetadata): void;
  recordToolResult(result: ToolResultContext): void;
  clearToolResults(): void;
  compactHistory(input: CompactHistoryInput): ContextMaintenanceResult;
  /**
   * Run auto compaction when history/tool-results exceed thresholds.
   * Safe to call before each model request.
   */
  maybeAutoCompact(
    reason?: ContextMaintenanceReason
  ): ContextMaintenanceResult;
  getHistoryStats(): ContextHistoryStats;
  getLastMaintenance(): ContextMaintenanceResult | undefined;
  clearSources(): void;
  build(input: BuildContextInput): ContextSnapshot;
}

export class InMemoryContextManager implements ContextManager {
  private readonly maxContextChars: number;
  private readonly maxHistoryMessages: number;
  private readonly autoCompact: boolean;
  private readonly compactPreserveLastN: number;
  private readonly autoCompactHistoryChars: number;
  private readonly maxToolResults: number;
  private readonly history: LlmMessage[] = [];
  private readonly sources = new Map<string, ContextSource>();
  private readonly skills = new Map<string, SkillMetadata>();
  private readonly toolResults = new Map<string, ToolResultContext>();
  private lastMaintenance: ContextMaintenanceResult | undefined;

  constructor(options: ContextManagerOptions = {}) {
    this.maxContextChars = options.maxContextChars ?? 12_000;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 12;
    this.autoCompact = options.autoCompact ?? true;
    this.compactPreserveLastN = Math.max(
      1,
      options.compactPreserveLastN ?? 6
    );
    this.autoCompactHistoryChars = options.autoCompactHistoryChars ?? 8_000;
    this.maxToolResults = Math.max(1, options.maxToolResults ?? 24);
  }

  appendConversation(message: LlmMessage): void {
    this.history.push(message);
    if (this.autoCompact) {
      this.maybeAutoCompact('history_limit');
      return;
    }
    if (this.history.length > this.maxHistoryMessages) {
      this.history.splice(0, this.history.length - this.maxHistoryMessages);
    }
  }

  replaceConversation(messages: LlmMessage[]): ContextMaintenanceResult {
    const incoming = [...messages];
    if (incoming.length <= this.maxHistoryMessages) {
      this.history.splice(0, this.history.length, ...incoming);
      return this.rememberMaintenance(emptyMaintenanceResult(this.history));
    }

    if (!this.autoCompact) {
      const tail = incoming.slice(-this.maxHistoryMessages);
      this.history.splice(0, this.history.length, ...tail);
      return this.rememberMaintenance({
        compacted: false,
        reason: 'restore_truncation',
        droppedMessageCount: incoming.length - tail.length,
        preservedMessageCount: tail.length,
        historyCharsBefore: estimateMessageChars(incoming),
        historyCharsAfter: estimateMessageChars(tail)
      });
    }

    // Leave room for one summary message inside the hard cap.
    const preserveLastN = Math.min(
      this.compactPreserveLastN,
      Math.max(1, this.maxHistoryMessages - 1)
    );
    return this.rememberMaintenance(
      this.compactMessages(incoming, preserveLastN, 'restore_truncation')
    );
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

  recordToolResult(result: ToolResultContext): void {
    this.toolResults.set(result.id, result);
    while (this.toolResults.size > this.maxToolResults) {
      const oldest = this.toolResults.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.toolResults.delete(oldest);
    }
  }

  clearToolResults(): void {
    this.toolResults.clear();
  }

  compactHistory(input: CompactHistoryInput): ContextMaintenanceResult {
    const preserveLastN = input.preserveLastN ?? this.compactPreserveLastN;
    const before = [...this.history];
    const charsBefore = estimateMessageChars(before);
    if (before.length <= preserveLastN) {
      return this.rememberMaintenance(emptyMaintenanceResult(this.history));
    }

    const tail = before.slice(-preserveLastN);
    const dropped = before.slice(0, -preserveLastN);
    const summaryText = input.summary.trim() || buildExtractiveHistorySummary(dropped);
    const summary: LlmMessage = {
      role: 'assistant',
      content: formatCompactionMessage(summaryText)
    };
    this.history.splice(0, this.history.length, summary, ...tail);
    // Hard-cap after manual compact as well.
    if (this.history.length > this.maxHistoryMessages) {
      this.history.splice(0, this.history.length - this.maxHistoryMessages);
    }
    return this.rememberMaintenance({
      compacted: true,
      reason: input.reason ?? 'manual',
      droppedMessageCount: dropped.length,
      preservedMessageCount: this.history.length,
      historyCharsBefore: charsBefore,
      historyCharsAfter: estimateMessageChars(this.history),
      summaryChars: summary.content.length
    });
  }

  maybeAutoCompact(
    reason: ContextMaintenanceReason = 'pre_build'
  ): ContextMaintenanceResult {
    const toolCleared = this.trimToolResultsIfNeeded();
    const chars = estimateMessageChars(this.history);
    const overMessageCap = this.history.length > this.maxHistoryMessages;
    const overCharBudget = chars > this.autoCompactHistoryChars;

    if (!this.autoCompact) {
      if (overMessageCap) {
        const before = this.history.length;
        this.history.splice(0, this.history.length - this.maxHistoryMessages);
        return this.rememberMaintenance({
          compacted: false,
          reason: reason === 'pre_build' ? 'history_limit' : reason,
          droppedMessageCount: before - this.history.length,
          preservedMessageCount: this.history.length,
          historyCharsBefore: chars,
          historyCharsAfter: estimateMessageChars(this.history),
          clearedToolResults: toolCleared || undefined
        });
      }
      const idle = emptyMaintenanceResult(this.history);
      if (toolCleared > 0) {
        idle.clearedToolResults = toolCleared;
        idle.reason = 'tool_results';
        return this.rememberMaintenance(idle);
      }
      return idle;
    }

    if (!overMessageCap && !overCharBudget) {
      const idle = emptyMaintenanceResult(this.history);
      if (toolCleared > 0) {
        idle.clearedToolResults = toolCleared;
        idle.reason = 'tool_results';
        return this.rememberMaintenance(idle);
      }
      return idle;
    }

    const preserveLastN = Math.min(
      this.compactPreserveLastN,
      Math.max(1, this.maxHistoryMessages - 1)
    );
    const compactReason: ContextMaintenanceReason = overMessageCap
      ? reason === 'restore_truncation'
        ? 'restore_truncation'
        : 'history_limit'
      : 'char_budget';
    const result = this.compactMessages(
      [...this.history],
      preserveLastN,
      compactReason
    );
    if (toolCleared > 0) {
      result.clearedToolResults = toolCleared;
    }
    return this.rememberMaintenance(result);
  }

  getHistoryStats(): ContextHistoryStats {
    return {
      messageCount: this.history.length,
      charCount: estimateMessageChars(this.history),
      maxHistoryMessages: this.maxHistoryMessages,
      toolResultCount: this.toolResults.size
    };
  }

  getLastMaintenance(): ContextMaintenanceResult | undefined {
    return this.lastMaintenance;
  }

  clearSources(): void {
    this.sources.clear();
  }

  build(input: BuildContextInput): ContextSnapshot {
    // Opportunistic maintenance before each prompt assembly.
    this.maybeAutoCompact('pre_build');

    const skillBlock = renderSkills([...this.skills.values()]);
    const toolBlock = renderTools(input.tools ?? []);
    const toolResultSelection = renderToolResults([...this.toolResults.values()]);
    const contextBudget = Math.max(
      0,
      this.maxContextChars -
        input.systemPrompt.length -
        input.currentUserInput.length -
        estimateMessages(this.history) -
        skillBlock.content.length -
        toolBlock.length -
        toolResultSelection.content.length
    );
    const selected = selectSources([...this.sources.values()], contextBudget);
    const systemContent = [
      input.systemPrompt,
      '',
      `Mode: ${input.mode}`,
      toolBlock,
      skillBlock.content,
      toolResultSelection.content,
      renderSources(selected.included)
    ]
      .filter((part) => part.trim().length > 0)
      .join('\n');
    const messages: LlmMessage[] = [
      { role: 'system', content: systemContent },
      ...this.history,
      { role: 'user', content: input.currentUserInput }
    ];

    const report = buildReport({
      systemContent,
      history: this.history,
      currentUserInput: input.currentUserInput,
      tools: input.tools ?? [],
      skillContributors: skillBlock.contributors,
      toolResultContributors: toolResultSelection.contributors,
      selectedSources: selected
    });

    return {
      messages,
      includedSources: selected.included.map((source) => source.id),
      droppedSources: selected.dropped.map((source) => source.id),
      estimatedChars: estimateMessages(messages),
      report
    };
  }

  private compactMessages(
    messages: LlmMessage[],
    preserveLastN: number,
    reason: ContextMaintenanceReason
  ): ContextMaintenanceResult {
    const charsBefore = estimateMessageChars(messages);
    if (messages.length <= preserveLastN) {
      this.history.splice(0, this.history.length, ...messages);
      return emptyMaintenanceResult(this.history);
    }

    const tail = messages.slice(-preserveLastN);
    const dropped = messages.slice(0, -preserveLastN);
    // Avoid re-compacting only a previous summary with no real turns left.
    const droppedReal = dropped.filter((message) => !isCompactionMessage(message));
    if (droppedReal.length === 0 && dropped.length > 0) {
      // Keep existing summary + tail, still enforce hard cap.
      const kept = [...dropped.slice(-1), ...tail].slice(-this.maxHistoryMessages);
      this.history.splice(0, this.history.length, ...kept);
      return {
        compacted: false,
        reason,
        droppedMessageCount: messages.length - kept.length,
        preservedMessageCount: kept.length,
        historyCharsBefore: charsBefore,
        historyCharsAfter: estimateMessageChars(kept)
      };
    }

    const summaryText = buildExtractiveHistorySummary(dropped);
    const summary: LlmMessage = {
      role: 'assistant',
      content: formatCompactionMessage(summaryText)
    };
    const next = [summary, ...tail];
    // Enforce absolute hard cap.
    const capped =
      next.length > this.maxHistoryMessages
        ? next.slice(next.length - this.maxHistoryMessages)
        : next;
    this.history.splice(0, this.history.length, ...capped);
    return {
      compacted: true,
      reason,
      droppedMessageCount: dropped.length,
      preservedMessageCount: capped.length,
      historyCharsBefore: charsBefore,
      historyCharsAfter: estimateMessageChars(capped),
      summaryChars: summary.content.length
    };
  }

  private trimToolResultsIfNeeded(): number {
    let cleared = 0;
    while (this.toolResults.size > this.maxToolResults) {
      const oldest = this.toolResults.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.toolResults.delete(oldest);
      cleared += 1;
    }
    return cleared;
  }

  private rememberMaintenance(
    result: ContextMaintenanceResult
  ): ContextMaintenanceResult {
    if (
      result.compacted ||
      result.droppedMessageCount > 0 ||
      (result.clearedToolResults ?? 0) > 0
    ) {
      this.lastMaintenance = result;
    }
    return result;
  }
}

function selectSources(
  sources: ContextSource[],
  budget: number
): { included: ContextSource[]; dropped: ContextSource[] } {
  const sorted = [...sources].sort(
    (left, right) => (right.priority ?? 0) - (left.priority ?? 0)
  );
  const included: ContextSource[] = [];
  const dropped: ContextSource[] = [];
  let used = 0;

  for (const source of sorted) {
    const renderedLength = renderSource(source).length;
    if (used + renderedLength <= budget) {
      included.push(source);
      used += renderedLength;
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

function renderSkills(skills: SkillMetadata[]): {
  content: string;
  contributors: ContextContributor[];
} {
  if (skills.length === 0) {
    return { content: '', contributors: [] };
  }

  const lines = skills.map(
    (skill) =>
      `- ${skill.name}: ${skill.description} (${skill.location})`
  );
  const contributors = skills.map((skill) => {
    const injected = `${skill.name}: ${skill.description} (${skill.location})`;
    return {
      id: `skill:${skill.id}`,
      section: 'skills' as const,
      title: skill.name,
      rawChars: (skill.body ?? injected).length,
      injectedChars: injected.length,
      status: 'included' as const
    };
  });

  return {
    content: ['Available skills (metadata only; load body only when needed):', ...lines].join('\n'),
    contributors
  };
}

function renderToolResults(results: ToolResultContext[]): {
  content: string;
  contributors: ContextContributor[];
} {
  if (results.length === 0) {
    return { content: '', contributors: [] };
  }

  const lines = results.map(
    (result) =>
      `- ${result.toolName}(${result.inputPreview}): ${result.summary}`
  );
  const contributors = results.map((result) => {
    const injected = `${result.toolName}(${result.inputPreview}): ${result.summary}`;
    return {
      id: `tool-result:${result.id}`,
      section: 'tool-results' as const,
      title: result.toolName,
      rawChars: result.output.length,
      injectedChars: injected.length,
      status: 'pruned' as const
    };
  });

  return {
    content: ['Recent tool results (summaries; raw output kept in trace):', ...lines].join('\n'),
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

function estimateMessages(messages: LlmMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function buildReport(input: {
  systemContent: string;
  history: LlmMessage[];
  currentUserInput: string;
  tools: ToolMetadata[];
  skillContributors: ContextContributor[];
  toolResultContributors: ContextContributor[];
  selectedSources: { included: ContextSource[]; dropped: ContextSource[] };
}): ContextReport {
  const sourceContributors = [
    ...input.selectedSources.included.map((source) =>
      sourceContributor(source, 'included' as const)
    ),
    ...input.selectedSources.dropped.map((source) =>
      sourceContributor(source, 'dropped' as const)
    )
  ];
  const toolContributors = input.tools.map((tool) => {
    const rendered = renderTool(tool);
    return {
      id: `tool:${tool.name}`,
      section: 'tools' as const,
      title: tool.name,
      rawChars: rendered.length,
      injectedChars: rendered.length,
      status: 'included' as const
    };
  });
  const contributors = [
    {
      id: 'system',
      section: 'system' as const,
      title: 'System prompt',
      rawChars: input.systemContent.length,
      injectedChars: input.systemContent.length,
      status: 'included' as const
    },
    {
      id: 'history',
      section: 'history' as const,
      title: 'Conversation history',
      rawChars: estimateMessages(input.history) + input.currentUserInput.length,
      injectedChars: estimateMessages(input.history) + input.currentUserInput.length,
      status: 'included' as const
    },
    ...sourceContributors,
    ...toolContributors,
    ...input.skillContributors,
    ...input.toolResultContributors
  ];
  const sections: Record<ContextSection, number> = {
    system: 0,
    history: 0,
    sources: 0,
    skills: 0,
    tools: 0,
    'tool-results': 0
  };

  for (const contributor of contributors) {
    sections[contributor.section] += contributor.injectedChars;
  }

  return {
    totalChars: Object.values(sections).reduce((total, value) => total + value, 0),
    sections,
    contributors
  };
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
  status: ContextContributorStatus
): ContextContributor {
  const rendered = renderSource(source);
  return {
    id: source.id,
    section: 'sources',
    title: source.title,
    rawChars: rendered.length,
    injectedChars: status === 'included' ? rendered.length : 0,
    status
  };
}
