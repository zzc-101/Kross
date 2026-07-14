import React from 'react';
import { Box, Text } from 'ink';
import { t } from '@kross/core';

import { symbols, theme } from './theme';
import type { ModelSettingsState } from './modelSettings';

export function ModelSettingsPanel({
  state,
  width
}: {
  state: ModelSettingsState;
  width?: number;
}) {
  const boxWidth = Math.max(36, Math.min(width ?? 56, 72));
  const innerWidth = boxWidth - 4;
  const hRule = symbols.boxHorizontal.repeat(boxWidth - 2);

  const Row = ({ children }: { children: React.ReactNode }) => (
    <Box>
      <Text color={theme.border}>{symbols.boxVertical} </Text>
      <Box flexGrow={1} flexShrink={1} overflowX="hidden" width={innerWidth}>
        {children}
      </Box>
      <Text color={theme.border}> {symbols.boxVertical}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column" marginBottom={0} width={boxWidth} flexShrink={0}>
      <Text color={theme.brandSoft}>
        {symbols.boxTopLeft}
        {hRule}
        {symbols.boxTopRight}
      </Text>

      <Row>
        <Text color={theme.brandSoft} bold>
          {t('settings.title')}
        </Text>
      </Row>

      <Row>
        <SectionTab
          title={t('settings.effort')}
          active={state.section === 'effort'}
        />
        <Text dimColor>  </Text>
        <SectionTab title={t('settings.model')} active={state.section === 'model'} />
      </Row>

      <Row>
        <Text dimColor>{symbols.boxHorizontal.repeat(Math.min(innerWidth, 40))}</Text>
      </Row>

      {state.section === 'effort'
        ? state.efforts.map((item, index) => (
            <Row key={item.id}>
              <OptionLine
                selected={index === state.effortIndex}
                label={item.label}
              />
            </Row>
          ))
        : state.models.map((item, index) => (
            <Row key={item.id}>
              <OptionLine
                selected={index === state.modelIndex && item.configured}
                label={item.label}
                dimmed={!item.configured}
                badge={item.current ? 'current' : undefined}
              />
            </Row>
          ))}

      {state.section === 'model' && state.models.length === 0 ? (
        <Row>
          <Text dimColor>{t('settings.noModels')}</Text>
        </Row>
      ) : null}

      <Text color={theme.border}>
        {symbols.boxBottomLeft}
        {hRule}
        {symbols.boxBottomRight}
      </Text>
      <Text dimColor>{t('settings.hotkeys')}</Text>
    </Box>
  );
}

function SectionTab({
  title,
  active
}: {
  title: string;
  active: boolean;
}) {
  return (
    <Text
      bold={active}
      color={active ? theme.selection : undefined}
      dimColor={!active}
    >
      {active ? `[${title}]` : ` ${title} `}
    </Text>
  );
}

function OptionLine({
  selected,
  label,
  dimmed = false,
  badge
}: {
  selected: boolean;
  label: string;
  dimmed?: boolean;
  badge?: string;
}) {
  const pointer = selected ? `${symbols.approvePointer} ` : '  ';
  return (
    <Box>
      <Text
        color={selected ? theme.selection : undefined}
        bold={selected}
        dimColor={dimmed && !selected}
      >
        {pointer}
        {label}
      </Text>
      {badge ? (
        <Text dimColor>
          {' '}
          · {badge}
        </Text>
      ) : null}
    </Box>
  );
}
