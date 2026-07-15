import type { LlmClient, LlmMessage } from '../llm/types';
import type { ThreadEntry } from './conversationThread';
import { formatCompactionContent } from './conversationThread';

export interface SummarizeTurnInput {
  turnId: string;
  entries: ThreadEntry[];
}

export interface Summarizer {
  summarizeTurns(turns: SummarizeTurnInput[]): Promise<string>;
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
        const text = clip(entry.message.content, 200);
        if (text) {
          parts.push(`用户: ${text}`);
        }
      } else if (entry.kind === 'assistant') {
        const text = clip(entry.message.content, 200);
        if (text) {
          parts.push(`助手: ${text}`);
        }
        if (entry.message.role === 'assistant' && entry.message.toolCalls) {
          const tools = entry.message.toolCalls
            .map((call) => call.name)
            .join(', ');
          if (tools) {
            parts.push(`工具调用: ${tools}`);
          }
        }
      } else if (entry.kind === 'tool-result' && entry.message.role === 'tool') {
        const preview = clip(entry.message.content, 120);
        parts.push(`工具 ${entry.message.name}: ${preview}`);
      } else if (entry.kind === 'compaction') {
        parts.push(`(prior summary) ${clip(entry.message.content, 180)}`);
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
  async summarizeTurns(turns: SummarizeTurnInput[]): Promise<string> {
    return buildExtractiveTurnSummary(turns);
  }
}

export class LlmSummarizer implements Summarizer {
  private readonly fallback = new ExtractiveSummarizer();

  constructor(private readonly llmClient: LlmClient | undefined) {}

  async summarizeTurns(turns: SummarizeTurnInput[]): Promise<string> {
    if (!this.llmClient || turns.length === 0) {
      return this.fallback.summarizeTurns(turns);
    }

    const transcript = buildExtractiveTurnSummary(turns);
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          '你是上下文压缩助手。将以下对话轮次压缩为简洁中文摘要，保留：用户目标、已执行操作、涉及文件/工具、关键结论。不要编造。'
      },
      {
        role: 'user',
        content: `请压缩以下对话历史：\n\n${transcript}`
      }
    ];

    try {
      const response = await this.llmClient.complete({
        messages,
        temperature: 0.1,
        metadata: { purpose: 'context-compaction' }
      });
      const text = response.text?.trim();
      if (text) {
        return text;
      }
    } catch {
      // 回退 extractive
    }
    return this.fallback.summarizeTurns(turns);
  }
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
