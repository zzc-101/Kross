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
  variant?: 'thinking' | 'tool' | 'cancelling';
}) {
  const frame = usePulse(symbols.busyFrames, 80, active);
  const [startedAt, setStartedAt] = useState<number>();
  const phases = useMemo(
    () =>
      variant === 'cancelling'
        ? [t('thinking.phase.cancelling')]
        : variant === 'tool'
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

    setPhaseIndex(0);
    const timer = setInterval(() => {
      setPhaseIndex((current) => (current + 1) % phases.length);
    }, 2400);

    return () => clearInterval(timer);
  }, [active, phases]);

  useEffect(() => {
    setStartedAt(active ? Date.now() : undefined);
  }, [active]);

  if (!active) {
    return null;
  }

  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    : 0;
  const phase = phases[phaseIndex] ?? phases[0] ?? '';

  return (
    <Box marginBottom={1}>
      <Text color={theme.statusBusy}>{frame} </Text>
      <Text color={theme.brandSoft} bold>
        {phase}…
      </Text>
      <Text dimColor>
        {' '}({t('thinking.elapsed', { seconds: elapsedSeconds })})
      </Text>
      {variant !== 'cancelling' ? (
        <Text dimColor> · {t('thinking.interruptHint')}</Text>
      ) : null}
    </Box>
  );
}
