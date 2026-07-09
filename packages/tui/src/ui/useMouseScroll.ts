import { useEffect, useRef } from 'react';
import { useStdin } from 'ink';

import {
  parseMouseWheelChunk,
  type ScrollDirection
} from '../terminal/mouseTracking';

/**
 * 监听终端滚轮 / Mac 触摸板滑动（依赖 mouse tracking 已开启）。
 * onScroll(direction): up = 查看更早消息，down = 靠近底部。
 */
export function useMouseScroll(
  onScroll: (direction: ScrollDirection, steps: number) => void,
  enabled = true
): void {
  const { stdin } = useStdin();
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;

  useEffect(() => {
    if (!enabled || !stdin) {
      return;
    }

    const handleData = (data: Buffer | string): void => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      if (!text.includes('\x1b[')) {
        return;
      }
      const { events } = parseMouseWheelChunk(text);
      for (const event of events) {
        onScrollRef.current(event.direction, event.steps);
      }
    };

    // 与 Ink 并行监听；滚轮 CSI 一般不会变成可打印字符进输入框
    stdin.on('data', handleData);
    return () => {
      stdin.off('data', handleData);
    };
  }, [stdin, enabled]);
}
