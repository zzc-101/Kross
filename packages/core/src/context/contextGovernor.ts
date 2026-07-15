import { formatToolInputPreview } from '../tools/formatToolInputPreview';
import { throwIfAborted } from '../abort';
import type { ContextPolicy } from './contextPolicy';
import {
  ConversationThread,
  extractCompactionBody,
  type ThreadEntry
} from './conversationThread';
import type {
  SummarizeOptions,
  SummarizeTurnInput,
  Summarizer
} from './summarizer';
import { ExtractiveSummarizer } from './summarizer';
import type { TokenEstimator } from './tokenEstimator';
import { estimateTextTokens } from './tokenEstimator';

export type GovernanceStage =
  | 'tool-aging'
  | 'turn-compaction'
  | 'hard-truncation';

export type ContextMaintenanceReason =
  | 'tool_aging'
  | 'turn_compaction'
  | 'hard_truncation'
  | 'restore_truncation'
  | 'manual'
  | 'pre_request';

export interface ContextMaintenanceResult {
  compacted: boolean;
  stage?: GovernanceStage;
  reason?: ContextMaintenanceReason;
  droppedMessageCount: number;
  preservedMessageCount: number;
  tokensBefore: number;
  tokensAfter: number;
  /** 兼容旧 trace / TUI 字段 */
  historyCharsBefore: number;
  historyCharsAfter: number;
  summaryChars?: number;
  droppedTurnCount?: number;
  /** 治理发生时间（ISO），供 /context 展示 */
  at?: string;
}

export interface GovernInput {
  thread: ConversationThread;
  /** 不含 system 段的线程消息 token 预算 */
  threadTokenBudget: number;
  signal?: AbortSignal;
}

export interface GovernResult {
  maintenance: ContextMaintenanceResult[];
  tokensAfter: number;
}

/**
 * 三级治理流水线：工具结果老化 → 轮次压缩 → 单条硬截断。
 * 仅在 prepareRequest 时调用；保留 tool 消息本体以满足 tool_call 配对协议。
 */
export class ContextGovernor {
  private readonly policy: ContextPolicy;
  private readonly estimator: TokenEstimator;
  private readonly summarizer: Summarizer;

  constructor(input: {
    policy: ContextPolicy;
    estimator: TokenEstimator;
    summarizer?: Summarizer;
  }) {
    this.policy = input.policy;
    this.estimator = input.estimator;
    this.summarizer = input.summarizer ?? new ExtractiveSummarizer();
  }

  async govern(input: GovernInput): Promise<GovernResult> {
    throwIfAborted(input.signal);
    const maintenance: ContextMaintenanceResult[] = [];
    const thread = input.thread;
    let budget = input.threadTokenBudget;
    let tokens = this.estimateThreadTokens(thread);

    if (tokens <= budget) {
      return { maintenance, tokensAfter: tokens };
    }

    // Stage 1: 工具结果老化
    const stage1 = this.applyToolAging(thread, budget);
    if (stage1.changed) {
      maintenance.push(stage1.result);
      tokens = this.estimateThreadTokens(thread);
      if (tokens <= budget) {
        return { maintenance, tokensAfter: tokens };
      }
    }

    // Stage 2: 滚动压缩（优先整轮，超长单轮仅在安全 assistant 边界切分）
    const stage2 = await this.applyTurnCompaction(
      thread,
      budget,
      input.signal
    );
    throwIfAborted(input.signal);
    if (stage2.changed) {
      maintenance.push(stage2.result);
      tokens = this.estimateThreadTokens(thread);
      if (tokens <= budget) {
        return { maintenance, tokensAfter: tokens };
      }
    }

    // Stage 3: 单条超大消息硬截断
    const stage3 = this.applyHardTruncation(thread, budget);
    if (stage3.changed) {
      maintenance.push(stage3.result);
      tokens = this.estimateThreadTokens(thread);
    }

    return { maintenance, tokensAfter: tokens };
  }

  /**
   * 手动触发一轮 Stage2 轮次压缩（/compact），不检查是否超阈值。
   */
  async compactTurnsNow(
    thread: ConversationThread,
    options: Pick<SummarizeOptions, 'instructions' | 'signal'> = {}
  ): Promise<ContextMaintenanceResult> {
    throwIfAborted(options.signal);
    const tokensBefore = this.estimateThreadTokens(thread);
    const selection = selectManualPrefix(
      thread,
      this.policy.preserveFullTurns
    );
    if (!selection) {
      return {
        compacted: false,
        reason: 'manual',
        droppedMessageCount: 0,
        preservedMessageCount: thread.getEntries().length,
        tokensBefore,
        tokensAfter: tokensBefore,
        historyCharsBefore: tokensBefore * 4,
        historyCharsAfter: tokensBefore * 4
      };
    }
    return this.compactPrefix(thread, selection, 'manual', options);
  }

  private applyToolAging(
    thread: ConversationThread,
    budget: number
  ): { changed: boolean; result: ContextMaintenanceResult } {
    const entries = [...thread.getEntries()];
    const toolEntries = entries.filter((entry) => entry.kind === 'tool-result');
    const tokensBefore = this.estimateThreadTokens(thread);

    if (toolEntries.length === 0) {
      return {
        changed: false,
        result: emptyMaintenance(thread, tokensBefore, tokensBefore)
      };
    }

    const maxIteration = Math.max(
      ...toolEntries.map((entry) => entry.iteration ?? 0)
    );
    const keepFromIteration = maxIteration - this.policy.preserveToolIterations + 1;

    let toolTokens = toolEntries.reduce((sum, entry) => sum + entry.tokensEst, 0);
    let changed = false;

    // 单条注入上限：head+tail 截断
    for (const entry of toolEntries) {
      if (entry.tokensEst > this.policy.maxToolResultTokens) {
        const truncated = truncateHeadTail(
          entry.message.content,
          this.policy.maxToolResultTokens
        );
        thread.truncateEntry(entry.id, truncated);
        changed = true;
        toolTokens = recalcToolTokens(thread);
      }
    }

    // 按 iteration 老化
    for (const entry of toolEntries) {
      const iteration = entry.iteration ?? 0;
      const shouldAge =
        iteration < keepFromIteration ||
        toolTokens > this.policy.toolResultQuota;
      if (!shouldAge || entry.elided) {
        continue;
      }
      const elidedContent = buildElidedToolContent(entry);
      thread.elideToolResult(entry.id, elidedContent);
      changed = true;
      toolTokens = recalcToolTokens(thread);
      if (toolTokens <= this.policy.toolResultQuota) {
        break;
      }
    }

    const tokensAfter = this.estimateThreadTokens(thread);
    if (!changed) {
      return {
        changed: false,
        result: emptyMaintenance(thread, tokensBefore, tokensAfter)
      };
    }

    return {
      changed: true,
      result: {
        compacted: true,
        stage: 'tool-aging',
        reason: 'tool_aging',
        droppedMessageCount: 0,
        preservedMessageCount: thread.getEntries().length,
        tokensBefore,
        tokensAfter,
        historyCharsBefore: tokensBefore * 4,
        historyCharsAfter: tokensAfter * 4
      }
    };
  }

  private async applyTurnCompaction(
    thread: ConversationThread,
    budget: number,
    signal?: AbortSignal
  ): Promise<{ changed: boolean; result: ContextMaintenanceResult }> {
    const tokensBefore = this.estimateThreadTokens(thread);
    if (tokensBefore <= budget) {
      return {
        changed: false,
        result: emptyMaintenance(thread, tokensBefore, tokensBefore)
      };
    }

    const selection = selectAutomaticPrefix(
      thread,
      Math.min(this.policy.preserveRecentTokens, Math.max(0, budget))
    );
    if (!selection) {
      return {
        changed: false,
        result: emptyMaintenance(thread, tokensBefore, tokensBefore)
      };
    }
    const result = await this.compactPrefix(
      thread,
      selection,
      'turn_compaction',
      { signal }
    );
    return {
      changed: result.compacted,
      result
    };
  }

  private async compactPrefix(
    thread: ConversationThread,
    selection: CompactionSelection,
    reason: 'manual' | 'turn_compaction',
    options: Pick<SummarizeOptions, 'instructions' | 'signal'> = {}
  ): Promise<ContextMaintenanceResult> {
    const tokensBefore = this.estimateThreadTokens(thread);
    const summary = await this.summarizer.summarizeTurns(selection.turns, {
      previousSummary: selection.previousSummary,
      instructions: options.instructions,
      signal: options.signal
    });
    throwIfAborted(options.signal);
    thread.replacePrefixWithCompaction(selection.entryCount, summary);
    const tokensAfter = this.estimateThreadTokens(thread);

    return {
      compacted: true,
      stage: 'turn-compaction',
      reason,
      droppedMessageCount: selection.droppedMessageCount,
      droppedTurnCount: selection.droppedTurnCount,
      preservedMessageCount: thread.getEntries().length,
      tokensBefore,
      tokensAfter,
      historyCharsBefore: tokensBefore * 4,
      historyCharsAfter: tokensAfter * 4,
      summaryChars: summary.length
    };
  }

  private applyHardTruncation(
    thread: ConversationThread,
    budget: number
  ): { changed: boolean; result: ContextMaintenanceResult } {
    const tokensBefore = this.estimateThreadTokens(thread);
    if (tokensBefore <= budget) {
      return {
        changed: false,
        result: emptyMaintenance(thread, tokensBefore, tokensBefore)
      };
    }

    let changed = false;
    const perMessageCap = Math.max(
      256,
      Math.floor(budget / Math.max(1, thread.getEntries().length))
    );

    for (const entry of thread.getEntries()) {
      if (entry.tokensEst <= perMessageCap) {
        continue;
      }
      const truncated = truncateHeadTail(
        entry.message.content,
        perMessageCap
      );
      const notice = `\n\n[已截断: 单条消息超出预算，原文约 ${entry.originalTokens ?? entry.tokensEst} tokens]`;
      thread.truncateEntry(entry.id, `${truncated}${notice}`);
      thread.addNotice(`单条消息已硬截断 (${entry.kind})`);
      changed = true;
    }

    const tokensAfter = this.estimateThreadTokens(thread);
    if (!changed) {
      return {
        changed: false,
        result: emptyMaintenance(thread, tokensBefore, tokensAfter)
      };
    }

    return {
      changed: true,
      result: {
        compacted: true,
        stage: 'hard-truncation',
        reason: 'hard_truncation',
        droppedMessageCount: 0,
        preservedMessageCount: thread.getEntries().length,
        tokensBefore,
        tokensAfter,
        historyCharsBefore: tokensBefore * 4,
        historyCharsAfter: tokensAfter * 4
      }
    };
  }

  private estimateThreadTokens(thread: ConversationThread): number {
    return thread.getEntries().reduce((sum, entry) => sum + entry.tokensEst, 0);
  }
}

function buildElidedToolContent(entry: ThreadEntry): string {
  if (entry.message.role !== 'tool') {
    return entry.message.content;
  }
  const originalTokens = entry.originalTokens ?? entry.tokensEst;
  const inputPreview =
    entry.toolSummary?.slice(0, 80) ??
    clip(entry.message.content, 60);
  const summaryPart = entry.toolSummary
    ? `\n摘要: ${clip(entry.toolSummary, 200)}`
    : '';
  return `[已省略: ${entry.message.name} ${inputPreview}, 原始约 ${formatTokenCount(originalTokens)} tokens]${summaryPart}`;
}

function truncateHeadTail(content: string, maxTokens: number): string {
  const maxChars = Math.max(32, maxTokens * 4);
  if (content.length <= maxChars) {
    return content;
  }
  const half = Math.floor((maxChars - 20) / 2);
  return `${content.slice(0, half)}\n…[中间已省略]…\n${content.slice(-half)}`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return String(tokens);
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function recalcToolTokens(thread: ConversationThread): number {
  return thread
    .getEntries()
    .filter((entry) => entry.kind === 'tool-result')
    .reduce((sum, entry) => sum + entry.tokensEst, 0);
}

function emptyMaintenance(
  thread: ConversationThread,
  tokensBefore: number,
  tokensAfter: number
): ContextMaintenanceResult {
  return {
    compacted: false,
    droppedMessageCount: 0,
    preservedMessageCount: thread.getEntries().length,
    tokensBefore,
    tokensAfter,
    historyCharsBefore: tokensBefore * 4,
    historyCharsAfter: tokensAfter * 4
  };
}

export function buildElidedPreview(
  toolName: string,
  input: unknown,
  originalTokens: number
): string {
  const preview = formatToolInputPreview(toolName, input, 80);
  return `[已省略: ${toolName} ${preview}, 原始约 ${formatTokenCount(originalTokens)} tokens]`;
}

export { estimateTextTokens };

interface EntryRange {
  turnId: string;
  start: number;
  end: number;
  tokens: number;
}

interface CompactionSelection {
  entryCount: number;
  turns: SummarizeTurnInput[];
  previousSummary?: string;
  droppedMessageCount: number;
  droppedTurnCount: number;
}

function selectManualPrefix(
  thread: ConversationThread,
  preserveFullTurns: number
): CompactionSelection | undefined {
  const entries = [...thread.getEntries()];
  const ranges = getCompactableRanges(thread, entries);
  if (ranges.length <= preserveFullTurns) {
    return undefined;
  }
  const firstPreserved = ranges[ranges.length - preserveFullTurns];
  const entryCount = firstPreserved?.start ?? ranges.at(-1)!.end;
  return buildCompactionSelection(entries, entryCount);
}

/**
 * 从尾部按 token 选择最近原文。单个已提交 turn 超限时，只在 assistant
 * 条目前切开，确保任何保留的 tool result 前仍有对应 tool-call 消息。
 */
function selectAutomaticPrefix(
  thread: ConversationThread,
  preserveRecentTokens: number
): CompactionSelection | undefined {
  const entries = [...thread.getEntries()];
  const ranges = getCompactableRanges(thread, entries);
  if (ranges.length === 0) {
    return undefined;
  }

  const tokenBudget = Math.max(1, preserveRecentTokens);
  let retainedTokens = 0;
  let boundary = ranges.at(-1)!.end;

  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    if (retainedTokens + range.tokens <= tokenBudget) {
      retainedTokens += range.tokens;
      boundary = range.start;
      continue;
    }

    if (retainedTokens === 0) {
      const split = findSafeSuffixStart(entries, range, tokenBudget);
      if (split !== undefined) {
        boundary = split;
      } else {
        boundary = range.start;
      }
    } else {
      // 已经有可保留的新尾部时，当前这个放不下的旧 turn 应整体进入摘要。
      // range.start 会反过来保留它，导致随后误走 hard truncation。
      boundary = range.end;
    }
    break;
  }

  return buildCompactionSelection(entries, boundary);
}

function getCompactableRanges(
  thread: ConversationThread,
  entries: ThreadEntry[]
): EntryRange[] {
  const openTurnId = thread.getOpenTurnId();
  const ranges: EntryRange[] = [];
  for (let index = 0; index < entries.length; ) {
    const turnId = entries[index]!.turnId;
    const start = index;
    let tokens = 0;
    let compactionOnly = true;
    while (index < entries.length && entries[index]!.turnId === turnId) {
      const entry = entries[index]!;
      tokens += entry.tokensEst;
      compactionOnly &&= entry.kind === 'compaction';
      index += 1;
    }
    const status = thread.getTurnStatus(turnId);
    if (
      turnId !== openTurnId &&
      !compactionOnly &&
      (status === 'committed' || status === 'aborted')
    ) {
      ranges.push({ turnId, start, end: index, tokens });
    }
  }
  return ranges;
}

function findSafeSuffixStart(
  entries: ThreadEntry[],
  range: EntryRange,
  tokenBudget: number
): number | undefined {
  for (let index = range.start + 1; index < range.end; index += 1) {
    const entry = entries[index]!;
    if (entry.kind !== 'assistant' || entry.message.role !== 'assistant') {
      continue;
    }
    const suffixTokens = entries
      .slice(index, range.end)
      .reduce((sum, item) => sum + item.tokensEst, 0);
    if (suffixTokens <= tokenBudget) {
      return index;
    }
  }
  return undefined;
}

function buildCompactionSelection(
  entries: ThreadEntry[],
  entryCount: number
): CompactionSelection | undefined {
  if (entryCount <= 0) {
    return undefined;
  }
  const prefix = entries.slice(0, entryCount);
  const previousSummaries = prefix
    .filter((entry) => entry.kind === 'compaction')
    .map((entry) => extractCompactionBody(entry.message.content))
    .filter(Boolean);
  const turnOrder: string[] = [];
  const byTurn = new Map<string, ThreadEntry[]>();
  for (const entry of prefix) {
    if (entry.kind === 'compaction') {
      continue;
    }
    if (!byTurn.has(entry.turnId)) {
      byTurn.set(entry.turnId, []);
      turnOrder.push(entry.turnId);
    }
    byTurn.get(entry.turnId)!.push(entry);
  }
  const turns = turnOrder.map((turnId) => ({
    turnId,
    entries: byTurn.get(turnId)!
  }));
  if (turns.length === 0 && previousSummaries.length === 0) {
    return undefined;
  }
  return {
    entryCount,
    turns,
    previousSummary: previousSummaries.join('\n\n'),
    droppedMessageCount: prefix.filter((entry) => entry.kind !== 'compaction')
      .length,
    droppedTurnCount: turns.length
  };
}
