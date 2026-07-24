import type { UiMessage } from './useCloud';

export interface DisplayMessage {
  message: UiMessage;
  thinking?: string;
}

export function groupMessagesForDisplay(
  messages: UiMessage[]
): DisplayMessage[] {
  const grouped: DisplayMessage[] = [];
  const pendingThinking: UiMessage[] = [];

  for (const message of messages) {
    if (message.from === 'thinking') {
      pendingThinking.push(message);
      continue;
    }

    if (pendingThinking.length > 0 && message.from !== 'user') {
      grouped.push({
        message,
        thinking: pendingThinking.map((item) => item.text).join('\n\n')
      });
      pendingThinking.length = 0;
      continue;
    }

    grouped.push(...pendingThinking.map((item) => ({ message: item })));
    pendingThinking.length = 0;
    grouped.push({ message });
  }

  grouped.push(...pendingThinking.map((message) => ({ message })));
  return grouped;
}
