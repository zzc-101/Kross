import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { t } from '@kross/core';

import { symbols, theme } from './theme';
import { usePulse } from './usePulse';

export function ThinkingIndicator({
  active,
  variant = 'thinking'
}: {
  active: boolean;
  variant?: 'thinking' | 'tool';
}) {
  const frame = usePulse(symbols.busyFrames, 80, active);
  const phases = useMemo(
    () =>
      variant === 'tool'
        ? [
            t('thinking.phase.runTool'),
            t('thinking.phase.collect'),
            t('thinking.phase.handOff'),
            t('thinking.phase.waitModel')
          ]
        : [
            t('thinking.phase.read'),
            t('thinking.phase.plan'),
            t('thinking.phase.waitModel'),
            t('thinking.phase.compose')
          ],
    [variant]
  );
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

  const label =
    variant === 'tool' ? t('thinking.toolLabel') : t('thinking.label');

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
