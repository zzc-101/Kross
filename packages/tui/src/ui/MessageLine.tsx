import React from 'react';
import { Box, Text } from 'ink';

import {
  THINKING_COLLAPSE_CHAR_LIMIT,
  THINKING_COLLAPSE_LINE_LIMIT,
  symbols,
  theme
} from './theme';
import { usePulse } from './usePulse';
import { ToolCallCard } from './ToolCallCard';

export type ToolCallStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'awaiting';

export interface ToolCallState {
  callId?: string;
  name: string;
  risk?: string;
  status: ToolCallStatus;
  summary?: string;
  inputPreview?: string;
  durationMs?: number;
}

export interface ChatMessage {
  id: number;
  from: 'user' | 'agent' | 'system' | 'tool' | 'thinking';
  text: string;
  createdAt?: string;
  /** 关联 tool 事件，from === 'tool' 时使用 */
  tool?: ToolCallState;
  /**
   * thinking 默认折叠；true 时展开全文。
   * 正式 agent 回复不再折叠。
   */
  expanded?: boolean;
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
  const time = formatTime(message.createdAt);

  if (message.from === 'tool' && message.tool) {
    return <ToolCallCard tool={message.tool} />;
  }

  if (message.from === 'thinking') {
    return (
      <ThinkingBlock
        text={message.text}
        expanded={message.expanded === true}
        streaming={streaming}
        time={time}
      />
    );
  }

  if (message.from === 'system') {
    return (
      <Box marginBottom={1}>
        <Text dimColor>
          {symbols.systemPrefix} {message.text}
        </Text>
        {time ? <Text dimColor>  {time}</Text> : null}
      </Box>
    );
  }

  if (message.from === 'user') {
    const body = message.text.replace(/^\>\s*/, '');
    return (
      <Box marginBottom={1}>
        <Text dimColor>{symbols.userLabel}  </Text>
        <Text color={theme.user}>{body}</Text>
        {time ? <Text dimColor>  {time}</Text> : null}
      </Box>
    );
  }

  // agent 回复：始终完整展示，不折叠
  const lines = message.text.length === 0 ? [''] : message.text.split('\n');
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.agent} bold>
          {symbols.agentLabel}
        </Text>
        {time ? <Text dimColor>  {time}</Text> : null}
      </Box>
      {lines.map((line: string, index: number) => {
        const isLast = index === lines.length - 1;
        return (
          <Box key={`${message.id}-${index}`}>
            <Text color={theme.brandMuted}>{symbols.messageRail} </Text>
            <Text>
              {line}
              {streaming && isLast ? (
                <Text color={theme.brand}>{cursor}</Text>
              ) : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ThinkingBlock({
  text,
  expanded,
  streaming,
  time
}: {
  text: string;
  expanded: boolean;
  streaming: boolean;
  time?: string;
}) {
  const spinner = usePulse(symbols.busyFrames, 80, streaming && !expanded);
  const { visibleLines, hiddenCount, totalLines } = collapseThinking(
    text,
    expanded || streaming
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text dimColor>thinking</Text>
        {streaming ? (
          <Text color={theme.statusBusy}>
            {' '}
            {spinner} reasoning
          </Text>
        ) : null}
        {time ? <Text dimColor>  {time}</Text> : null}
      </Box>
      {visibleLines.map((line, index) => (
        <Box key={`thinking-${index}`}>
          <Text dimColor>{symbols.messageRail} </Text>
          <Text dimColor>{line}</Text>
        </Box>
      ))}
      {!expanded && !streaming && hiddenCount > 0 ? (
        <Box>
          <Text dimColor>{symbols.messageRail} </Text>
          <Text dimColor>
            {symbols.collapseMark} 已折叠 thinking
            {totalLines > 1 ? ` ${hiddenCount}/${totalLines} 行` : ''} · ctrl+o 展开
          </Text>
        </Box>
      ) : null}
      {expanded && !streaming && isThinkingCollapsible(text) ? (
        <Box>
          <Text dimColor>{symbols.messageRail} </Text>
          <Text dimColor>
            {symbols.collapseMark} thinking 已展开 · ctrl+o 折叠
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** thinking 是否值得折叠（过短则始终展示）。 */
export function isThinkingCollapsible(text: string): boolean {
  const lines = text.length === 0 ? [] : text.split('\n');
  return (
    lines.length > THINKING_COLLAPSE_LINE_LIMIT ||
    text.length > THINKING_COLLAPSE_CHAR_LIMIT
  );
}

export function collapseThinking(
  text: string,
  expanded: boolean
): { visibleLines: string[]; hiddenCount: number; totalLines: number } {
  const lines = text.length === 0 ? [''] : text.split('\n');
  const totalLines = lines.length;
  if (expanded || !isThinkingCollapsible(text)) {
    return { visibleLines: lines, hiddenCount: 0, totalLines };
  }

  // 行数过多：按行预览；字符过多（含单行 dump）：截断预览行并给出折叠提示。
  const previewLineCount =
    text.length > THINKING_COLLAPSE_CHAR_LIMIT &&
    lines.length <= THINKING_COLLAPSE_LINE_LIMIT
      ? Math.min(4, lines.length)
      : Math.min(THINKING_COLLAPSE_LINE_LIMIT, lines.length);

  const sliced = lines.slice(0, previewLineCount);
  const lineHidden = lines.length - sliced.length;
  const maxLineChars = Math.max(
    80,
    Math.floor(THINKING_COLLAPSE_CHAR_LIMIT / Math.max(1, previewLineCount))
  );

  let anyCharTruncated = false;
  const visibleLines = sliced.map((line) => {
    if (line.length > maxLineChars) {
      anyCharTruncated = true;
      return truncateLine(line, maxLineChars);
    }
    return line;
  });

  const hiddenCount = lineHidden > 0 ? lineHidden : anyCharTruncated ? 1 : 0;
  return { visibleLines, hiddenCount, totalLines };
}

function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) {
    return line;
  }
  if (maxChars <= 1) {
    return '…';
  }
  return `${line.slice(0, maxChars - 1)}…`;
}

/** @deprecated 回复不再折叠；保留兼容旧测试名，等价于 thinking 折叠。 */
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

function formatTime(iso?: string): string | undefined {
  if (!iso) {
    return undefined;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}
