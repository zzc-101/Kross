import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';

import { Markdown } from './Markdown';
import type { MdLine } from './markdownParse';
import { displayWidth } from './markdownParse';
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
  /** 关联 tool 事件，from === 'tool' 时使用 */
  tool?: ToolCallState;
  /**
   * thinking / tool 组默认折叠；true 时展开明细。
   * 正式 agent 回复不再折叠。
   */
  expanded?: boolean;
  /**
   * 视口裁剪后的预渲染 MD 行（表格已展开为 box，span 样式保留）。
   * 有值时直接渲染，不再二次 parse，且滚动时不丢 bold/code 等格式。
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
  const time = formatTime(message.createdAt);

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
        text={message.text}
        expanded={message.expanded === true}
        streaming={streaming}
        time={time}
      />
    );
  }

  if (message.from === 'system') {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text dimColor wrap="wrap">
          {symbols.systemPrefix} {message.text}
        </Text>
        {time ? <Text dimColor>  {time}</Text> : null}
      </Box>
    );
  }

  if (message.from === 'user') {
    const body = message.text.replace(/^\>\s*/, '');
    return (
      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text dimColor>{symbols.userLabel}  </Text>
          <Text color={theme.user} wrap="wrap">
            {body}
          </Text>
          {time ? <Text dimColor>  {time}</Text> : null}
        </Box>
      </Box>
    );
  }

  // agent 回复：完整 source 走 Markdown；视口裁剪走 viewportLines（保留样式）
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={0}>
        <Text color={theme.agent} bold>
          {symbols.agentLabel}
        </Text>
        {time ? <Text dimColor>  {time}</Text> : null}
      </Box>
      <Markdown
        source={message.viewportLines ? undefined : message.text}
        lines={message.viewportLines}
        rail
        streaming={streaming}
        cursor={cursor}
      />
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
  const { stdout } = useStdout();
  const columns = Math.max(20, (stdout?.columns ?? 80) - 4);
  const bodyWidth = Math.max(1, columns - 2);
  const { visibleLines, hiddenCount, totalLines } = collapseThinking(
    text,
    expanded || streaming
  );
  // 逻辑行再按列宽硬折，避免 Ink wrap 续行丢 rail
  const displayLines = useMemo(
    () =>
      visibleLines.flatMap((line) => wrapPlainText(line, bodyWidth)),
    [visibleLines, bodyWidth]
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
      {displayLines.map((line, index) => (
        <Box key={`thinking-${index}`}>
          <Text dimColor>{symbols.messageRail} </Text>
          <Text dimColor wrap="truncate">
            {line}
          </Text>
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
    }
    if (end === 0) {
      end = [...rest][0]?.length ?? 1;
    }
    lines.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return lines.length > 0 ? lines : [''];
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
