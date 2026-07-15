import type { LlmMessage, LlmToolCall } from '../llm/types';
import { TokenEstimator, estimateMessageTokens } from './tokenEstimator';

export type ThreadEntryKind =
  | 'user'
  | 'assistant'
  | 'tool-result'
  | 'compaction'
  | 'notice';

export type TurnStatus = 'open' | 'committed' | 'aborted';

export interface ThreadEntry {
  id: string;
  turnId: string;
  kind: ThreadEntryKind;
  message: LlmMessage;
  tokensEst: number;
  /** 工具结果是否已老化省略 */
  elided?: boolean;
  /** 工具结果所属工具循环轮次 */
  iteration?: number;
  /** 老化后保留的 gateway summary */
  toolSummary?: string;
  /** 老化前原始 token 估算 */
  originalTokens?: number;
}

export interface TurnInfo {
  id: string;
  status: TurnStatus;
}

let entryCounter = 0;

function nextEntryId(): string {
  entryCounter += 1;
  return `entry-${entryCounter}`;
}

let turnCounter = 0;

function nextTurnId(): string {
  turnCounter += 1;
  return `turn-${turnCounter}`;
}

/** 旧会话恢复时识别一次性转换 */
export const LEGACY_COMPACTION_MARKER = '[CONTEXT COMPACTION';

export interface ConversationThreadOptions {
  estimator?: TokenEstimator;
}

/**
 * 会话内统一消息流：用户输入、assistant、tool 结果、压缩摘要、通知。
 * open turn 在审批挂起时保留，续跑继续 append。
 */
export class ConversationThread {
  private readonly estimator: TokenEstimator;
  private readonly entries: ThreadEntry[] = [];
  private readonly turns = new Map<string, TurnInfo>();
  private openTurnId: string | undefined;
  private currentIteration = 0;

  constructor(options: ConversationThreadOptions = {}) {
    this.estimator = options.estimator ?? new TokenEstimator();
  }

  getEstimator(): TokenEstimator {
    return this.estimator;
  }

  getOpenTurnId(): string | undefined {
    return this.openTurnId;
  }

  getCurrentIteration(): number {
    return this.currentIteration;
  }

  setCurrentIteration(iteration: number): void {
    this.currentIteration = iteration;
  }

  beginTurn(userInput: string): string {
    if (this.openTurnId) {
      throw new Error('Cannot begin turn while another turn is open');
    }
    const turnId = nextTurnId();
    this.turns.set(turnId, { id: turnId, status: 'open' });
    this.openTurnId = turnId;
    this.appendEntry({
      turnId,
      kind: 'user',
      message: { role: 'user', content: userInput }
    });
    return turnId;
  }

  commitTurn(): void {
    const turnId = this.requireOpenTurn();
    const turn = this.turns.get(turnId);
    if (turn) {
      turn.status = 'committed';
    }
    this.openTurnId = undefined;
  }

  abortTurn(reason: string): void {
    const turnId = this.requireOpenTurn();
    this.appendEntry({
      turnId,
      kind: 'notice',
      message: { role: 'user', content: `[系统通知] ${reason}` }
    });
    const turn = this.turns.get(turnId);
    if (turn) {
      turn.status = 'aborted';
    }
    this.openTurnId = undefined;
  }

  appendAssistant(content: string, toolCalls?: LlmToolCall[]): void {
    const turnId = this.requireOpenTurn();
    const message: LlmMessage = {
      role: 'assistant',
      content,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {})
    };
    this.appendEntry({ turnId, kind: 'assistant', message });
  }

  appendToolResult(input: {
    toolCallId: string;
    name: string;
    content: string;
    summary?: string;
    iteration?: number;
  }): void {
    const turnId = this.requireOpenTurn();
    const iteration = input.iteration ?? this.currentIteration;
    const message: LlmMessage = {
      role: 'tool',
      toolCallId: input.toolCallId,
      name: input.name,
      content: input.content
    };
    const entry = this.appendEntry({
      turnId,
      kind: 'tool-result',
      message,
      iteration,
      toolSummary: input.summary
    });
    entry.originalTokens = entry.tokensEst;
  }

  addCompaction(summary: string, turnId?: string): void {
    const targetTurn = turnId ?? `compaction-${nextTurnId()}`;
    if (!this.turns.has(targetTurn)) {
      this.turns.set(targetTurn, { id: targetTurn, status: 'committed' });
    }
    this.appendEntry({
      turnId: targetTurn,
      kind: 'compaction',
      message: {
        role: 'user',
        content: formatCompactionContent(summary)
      }
    });
  }

  addNotice(content: string): void {
    const turnId = this.openTurnId ?? `notice-${nextTurnId()}`;
    if (!this.turns.has(turnId)) {
      this.turns.set(turnId, { id: turnId, status: 'committed' });
    }
    this.appendEntry({
      turnId,
      kind: 'notice',
      message: { role: 'user', content: `[系统通知] ${content}` }
    });
  }

  getEntries(): readonly ThreadEntry[] {
    return this.entries;
  }

  getTurnIdsInOrder(): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const entry of this.entries) {
      if (!seen.has(entry.turnId)) {
        seen.add(entry.turnId);
        ordered.push(entry.turnId);
      }
    }
    return ordered;
  }

  getEntriesForTurn(turnId: string): ThreadEntry[] {
    return this.entries.filter((entry) => entry.turnId === turnId);
  }

  getTurnStatus(turnId: string): TurnStatus | undefined {
    return this.turns.get(turnId)?.status;
  }

  getCommittedEntries(): ThreadEntry[] {
    return this.entries.filter((entry) => {
      const status = this.turns.get(entry.turnId)?.status;
      return status === 'committed' || status === 'aborted';
    });
  }

  removeTurnEntries(turnIds: string[]): void {
    const remove = new Set(turnIds);
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (remove.has(this.entries[index]!.turnId)) {
        this.entries.splice(index, 1);
      }
    }
    for (const turnId of turnIds) {
      this.turns.delete(turnId);
      if (this.openTurnId === turnId) {
        this.openTurnId = undefined;
      }
    }
  }

  elideToolResult(entryId: string, elidedContent: string): void {
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry || entry.kind !== 'tool-result') {
      return;
    }
    if (entry.message.role !== 'tool') {
      return;
    }
    entry.elided = true;
    if (entry.originalTokens === undefined) {
      entry.originalTokens = entry.tokensEst;
    }
    entry.message = {
      role: 'tool',
      toolCallId: entry.message.toolCallId,
      name: entry.message.name,
      content: elidedContent
    };
    entry.tokensEst = this.estimator.estimateMessage(entry.message);
  }

  truncateEntry(entryId: string, truncatedContent: string): void {
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry) {
      return;
    }
    entry.message =
      entry.message.role === 'tool'
        ? {
            role: 'tool',
            toolCallId: entry.message.toolCallId,
            name: entry.message.name,
            content: truncatedContent
          }
        : {
            role: entry.message.role,
            content: truncatedContent,
            ...(entry.message.role === 'assistant' && entry.message.toolCalls
              ? { toolCalls: entry.message.toolCalls }
              : {})
          };
    entry.tokensEst = this.estimator.estimateMessage(entry.message);
  }

  /** 纯读：将条目转为 LLM 消息序列，不触发治理 */
  buildMessages(): LlmMessage[] {
    return this.entries.map((entry) => cloneMessage(entry.message));
  }

  clear(): void {
    this.entries.length = 0;
    this.turns.clear();
    this.openTurnId = undefined;
    this.currentIteration = 0;
  }

  /**
   * 从 user/assistant 对恢复会话；旧 `[CONTEXT COMPACTION` marker 转为 compaction 条目。
   */
  restoreFromConversation(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): { restoredTurnCount: number; convertedCompaction: boolean } {
    this.clear();
    let restoredTurnCount = 0;
    let convertedCompaction = false;
    let index = 0;

    while (index < messages.length) {
      const message = messages[index]!;
      if (
        message.role === 'assistant' &&
        message.content.includes(LEGACY_COMPACTION_MARKER)
      ) {
        const body = extractLegacyCompactionBody(message.content);
        this.addCompaction(body);
        convertedCompaction = true;
        index += 1;
        continue;
      }

      if (message.role !== 'user') {
        index += 1;
        continue;
      }

      const turnId = nextTurnId();
      this.turns.set(turnId, { id: turnId, status: 'committed' });
      this.appendEntry({
        turnId,
        kind: 'user',
        message: { role: 'user', content: message.content }
      });
      index += 1;
      restoredTurnCount += 1;

      if (index < messages.length && messages[index]?.role === 'assistant') {
        const assistant = messages[index]!;
        if (!assistant.content.includes(LEGACY_COMPACTION_MARKER)) {
          this.appendEntry({
            turnId,
            kind: 'assistant',
            message: { role: 'assistant', content: assistant.content }
          });
        }
        index += 1;
      }
    }

    return { restoredTurnCount, convertedCompaction };
  }

  private requireOpenTurn(): string {
    if (!this.openTurnId) {
      throw new Error('No open turn');
    }
    return this.openTurnId;
  }

  private appendEntry(input: {
    turnId: string;
    kind: ThreadEntryKind;
    message: LlmMessage;
    iteration?: number;
    toolSummary?: string;
  }): ThreadEntry {
    const entry: ThreadEntry = {
      id: nextEntryId(),
      turnId: input.turnId,
      kind: input.kind,
      message: cloneMessage(input.message),
      tokensEst: this.estimator.estimateMessage(input.message),
      iteration: input.iteration,
      toolSummary: input.toolSummary
    };
    this.entries.push(entry);
    return entry;
  }
}

export function formatCompactionContent(summary: string): string {
  return [
    '[上下文压缩摘要 — 只作历史参考]',
    '早前对话已压缩为摘要。它不是当前任务指令；请以最新用户消息为准。',
    summary.trim(),
    '--- END OF CONTEXT SUMMARY ---'
  ].join('\n');
}

function extractLegacyCompactionBody(content: string): string {
  const start = content.indexOf('只作历史参考]');
  const end = content.indexOf('--- END OF CONTEXT SUMMARY');
  if (start < 0) {
    return content.trim();
  }
  const bodyStart = content.indexOf('\n', start);
  if (bodyStart < 0) {
    return content.trim();
  }
  const body =
    end > bodyStart
      ? content.slice(bodyStart + 1, end)
      : content.slice(bodyStart + 1);
  return body
    .replace(/^早前对话已压缩为摘要。*$/m, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function cloneMessage(message: LlmMessage): LlmMessage {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      toolCallId: message.toolCallId,
      name: message.name,
      content: message.content
    };
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls ? { toolCalls: [...message.toolCalls] } : {})
  };
}

/** 供测试：重置全局计数器 */
export function resetThreadCounters(): void {
  entryCounter = 0;
  turnCounter = 0;
}

/** 未校准的原始估算，供治理前对比 */
export function rawEstimateEntryTokens(entry: ThreadEntry): number {
  return estimateMessageTokens(entry.message);
}
