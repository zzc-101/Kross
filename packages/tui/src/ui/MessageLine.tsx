import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';

import { Markdown } from './Markdown';
import type { MdLine } from './markdownParse';
import { displayWidth } from './markdownParse';
import { symbols, theme } from './theme';
import { usePulse } from './usePulse';
import { ToolCallCard } from './ToolCallCard';

export type ToolCallStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'awaiting';

/** 聚合组内单次工具调用 */
export interface ToolCallItem {
  callId?: string;
  path?: string;
  preview?: string;
  status: ToolCallStatus;
  summary?: string;
  durationMs?: number;
}

export interface ToolCallState {
  callId?: string;
  name: string;
  risk?: string;
  status: ToolCallStatus;
  summary?: string;
  inputPreview?: string;
  durationMs?: number;
  /** Read 等多文件调用聚合明细 */
  items?: ToolCallItem[];
}

export interface ChatMessage {
  id: number;
  from: 'user' | 'agent' | 'system' | 'tool' | 'thinking';
  text: string;
  createdAt?: string;
  /** thinking 结束后冻结的耗时（ms） */
  durationMs?: number;
  /** 关联 tool 事件，from === 'tool' 时使用 */
  tool?: ToolCallState;
  /**
   * thinking / tool 组默认折叠；true 时展开明细。
   */
  expanded?: boolean;
  /**
   * 视口裁剪后的预渲染 MD 行（表格已展开为 box，span 样式保留）。
   */
  viewportLines?: MdLine[];
}

export function MessageList({
  messages,
  streamingMessageId
}: {
  messages: ChatMessage[];
  streamingMessageId?: number;
}) {
  return (
    <Box flexDirection="column">
      {messages.map((message) => (
        <MessageLine
          key={message.id}
          message={message}
          streaming={streamingMessageId === message.id}
        />
      ))}
    </Box>
  );
}

export function MessageLine({
  message,
  streaming = false
}: {
  message: ChatMessage;
  streaming?: boolean;
}) {
  const cursor = usePulse(symbols.cursorFrames, 420, streaming);

  if (message.from === 'tool' && message.tool) {
    return (
      <ToolCallCard
        tool={message.tool}
        expanded={message.expanded === true}
      />
    );
  }

  if (message.from === 'thinking') {
    return (
      <ThinkingBlock
        message={message}
        streaming={streaming}
      />
    );
  }

  if (message.from === 'system') {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text dimColor wrap="wrap">
          {symbols.systemPrefix} {message.text}
        </Text>
      </Box>
    );
  }

  if (message.from === 'user') {
    // Claude Code：> 前缀，不再显示 "you"
    const body = message.text.replace(/^\>\s*/, '');
    return (
      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text dimColor>
            {symbols.userPrefix}{' '}
          </Text>
          <Text dimColor wrap="wrap">
            {body}
          </Text>
        </Box>
      </Box>
    );
  }

  // agent：● 与正文同一视觉流，无 "kross" 标题行、无 │ rail
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Markdown
        source={message.viewportLines ? undefined : message.text}
        lines={message.viewportLines}
        rail={false}
        bullet={symbols.agentBullet}
        bulletColor={theme.agent}
        streaming={streaming}
        cursor={cursor}
      />
    </Box>
  );
}

function ThinkingBlock({
  message,
  streaming
}: {
  message: ChatMessage;
  streaming: boolean;
}) {
  const expanded = message.expanded === true;
  const spinner = usePulse(symbols.busyFrames, 80, streaming && !expanded);
  const { stdout } = useStdout();
  const columns = Math.max(20, (stdout?.columns ?? 80) - 4);
  const bodyWidth = Math.max(1, columns - 2);
  const label = formatThinkingLabel(message, streaming, spinner);

  const bodyLines = useMemo(() => {
    if (!expanded || streaming) {
      return [] as string[];
    }
    const raw = message.text.length === 0 ? [''] : message.text.split('\n');
    return raw.flatMap((line) => wrapPlainText(line, bodyWidth));
  }, [expanded, streaming, message.text, bodyWidth]);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 折叠态：单行 Thought for Ns（Claude Code 风格） */}
      <Text dimColor>
        {label}
        {!streaming ? (
          <Text dimColor>
            {expanded ? ' · ctrl+o/click 折叠' : ' · ctrl+o/click 展开'}
          </Text>
        ) : null}
      </Text>
      {expanded && !streaming
        ? bodyLines.map((line, index) => (
            <Box key={`thinking-${index}`}>
              <Text dimColor>{'  '}</Text>
              <Text dimColor wrap="truncate">
                {line}
              </Text>
            </Box>
          ))
        : null}
    </Box>
  );
}

export function formatThinkingLabel(
  message: Pick<ChatMessage, 'text' | 'durationMs' | 'createdAt'>,
  streaming: boolean,
  spinner?: string
): string {
  if (streaming) {
    return spinner ? `Thinking… ${spinner}` : 'Thinking…';
  }
  const seconds = formatThoughtSeconds(message);
  if (seconds !== undefined) {
    return `Thought for ${seconds}s`;
  }
  return 'Thought';
}

function formatThoughtSeconds(
  message: Pick<ChatMessage, 'durationMs' | 'createdAt'>
): number | undefined {
  if (typeof message.durationMs === 'number' && message.durationMs >= 0) {
    return Math.max(1, Math.round(message.durationMs / 1000));
  }
  if (message.createdAt) {
    const start = new Date(message.createdAt).getTime();
    if (!Number.isNaN(start)) {
      const elapsed = Date.now() - start;
      if (elapsed > 0 && elapsed < 24 * 3600 * 1000) {
        return Math.max(1, Math.round(elapsed / 1000));
      }
    }
  }
  return undefined;
}

function wrapPlainText(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  if (text.length === 0) {
    return [''];
  }
  const lines: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    let used = 0;
    let end = 0;
    let lastBreak = 0;
    for (const ch of rest) {
      const w = displayWidth(ch);
      if (used + w > width && end > 0) {
        break;
      }
      if (used + w > width && end === 0) {
        end = ch.length;
        break;
      }
      used += w;
      end += ch.length;
      if (ch === ' ' || ch === '\t') {
        lastBreak = end;
      }
    }
    if (end === 0) {
      end = [...rest][0]?.length ?? 1;
    } else if (end < rest.length && lastBreak > 0 && lastBreak < end) {
      end = lastBreak;
    }
    lines.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return lines.length > 0 ? lines : [''];
}

/** thinking 默认始终可折叠（收拢为 Thought 一行）。 */
export function isThinkingCollapsible(_text: string): boolean {
  return true;
}

/**
 * 兼容旧测试：expanded=false 时不展示正文行。
 */
export function collapseThinking(
  text: string,
  expanded: boolean
): { visibleLines: string[]; hiddenCount: number; totalLines: number } {
  const lines = text.length === 0 ? [''] : text.split('\n');
  const totalLines = lines.length;
  if (expanded) {
    return { visibleLines: lines, hiddenCount: 0, totalLines };
  }
  return {
    visibleLines: [],
    hiddenCount: Math.max(1, totalLines),
    totalLines
  };
}

/** @deprecated */
export function collapseLines(
  text: string,
  expanded: boolean
): { visibleLines: string[]; hiddenCount: number } {
  const result = collapseThinking(text, expanded);
  return {
    visibleLines: result.visibleLines,
    hiddenCount: result.hiddenCount
  };
}
