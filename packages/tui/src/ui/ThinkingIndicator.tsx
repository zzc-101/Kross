import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import { symbols, theme } from './theme';
import { usePulse } from './usePulse';

const thinkingPhases = [
  'reading workspace',
  'planning next step',
  'waiting for model',
  'preparing reply'
] as const;

const toolPhases = [
  'running approved tool',
  'collecting tool output',
  'feeding results to model',
  'waiting for model'
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

  const label = variant === 'tool' ? 'working' : 'thinking';

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
