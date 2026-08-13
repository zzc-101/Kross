import { useCallback, useRef, useState } from 'react';

export interface ScrollBounds {
  maxScrollOffset: number;
  totalRows: number;
}

export function clampScrollOffset(value: number, max: number): number {
  return Math.min(Math.max(0, value), Math.max(0, max));
}

export function useViewportScroll(): {
  scrollOffset: number;
  scrollBy: (delta: number) => void;
  resetToBottom: () => void;
  handleScrollBounds: (bounds: ScrollBounds) => void;
} {
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxScrollOffsetRef = useRef(0);

  const scrollBy = useCallback((delta: number) => {
    if (delta === 0) {
      return;
    }
    setScrollOffset((current) =>
      clampScrollOffset(current + delta, maxScrollOffsetRef.current)
    );
  }, []);

  const resetToBottom = useCallback(() => {
    setScrollOffset(0);
  }, []);

  const handleScrollBounds = useCallback((bounds: ScrollBounds) => {
    maxScrollOffsetRef.current = Math.max(0, bounds.maxScrollOffset);
    setScrollOffset((current) =>
      clampScrollOffset(current, maxScrollOffsetRef.current)
    );
  }, []);

  return {
    scrollOffset,
    scrollBy,
    resetToBottom,
    handleScrollBounds
  };
}
