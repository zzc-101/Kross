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
  const boxWidth = Math.max(12, Math.min(width ?? 56, 72));
  const innerWidth = boxWidth - 4;
  const hRule = symbols.boxHorizontal.repeat(boxWidth - 2);
  const selectedModel = state.models[state.modelIndex];
  const modelWindow = resolveModelWindow(
    state.models.length,
    state.modelIndex,
    7
  );

  const Row = ({ children }: { children: React.ReactNode }) => (
    <Box>
      <Text color={theme.border}>{symbols.boxVertical} </Text>
      <Box flexGrow={1} flexShrink={1} overflowX="hidden" width={innerWidth}>
        {children}
      </Box>
      <Text color={theme.border}> {symbols.boxVertical}</Text>
    </Box>
  );

  if (state.quickSetup) {
    const setup = state.quickSetup;
    const stepIndex =
      [
        'profileName',
        'protocol',
        'baseUrl',
        'apiKey',
        'model',
        'contextWindow',
        'review'
      ].indexOf(setup.step) + 1;
    return (
      <Box flexDirection="column" marginBottom={0} width={boxWidth} flexShrink={0}>
        <Text color={theme.brandSoft}>
          {symbols.boxTopLeft}
          {hRule}
          {symbols.boxTopRight}
        </Text>
        <Row>
          <Text color={theme.brandSoft} bold>
            {t('settings.quick.title')}
          </Text>
          <Text dimColor>
            {' '}
            · {stepIndex}/7
          </Text>
        </Row>
        <Row>
          <Text dimColor>
            {symbols.boxHorizontal.repeat(Math.min(innerWidth, 40))}
          </Text>
        </Row>
        <QuickSetupBody state={setup} innerWidth={innerWidth} />
        {setup.error ? (
          <Row>
            <Text color={theme.statusError}>{setup.error}</Text>
          </Row>
        ) : null}
        <Text color={theme.border}>
          {symbols.boxBottomLeft}
          {hRule}
          {symbols.boxBottomRight}
        </Text>
        <Text dimColor>{t('settings.quick.hotkeys')}</Text>
      </Box>
    );
  }

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
        <Text dimColor>{symbols.boxHorizontal.repeat(Math.min(innerWidth, 40))}</Text>
      </Row>

      <Row>
        <SectionTab title={t('settings.model')} active={state.section === 'model'} />
      </Row>

      {modelWindow.start > 0 ? (
        <Row>
          <Text dimColor>
            {t('settings.moreAbove', { count: modelWindow.start })}
          </Text>
        </Row>
      ) : null}

      {state.models
        .slice(modelWindow.start, modelWindow.end)
        .map((item, visibleIndex) => {
          const index = modelWindow.start + visibleIndex;
          return (
            <Row key={item.id}>
              <OptionLine
                selected={index === state.modelIndex && item.configured}
                focused={state.section === 'model' && index === state.modelIndex}
                label={item.label}
                dimmed={!item.configured}
                badge={item.current ? t('settings.current') : undefined}
              />
            </Row>
          );
        })}

      {modelWindow.end < state.models.length ? (
        <Row>
          <Text dimColor>
            {t('settings.moreBelow', {
              count: state.models.length - modelWindow.end
            })}
          </Text>
        </Row>
      ) : null}

      {state.models.length === 0 ? (
        <Row>
          <Text dimColor>{t('settings.noModels')}</Text>
        </Row>
      ) : null}

      {selectedModel?.notice ? (
        <Row>
          <Text dimColor>
            {t('settings.notice', { notice: selectedModel.notice })}
          </Text>
        </Row>
      ) : null}

      <Row>
        <Text color={theme.selection} bold>
          {t('settings.quick.entry')}
        </Text>
      </Row>

      {state.capabilitiesLabel ? (
        <Row>
          <Text dimColor>{state.capabilitiesLabel}</Text>
        </Row>
      ) : null}

      <Row>
        <Text dimColor>{symbols.boxHorizontal.repeat(Math.min(innerWidth, 40))}</Text>
      </Row>

      <Row>
        <SectionTab
          title={t('settings.effort')}
          active={state.section === 'effort'}
        />
      </Row>

      {state.efforts.map((item, index) => (
        <Row key={item.id}>
          <OptionLine
            selected={index === state.effortIndex}
            focused={state.section === 'effort' && index === state.effortIndex}
            label={item.label}
          />
        </Row>
      ))}

      <Text color={theme.border}>
        {symbols.boxBottomLeft}
        {hRule}
        {symbols.boxBottomRight}
      </Text>
      <Text dimColor>{t('settings.hotkeys')}</Text>
    </Box>
  );
}

function QuickSetupBody({
  state,
  innerWidth
}: {
  state: NonNullable<ModelSettingsState['quickSetup']>;
  innerWidth: number;
}) {
  if (state.step === 'protocol') {
    return (
      <>
        <WizardLabel innerWidth={innerWidth}>{t('settings.quick.protocol')}</WizardLabel>
        <WizardRow innerWidth={innerWidth}>
          <Text
            color={state.protocol === 'openai' ? theme.selection : undefined}
            bold={state.protocol === 'openai'}
          >
            {state.protocol === 'openai' ? `${symbols.approvePointer} ` : '  '}
            OpenAI Compatible
          </Text>
        </WizardRow>
        <WizardRow innerWidth={innerWidth}>
          <Text
            color={state.protocol === 'anthropic' ? theme.selection : undefined}
            bold={state.protocol === 'anthropic'}
          >
            {state.protocol === 'anthropic' ? `${symbols.approvePointer} ` : '  '}
            Anthropic Compatible
          </Text>
        </WizardRow>
      </>
    );
  }

  if (state.step === 'review') {
    return (
      <>
        <WizardLabel innerWidth={innerWidth}>{t('settings.quick.review')}</WizardLabel>
        <WizardValue
          innerWidth={innerWidth}
          label={t('settings.quick.profileName')}
          value={state.profileName}
        />
        <WizardValue
          innerWidth={innerWidth}
          label={t('settings.quick.protocol')}
          value={state.protocol}
        />
        <WizardValue innerWidth={innerWidth} label="Base URL" value={state.baseUrl} />
        <WizardValue
          innerWidth={innerWidth}
          label="API Key"
          value={state.apiKey ? maskSecret(state.apiKey) : t('settings.quick.reuseKey')}
        />
        <WizardValue
          innerWidth={innerWidth}
          label={t('settings.quick.modelId')}
          value={state.model}
        />
        <WizardValue
          innerWidth={innerWidth}
          label={t('settings.quick.contextWindow')}
          value={state.contextWindow}
        />
      </>
    );
  }

  const field = wizardField(state);
  return (
    <>
      <WizardLabel innerWidth={innerWidth}>{field.label}</WizardLabel>
      <WizardRow innerWidth={innerWidth}>
        <Text color={theme.selection}>
          {field.value || t('settings.quick.empty')}
          <Text inverse> </Text>
        </Text>
      </WizardRow>
      {field.hint ? (
        <WizardRow innerWidth={innerWidth}>
          <Text dimColor>{field.hint}</Text>
        </WizardRow>
      ) : null}
    </>
  );
}

function wizardField(
  state: NonNullable<ModelSettingsState['quickSetup']>
): { label: string; value: string; hint?: string } {
  switch (state.step) {
    case 'profileName':
      return {
        label: t('settings.quick.profileName'),
        value: state.profileName,
        hint: t('settings.quick.profileNameHint')
      };
    case 'baseUrl':
      return { label: 'Base URL', value: state.baseUrl };
    case 'apiKey':
      return {
        label: 'API Key',
        value: maskSecret(state.apiKey),
        hint: t('settings.quick.apiKeyHint')
      };
    case 'model':
      return { label: t('settings.quick.modelId'), value: state.model };
    case 'contextWindow':
      return {
        label: t('settings.quick.contextWindow'),
        value: state.contextWindow,
        hint: t('settings.quick.contextHint')
      };
    default:
      return { label: '', value: '' };
  }
}

function maskSecret(value: string): string {
  return value.length === 0 ? '' : '•'.repeat(Math.min(16, value.length));
}

function WizardRow({
  children,
  innerWidth
}: {
  children: React.ReactNode;
  innerWidth: number;
}) {
  return (
    <PanelRow innerWidth={innerWidth}>
      <Box paddingLeft={2}>{children}</Box>
    </PanelRow>
  );
}

function WizardLabel({
  children,
  innerWidth
}: {
  children: React.ReactNode;
  innerWidth: number;
}) {
  return (
    <PanelRow innerWidth={innerWidth}>
      <Box paddingLeft={2} marginBottom={1}>
        <Text bold>{children}</Text>
      </Box>
    </PanelRow>
  );
}

function WizardValue({
  label,
  value,
  innerWidth
}: {
  label: string;
  value: string;
  innerWidth: number;
}) {
  return (
    <WizardRow innerWidth={innerWidth}>
      <Text dimColor>{label}: </Text>
      <Text>{value}</Text>
    </WizardRow>
  );
}

function PanelRow({
  children,
  innerWidth
}: {
  children: React.ReactNode;
  innerWidth: number;
}) {
  return (
    <Box>
      <Text color={theme.border}>{symbols.boxVertical} </Text>
      <Box flexGrow={1} flexShrink={1} overflowX="hidden" width={innerWidth}>
        {children}
      </Box>
      <Text color={theme.border}> {symbols.boxVertical}</Text>
    </Box>
  );
}

export function resolveModelWindow(
  total: number,
  selected: number,
  limit: number
): { start: number; end: number } {
  const size = Math.max(1, Math.floor(limit));
  if (total <= size) {
    return { start: 0, end: total };
  }
  const half = Math.floor(size / 2);
  const start = Math.max(0, Math.min(selected - half, total - size));
  return { start, end: Math.min(total, start + size) };
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
  focused,
  label,
  dimmed = false,
  badge
}: {
  selected: boolean;
  focused: boolean;
  label: string;
  dimmed?: boolean;
  badge?: string;
}) {
  const pointer = focused
    ? `${symbols.approvePointer} `
    : selected
      ? '• '
      : '  ';
  return (
    <Box>
      <Text
        color={focused ? theme.selection : undefined}
        bold={focused}
        dimColor={dimmed && !focused}
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
