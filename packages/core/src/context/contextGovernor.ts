import { formatToolInputPreview } from '../tools/formatToolInputPreview';
import type { ContextPolicy } from './contextPolicy';
import {
  ConversationThread,
  type ThreadEntry
} from './conversationThread';
import type { Summarizer } from './summarizer';
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

    // Stage 2: 轮次压缩（原子性：整轮 user+assistant+tools 一起压）
    const stage2 = await this.applyTurnCompaction(thread, budget);
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
  async compactTurnsNow(thread: ConversationThread): Promise<ContextMaintenanceResult> {
    const tokensBefore = this.estimateThreadTokens(thread);
    const turnIds = thread.getTurnIdsInOrder();
    const openTurnId = thread.getOpenTurnId();
    const compactable = turnIds.filter(
      (turnId) =>
        turnId !== openTurnId &&
        !isCompactionOnlyTurn(thread, turnId)
    );

    if (compactable.length <= this.policy.preserveFullTurns) {
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

    const toCompactCount = compactable.length - this.policy.preserveFullTurns;
    const toCompact = compactable.slice(0, toCompactCount);
    const summarizeInput = toCompact.map((turnId) => ({
      turnId,
      entries: thread.getEntriesForTurn(turnId)
    }));

    const summary = await this.summarizer.summarizeTurns(summarizeInput);
    thread.removeTurnEntries(toCompact);
    thread.addCompaction(summary);

    const tokensAfter = this.estimateThreadTokens(thread);
    const droppedMessages = summarizeInput.reduce(
      (sum, turn) => sum + turn.entries.length,
      0
    );

    return {
      compacted: true,
      stage: 'turn-compaction',
      reason: 'manual',
      droppedMessageCount: droppedMessages,
      droppedTurnCount: toCompact.length,
      preservedMessageCount: thread.getEntries().length,
      tokensBefore,
      tokensAfter,
      historyCharsBefore: tokensBefore * 4,
      historyCharsAfter: tokensAfter * 4,
      summaryChars: summary.length
    };
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
    budget: number
  ): Promise<{ changed: boolean; result: ContextMaintenanceResult }> {
    const tokensBefore = this.estimateThreadTokens(thread);
    if (tokensBefore <= budget) {
      return {
        changed: false,
        result: emptyMaintenance(thread, tokensBefore, tokensBefore)
      };
    }

    const turnIds = thread.getTurnIdsInOrder();
    const openTurnId = thread.getOpenTurnId();
    const compactable = turnIds.filter(
      (turnId) =>
        turnId !== openTurnId &&
        !isCompactionOnlyTurn(thread, turnId)
    );

    if (compactable.length <= this.policy.preserveFullTurns) {
      return {
        changed: false,
        result: emptyMaintenance(thread, tokensBefore, tokensBefore)
      };
    }

    const toCompactCount = compactable.length - this.policy.preserveFullTurns;
    const toCompact = compactable.slice(0, toCompactCount);
    const summarizeInput = toCompact.map((turnId) => ({
      turnId,
      entries: thread.getEntriesForTurn(turnId)
    }));

    const summary = await this.summarizer.summarizeTurns(summarizeInput);
    thread.removeTurnEntries(toCompact);
    thread.addCompaction(summary);

    const tokensAfter = this.estimateThreadTokens(thread);
    const droppedMessages = summarizeInput.reduce(
      (sum, turn) => sum + turn.entries.length,
      0
    );

    return {
      changed: true,
      result: {
        compacted: true,
        stage: 'turn-compaction',
        reason: 'turn_compaction',
        droppedMessageCount: droppedMessages,
        droppedTurnCount: toCompact.length,
        preservedMessageCount: thread.getEntries().length,
        tokensBefore,
        tokensAfter,
        historyCharsBefore: tokensBefore * 4,
        historyCharsAfter: tokensAfter * 4,
        summaryChars: summary.length
      }
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

function isCompactionOnlyTurn(thread: ConversationThread, turnId: string): boolean {
  const entries = thread.getEntriesForTurn(turnId);
  return entries.length > 0 && entries.every((entry) => entry.kind === 'compaction');
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
