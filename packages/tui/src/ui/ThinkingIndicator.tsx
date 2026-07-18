import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { t, type RunPhase } from '@kross/core';

import { symbols, theme } from './theme';
import { usePulse } from './usePulse';

export function ThinkingIndicator({
  active,
  variant = 'thinking',
  phase
}: {
  active: boolean;
  variant?: 'thinking' | 'tool' | 'cancelling';
  phase?: RunPhase;
}) {
  // 200ms 足够动画；过密脉冲会在 await LLM 时触发 Ink 全屏 diff，打满事件循环导致 Esc 失灵
  const frame = usePulse(symbols.busyFrames, 200, active);
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
    if (phase && variant !== 'cancelling') {
      return;
    }
    const timer = setInterval(() => {
      setPhaseIndex((current) => (current + 1) % phases.length);
    }, 2400);

    return () => clearInterval(timer);
  }, [active, phase, phases, variant]);

  useEffect(() => {
    setStartedAt(active ? Date.now() : undefined);
  }, [active]);

  if (!active) {
    return null;
  }

  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    : 0;
  const phaseLabel =
    variant !== 'cancelling' && phase
      ? t(`run.phase.${phase}`)
      : phases[phaseIndex] ?? phases[0] ?? '';

  return (
    <Box marginBottom={1}>
      <Text color={theme.statusBusy}>{frame} </Text>
      <Text color={theme.brandSoft} bold>
        {phaseLabel}…
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
