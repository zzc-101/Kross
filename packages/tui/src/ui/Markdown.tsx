import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

import {
  cachedParseMarkdown,
  type MdLine,
  type MdSpan
} from './markdownParse';
import { theme } from './theme';

/**
 * 将 Markdown 渲染为 Ink 终端片段。
 * agent 回复使用；streaming 时在最后一行追加光标。
 *
 * - 优先使用 `lines`（视口裁剪后的预渲染行，保留样式）
 * - 否则走模块级 cachedParseMarkdown，滚动 remount 不重 parse
 */
export function Markdown({
  source,
  lines: precomputed,
  rail = false,
  streaming = false,
  cursor
}: {
  source?: string;
  /** 已解析/裁剪的行；有值时跳过 source 解析 */
  lines?: MdLine[];
  /** 是否加消息左侧 rail */
  rail?: boolean;
  streaming?: boolean;
  cursor?: string;
}) {
  const lines = useMemo(() => {
    if (precomputed) {
      return precomputed;
    }
    return cachedParseMarkdown(source ?? '');
  }, [precomputed, source]);

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const isLast = index === lines.length - 1;
        return (
          <Box key={`md-${index}`}>
            {rail ? (
              <Text color={theme.brandMuted}>│ </Text>
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
    <Text>
      {line.spans.map((span, index) => (
        <Text key={index} {...spanToProps(span, line)}>
          {span.text}
        </Text>
      ))}
      {trailing}
    </Text>
  );
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
