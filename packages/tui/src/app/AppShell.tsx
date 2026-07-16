import type { ReactNode } from 'react';
import React from 'react';
import { Box } from 'ink';

export function resolveShellRows(rows: number): number {
  return Math.max(1, Math.floor(rows));
}

export function resolveContentWidth(
  columns: number,
  shellMode: boolean
): number {
  const horizontalPadding = shellMode ? 2 : 4;
  return Math.max(12, Math.floor(columns) - horizontalPadding);
}

export function resolveSlashSuggestionLimit(
  rows: number,
  shellMode: boolean
): number {
  if (!shellMode) return 8;
  if (rows < 14) return 1;
  if (rows < 20) return 2;
  if (rows < 30) return 4;
  return 8;
}

export function resolveMessageViewportHeight(input: {
  rows: number;
  headerHeight: number;
  footerHeight: number;
}): number {
  return Math.max(
    1,
    resolveShellRows(input.rows) -
      input.headerHeight -
      input.footerHeight -
      1
  );
}

export function AppShell({
  shellMode,
  columns,
  rows,
  contentWidth,
  isHome,
  header,
  homeBody,
  chatBody,
  footer
}: {
  shellMode: boolean;
  columns: number;
  rows: number;
  contentWidth: number;
  isHome: boolean;
  header: ReactNode;
  homeBody: ReactNode;
  chatBody: ReactNode;
  footer: ReactNode;
}) {
  if (shellMode) {
    return (
      <Box
        flexDirection="column"
        width={columns}
        height={resolveShellRows(rows)}
        paddingX={1}
      >
        {header}
        <Box
          flexGrow={1}
          flexShrink={1}
          flexDirection="column"
          overflowY="hidden"
          justifyContent={isHome ? 'center' : 'flex-end'}
          alignItems={isHome ? 'center' : 'stretch'}
          minHeight={1}
        >
          {isHome ? homeBody : chatBody}
        </Box>
        {footer}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} width={contentWidth}>
      {header}
      {isHome ? homeBody : chatBody}
      {footer}
    </Box>
  );
}
