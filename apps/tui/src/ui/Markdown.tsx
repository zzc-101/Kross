import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';

import {
  cachedParseMarkdown,
  displayWidth,
  trimTrailingBlankMdLines,
  type MdLine,
  type MdSpan
} from './markdownParse';
import { theme } from './theme';

/**
 * 将 Markdown 渲染为 Ink 终端片段。
 * - 模块级 cachedParseMarkdown，滚动 remount 不重 parse
 * - 长行按列宽硬折；可选 bullet 前缀（Claude Code ●）
 * - 去掉文末 blank，避免与 marginBottom 叠成大块留白
 */
export function Markdown({
  source,
  bullet,
  bulletColor,
  streaming = false,
  cursor
}: {
  source?: string;
  /** Claude Code 风格：首行前缀小圆点，续行缩进 */
  bullet?: string;
  bulletColor?: string;
  streaming?: boolean;
  cursor?: string;
}) {
  const { stdout } = useStdout();
  const columns = Math.max(20, (stdout?.columns ?? 80) - 4);
  const prefixWidth = bullet ? displayWidth(`${bullet} `) : 0;
  const bodyWidth = Math.max(1, columns - prefixWidth);

  const lines = useMemo(
    () => trimTrailingBlankMdLines(cachedParseMarkdown(source ?? '')),
    [source]
  );

  const displayLines = useMemo(
    () => softWrapMdLines(lines, bodyWidth),
    [lines, bodyWidth]
  );

  return (
    <Box flexDirection="column">
      {displayLines.map((line, index) => {
        const isLast = index === displayLines.length - 1;
        const isFirst = index === 0;
        return (
          <Box key={`md-${index}`}>
            {bullet ? (
              <Text color={bulletColor ?? theme.agent}>
                {isFirst ? `${bullet} ` : ' '.repeat(prefixWidth)}
              </Text>
            ) : null}
            <MarkdownLineView
              line={line}
              trailing={
                streaming && isLast && cursor ? (
                  <Text color={theme.brand}>{cursor}</Text>
                ) : null
              }
            />
          </Box>
        );
      })}
    </Box>
  );
}

export function MarkdownLineView({
  line,
  trailing
}: {
  line: MdLine;
  trailing?: React.ReactNode;
}) {
  if (line.kind === 'blank') {
    return <Text> </Text>;
  }

  return (
    <Text wrap="truncate">
      {line.spans.map((span, index) => (
        <Text key={index} {...spanToProps(span, line)}>
          {span.text}
        </Text>
      ))}
      {trailing}
    </Text>
  );
}

/** Split MdLines so each fits bodyWidth (display columns). */
function softWrapMdLines(lines: MdLine[], bodyWidth: number): MdLine[] {
  const width = Math.max(1, bodyWidth);
  const out: MdLine[] = [];
  for (const line of lines) {
    if (line.kind === 'blank') {
      out.push(line);
      continue;
    }
    const plain = line.spans.map((s) => s.text).join('');
    if (displayWidth(plain) <= width) {
      out.push(line);
      continue;
    }
    // Re-chunk spans by display width
    let used = 0;
    let chunk: MdSpan[] = [];
    const flush = () => {
      out.push({
        ...line,
        spans: chunk.length > 0 ? chunk : [{ text: ' ' }]
      });
      chunk = [];
      used = 0;
    };
    for (const span of line.spans) {
      let rest = span.text;
      while (rest.length > 0) {
        const room = width - used;
        if (room <= 0) {
          flush();
          continue;
        }
        let takeW = 0;
        let end = 0;
        let lastBreak = 0;
        for (const ch of rest) {
          const w = displayWidth(ch);
          if (takeW + w > room) {
            break;
          }
          takeW += w;
          end += ch.length;
          if (ch === ' ' || ch === '\t') {
            lastBreak = end;
          }
        }
        if (end === 0) {
          if (used > 0) {
            flush();
            continue;
          }
          // 极窄终端下单个字符可能比整行还宽；强制消费以避免死循环。
          end = [...rest][0]?.length ?? 1;
        } else if (end < rest.length && lastBreak > 0 && lastBreak < end) {
          end = lastBreak;
        }
        chunk.push({ ...span, text: rest.slice(0, end) });
        used += displayWidth(rest.slice(0, end));
        rest = rest.slice(end);
        if (rest.length > 0) {
          flush();
        }
      }
    }
    if (chunk.length > 0) {
      flush();
    }
  }
  return out.length > 0 ? out : lines;
}

function spanToProps(
  span: MdSpan,
  line: MdLine
): {
  bold?: boolean;
  italic?: boolean;
  dimColor?: boolean;
  color?: string;
  inverse?: boolean;
} {
  const headingColor =
    line.kind === 'heading'
      ? line.level === 1
        ? theme.brand
        : line.level === 2
          ? theme.brandSoft
          : undefined
      : undefined;

  return {
    bold: span.bold || line.kind === 'heading',
    italic: span.italic,
    dimColor: span.dim,
    color: span.color ?? headingColor,
    inverse: span.inverse
  };
}
