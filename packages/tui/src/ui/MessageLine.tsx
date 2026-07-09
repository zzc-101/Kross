import React from 'react';
import { Box, Text } from 'ink';

import { symbols, theme } from './theme';
import { usePulse } from './usePulse';
import type { ChatMessage } from './MessageLine';

export type { ChatMessage };

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

  if (message.from === 'user') {
    const body = message.text.replace(/^\>\s*/, '');
    return (
      <Box marginBottom={1}>
        <Text dimColor>{symbols.userLabel}  </Text>
        <Text>{body}</Text>
      </Box>
    );
  }

  const lines = message.text.split('\n');
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.agent} bold>
        {symbols.agentLabel}
      </Text>
      {lines.map((line, index) => {
        const isLast = index === lines.length - 1;
        return (
          <Box key={`${message.id}-${index}`}>
            <Text color={theme.brandMuted}>{symbols.messageRail} </Text>
            <Text>
              {line}
              {streaming && isLast ? <Text color={theme.brand}>{cursor}</Text> : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
