import { useCallback, useEffect, useRef, useState } from 'react';

import { subscribePointer } from '../terminal/mouseTracking';
import {
  buildPaintLayout,
  resolveViewportContentRows,
  windowPaintLayout,
  type MessagePaintCache
} from '../ui/messagePaint';
import {
  copyPaintSelection,
  resolveViewportSelectionPoint,
  type ChatMessage,
  type TextSelectionPoint,
  type TextSelectionRange
} from '../ui';

interface SelectionGesture {
  anchor: TextSelectionPoint;
  head: TextSelectionPoint;
  dragged: boolean;
}

export interface UseMessageTextSelectionOptions {
  enabled: boolean;
  blocked: boolean;
  messages: ChatMessage[];
  columns: number;
  viewportRows: number;
  viewportTopRow: number;
  scrollOffset: number;
  streamingMessageId?: number;
  paintCache: MessagePaintCache;
  copyText: (text: string) => unknown;
}

export type ClipboardFeedback = 'copied' | 'failed';

export interface MessageTextSelectionState {
  selection?: TextSelectionRange;
  feedback?: ClipboardFeedback;
}

/** Claude/Grok-style in-app selection: drag, highlight, copy on mouse-up. */
export function useMessageTextSelection({
  enabled,
  blocked,
  messages,
  columns,
  viewportRows,
  viewportTopRow,
  scrollOffset,
  streamingMessageId,
  paintCache,
  copyText
}: UseMessageTextSelectionOptions): MessageTextSelectionState {
  const [selection, setSelection] = useState<TextSelectionRange>();
  const [feedback, setFeedback] = useState<ClipboardFeedback>();
  const gestureRef = useRef<SelectionGesture>();
  const clearTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const showFeedback = useCallback((next: ClipboardFeedback) => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setFeedback(next);
    feedbackTimerRef.current = setTimeout(() => setFeedback(undefined), 2_000);
  }, []);

  useEffect(() => {
    if (!enabled || blocked) {
      gestureRef.current = undefined;
      setSelection(undefined);
      return;
    }

    const snapshot = () => {
      const { contentRows } = resolveViewportContentRows({
        messages,
        columns,
        viewportRows,
        scrollOffset,
        streamingMessageId,
        paintCache
      });
      const layout = buildPaintLayout({
        messages,
        columns,
        streamingMessageId,
        paintCache
      });
      const window = windowPaintLayout({
        layout,
        viewportRows: contentRows,
        scrollOffset
      });
      return { contentRows, layout, window };
    };

    return subscribePointer((event) => {
      const current = snapshot();
      const point = resolveViewportSelectionPoint({
        window: current.window,
        contentRows: current.contentRows,
        viewportTopRow,
        // AppShell uses paddingX=1, so terminal column 2 is paint column 0.
        contentLeftCol: 2,
        terminalRow: event.row,
        terminalCol: event.col,
        clamp: event.phase !== 'down'
      });

      if (event.phase === 'down') {
        if (clearTimerRef.current) {
          clearTimeout(clearTimerRef.current);
        }
        gestureRef.current = point
          ? { anchor: point, head: point, dragged: false }
          : undefined;
        setSelection(undefined);
        return;
      }

      const gesture = gestureRef.current;
      if (!gesture || !point) {
        return;
      }
      if (event.phase === 'drag') {
        gesture.head = point;
        gesture.dragged =
          gesture.dragged ||
          point.row !== gesture.anchor.row ||
          point.col !== gesture.anchor.col;
        if (gesture.dragged) {
          setSelection({ anchor: gesture.anchor, head: point });
        }
        return;
      }

      gestureRef.current = undefined;
      if (!gesture.dragged) {
        setSelection(undefined);
        return;
      }
      const finished = { anchor: gesture.anchor, head: point };
      const items = current.layout.entries.map((entry) => entry.item);
      const text = copyPaintSelection(items, finished);
      if (text.length > 0) {
        try {
          const result = copyText(text);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            Promise.resolve(result).then(
              () => showFeedback('copied'),
              () => showFeedback('failed')
            );
          } else {
            showFeedback('copied');
          }
        } catch {
          showFeedback('failed');
        }
      }
      setSelection(finished);
      clearTimerRef.current = setTimeout(() => setSelection(undefined), 1_500);
    });
  }, [
    blocked,
    columns,
    copyText,
    enabled,
    messages,
    paintCache,
    scrollOffset,
    showFeedback,
    streamingMessageId,
    viewportRows,
    viewportTopRow
  ]);

  useEffect(
    () => () => {
      if (clearTimerRef.current) {
        clearTimeout(clearTimerRef.current);
      }
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
      }
    },
    []
  );

  return { selection, feedback };
}
