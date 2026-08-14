import type { LlmClient, LlmMessage } from '../llm/types';
import { isOperationAborted, throwIfAborted } from '../abort';
import { renderPrompt } from '../prompts';
import type { ThreadEntry } from './conversationThread';
import { formatCompactionContent } from './conversationThread';

export interface SummarizeTurnInput {
  turnId: string;
  entries: ThreadEntry[];
}

export interface SummarizeOptions {
  /** 之前已生成的滚动摘要；新摘要必须吸收它，而不是并排堆叠。 */
  previousSummary?: string;
  /** 本次手动压缩的额外关注点。 */
  instructions?: string;
  /** 自动治理属于当前 run，必须能随 run 一起取消。 */
  signal?: AbortSignal;
}

export interface Summarizer {
  summarizeTurns(
    turns: SummarizeTurnInput[],
    options?: SummarizeOptions
  ): Promise<string>;
}

/**
 * 结构化 extractive 摘要：保留每轮做了什么、涉及哪些工具，避免嵌套 clip 碎片。
 */
export function buildExtractiveTurnSummary(turns: SummarizeTurnInput[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    const parts: string[] = [];
    for (const entry of turn.entries) {
      if (entry.kind === 'user') {
        const text = clip(entry.message.content, 2_000);
        if (text) {
          parts.push(`用户: ${text}`);
        }
      } else if (entry.kind === 'assistant') {
        const text = clip(entry.message.content, 4_000);
        if (text) {
          parts.push(`助手: ${text}`);
        }
        if (entry.message.role === 'assistant' && entry.message.toolCalls) {
          const tools = entry.message.toolCalls
            .map(
              (call) =>
                `${call.name}(${clip(safeJson(call.input), 2_000)})`
            )
            .join(', ');
          if (tools) {
            parts.push(`工具调用: ${tools}`);
          }
        }
      } else if (entry.kind === 'tool-result' && entry.message.role === 'tool') {
        const preview = clip(entry.toolSummary ?? entry.message.content, 2_000);
        parts.push(`工具 ${entry.message.name}: ${preview}`);
      } else if (entry.kind === 'notice') {
        const text = clip(entry.message.content, 1_000);
        if (text) {
          parts.push(`状态: ${text}`);
        }
      }
    }
    if (parts.length > 0) {
      lines.push(`- 轮次 ${turn.turnId}: ${parts.join('; ')}`);
    }
  }

  if (lines.length === 0) {
    return '早前对话已压缩；细节不可用。';
  }
  return lines.join('\n');
}

export class ExtractiveSummarizer implements Summarizer {
  async summarizeTurns(
    turns: SummarizeTurnInput[],
    options: SummarizeOptions = {}
  ): Promise<string> {
    throwIfAborted(options.signal);
    return mergeFallbackSummary(options.previousSummary, turns);
  }
}

export class LlmSummarizer implements Summarizer {
  private readonly fallback = new ExtractiveSummarizer();

  constructor(private llmClient: LlmClient | undefined) {}

  setLlmClient(client: LlmClient | undefined): void {
    this.llmClient = client;
  }

  async summarizeTurns(
    turns: SummarizeTurnInput[],
    options: SummarizeOptions = {}
  ): Promise<string> {
    throwIfAborted(options.signal);
    if (!this.llmClient || (turns.length === 0 && !options.previousSummary)) {
      return this.fallback.summarizeTurns(turns, options);
    }

    const transcript = buildExtractiveTurnSummary(turns);
    const prior = options.previousSummary?.trim();
    const instructions = options.instructions?.trim();
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: renderPrompt('context.compaction.system')
      },
      {
        role: 'user',
        content: [
          prior
            ? renderPrompt('context.compaction.previous', { summary: prior })
            : '',
          renderPrompt('context.compaction.turns', { transcript }),
          instructions
            ? renderPrompt('context.compaction.instructions', { instructions })
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ];

    try {
      const response = await this.llmClient.complete({
        messages,
        signal: options.signal,
        temperature: 0.1,
        metadata: { purpose: 'context-compaction' }
      });
      const text = response.text?.trim();
      if (text) {
        return text;
      }
    } catch (error) {
      if (isOperationAborted(error, options.signal)) {
        throw error;
      }
      // 回退 extractive
    }
    throwIfAborted(options.signal);
    return this.fallback.summarizeTurns(turns, options);
  }
}

function mergeFallbackSummary(
  previousSummary: string | undefined,
  turns: SummarizeTurnInput[]
): string {
  const fresh = buildExtractiveTurnSummary(turns);
  const previous = previousSummary?.trim();
  if (!previous) {
    return fresh;
  }
  if (turns.length === 0) {
    return previous;
  }
  return [`既有摘要：\n${clip(previous, 12_000)}`, `新增历史：\n${fresh}`].join(
    '\n\n'
  );
}

export function compactionMessageFromSummary(summary: string): LlmMessage {
  return {
    role: 'user',
    content: formatCompactionContent(summary)
  };
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
