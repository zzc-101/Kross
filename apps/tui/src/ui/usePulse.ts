import { useEffect, useState } from 'react';

/**
 * 按固定间隔轮转帧，用于 spinner / 状态点 / 光标闪烁。
 * 未激活时停在第 0 帧，避免后台定时器空转。
 */
export function usePulse(frames: readonly string[], intervalMs: number, active = true): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active || frames.length <= 1) {
      setIndex(0);
      return;
    }

    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % frames.length);
    }, intervalMs);

    return () => clearInterval(timer);
  }, [active, frames, intervalMs]);

  return frames[index] ?? frames[0] ?? '';
}
