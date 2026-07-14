import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import { symbols, theme } from './theme';
import { usePulse } from './usePulse';

const thinkingPhases = [
  '读取工作区',
  '规划下一步',
  '等待模型',
  '整理回复'
] as const;

const toolPhases = [
  '运行已允许的工具',
  '收集工具输出',
  '将结果交给模型',
  '等待模型'
] as const;

export function ThinkingIndicator({
  active,
  variant = 'thinking'
}: {
  active: boolean;
  variant?: 'thinking' | 'tool';
}) {
  const frame = usePulse(symbols.busyFrames, 80, active);
  const phases = variant === 'tool' ? toolPhases : thinkingPhases;
  const [phaseIndex, setPhaseIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setPhaseIndex(0);
      return;
    }

    const timer = setInterval(() => {
      setPhaseIndex((current) => (current + 1) % phases.length);
    }, 1600);

    return () => clearInterval(timer);
  }, [active, phases.length]);

  if (!active) {
    return null;
  }

  const label = variant === 'tool' ? '正在执行' : '思考中';

  return (
    <Box marginBottom={1}>
      <Text color={theme.brandMuted}>{symbols.messageRail} </Text>
      <Text color={theme.statusBusy}>
        {frame} {label}
      </Text>
      <Text dimColor> · {phases[phaseIndex]}</Text>
    </Box>
  );
}
