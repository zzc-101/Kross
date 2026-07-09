import { useEffect, useRef } from 'react';

import {
  subscribeWheel,
  type ScrollDirection
} from '../terminal/mouseTracking';
import { createScrollScheduler } from './scrollSchedule';

/**
 * 监听终端滚轮 / Mac 触摸板滑动。
 * 依赖 main/alternateScreen 已 installMouseInputFilter + enableMouseTracking。
 *
 * 触控板事件极密：在 hook 内用 rAF/setTimeout 合并为一帧一次 onScroll，
 * 避免每条 CSI 都触发 React setState + 全量视口重算。
 */
export function useMouseScroll(
  onScroll: (direction: ScrollDirection, steps: number) => void,
  enabled = true
): void {
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    // 合并后按「净位移」回调一次：up 与 down 在同一帧内抵消
    const scheduler = createScrollScheduler((delta) => {
      if (delta > 0) {
        onScrollRef.current('up', delta);
      } else if (delta < 0) {
        onScrollRef.current('down', -delta);
      }
    });

    const unsubscribe = subscribeWheel((event) => {
      // 约定：up = 看更早消息 = 正 delta（与 App.scrollBy 一致）
      const signed =
        event.direction === 'up' ? event.steps : -event.steps;
      scheduler.enqueue(signed);
    });

    return () => {
      unsubscribe();
      scheduler.cancel();
    };
  }, [enabled]);
}
