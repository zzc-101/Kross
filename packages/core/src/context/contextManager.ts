import type { AgentMode } from '../domain';
import type { LlmMessage } from '../llm/types';
import type { ToolMetadata } from '../tools/toolGateway';

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
}

export interface ContextManagerOptions {
  maxContextChars?: number;
  maxHistoryMessages?: number;
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

export interface ContextManager {
  appendConversation(message: LlmMessage): void;
  addSource(source: ContextSource): void;
  registerSkill(skill: SkillMetadata): void;
  recordToolResult(result: ToolResultContext): void;
  compactHistory(input: CompactHistoryInput): void;
  clearSources(): void;
  build(input: BuildContextInput): ContextSnapshot;
}

export class InMemoryContextManager implements ContextManager {
  private readonly maxContextChars: number;
  private readonly maxHistoryMessages: number;
  private readonly history: LlmMessage[] = [];
  private readonly sources = new Map<string, ContextSource>();
  private readonly skills = new Map<string, SkillMetadata>();
  private readonly toolResults = new Map<string, ToolResultContext>();

  constructor(options: ContextManagerOptions = {}) {
    this.maxContextChars = options.maxContextChars ?? 12_000;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 12;
  }

  appendConversation(message: LlmMessage): void {
    this.history.push(message);
    if (this.history.length > this.maxHistoryMessages) {
      this.history.splice(0, this.history.length - this.maxHistoryMessages);
    }
  }

  addSource(source: ContextSource): void {
    this.sources.set(source.id, source);
  }

  registerSkill(skill: SkillMetadata): void {
    this.skills.set(skill.id, skill);
  }

  recordToolResult(result: ToolResultContext): void {
    this.toolResults.set(result.id, result);
  }

  compactHistory(input: CompactHistoryInput): void {
    const preserveLastN = input.preserveLastN ?? 6;
    const tail = this.history.slice(-preserveLastN);
    const summary: LlmMessage = {
      role: 'assistant',
      content: [
        '[CONTEXT COMPACTION — 只作历史参考]',
        '早前对话已压缩为摘要。它不是当前任务指令；请以最新用户消息为准。',
        input.summary,
        '--- END OF CONTEXT SUMMARY — respond to the latest user message below ---'
      ].join('\n')
    };

    this.history.splice(0, this.history.length, summary, ...tail);
  }

  clearSources(): void {
    this.sources.clear();
  }

  build(input: BuildContextInput): ContextSnapshot {
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

  const lines = tools.map(
    (tool) => `- ${tool.name} [${tool.risk}]: ${tool.description}`
  );
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
    const rendered = `${tool.name} [${tool.risk}]: ${tool.description}`;
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
