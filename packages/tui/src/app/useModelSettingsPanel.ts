import { useCallback, useState } from 'react';

import {
  getLlmProviderDefinition,
  loadKrossConfig,
  updateKrossLlmConfig,
  updateKrossPublicModelConfig,
  type AgentRuntime
} from '@kross/core';

import {
  advanceQuickModelSetup,
  applyQuickModelSetup,
  applyModelSettings,
  createQuickModelSetupState,
  createModelSettingsState,
  moveSettingsSelection,
  moveQuickModelProtocol,
  retreatQuickModelSetup,
  switchSettingsSection,
  updateQuickModelField,
  type ModelSettingsState
} from '../ui';

export interface UseModelSettingsPanelOptions {
  agentRuntime: AgentRuntime;
  append: (from: 'system', text: string) => number;
  pendingToolApproval: unknown;
}

export function useModelSettingsPanel({
  agentRuntime,
  append,
  pendingToolApproval
}: UseModelSettingsPanelOptions) {
  const [modelSettings, setModelSettings] = useState<ModelSettingsState | undefined>();
  const modelSettingsOpen = modelSettings !== undefined;

  const openModelSettings = useCallback(() => {
    setModelSettings(
      createModelSettingsState(agentRuntime, process.env, loadKrossConfig()?.llm)
    );
  }, [agentRuntime]);

  const openQuickModelSetup = useCallback(() => {
    const saved = loadKrossConfig()?.llm;
    setModelSettings({
      ...createModelSettingsState(agentRuntime, process.env, saved),
      quickSetup: createQuickModelSetupState(agentRuntime, saved)
    });
  }, [agentRuntime]);

  const closeModelSettings = useCallback(() => {
    setModelSettings(undefined);
  }, []);

  const confirmModelSettings = useCallback(() => {
    if (!modelSettings) {
      return;
    }
    const result = applyModelSettings(
      agentRuntime,
      modelSettings,
      process.env,
      loadKrossConfig()?.llm
    );
    if (!result.ok) {
      append('system', result.message);
      return;
    }

    const client = agentRuntime.getLlmClient();
    if (client?.model) {
      try {
        if (result.publicModelId) {
          updateKrossPublicModelConfig(
            result.publicModelId,
            agentRuntime.getThinkingEffort()
          );
          append('system', result.summary);
          setModelSettings(undefined);
          return;
        }
        const def = getLlmProviderDefinition(client.provider);
        const env = process.env;
        const apiKey = def.apiKeyEnv
          .map((key) => env[key]?.trim())
          .find(Boolean);
        const authToken = def.authTokenEnv
          ?.map((key) => env[key]?.trim())
          .find(Boolean);
        const baseUrl = def.baseUrlEnv
          ? env[def.baseUrlEnv]?.trim()
          : undefined;
        updateKrossLlmConfig({
          provider: client.provider,
          model: client.model,
          ...(apiKey ? { apiKey } : {}),
          ...(client.provider === 'anthropic' && authToken
            ? { authToken }
            : {}),
          ...(baseUrl ? { baseUrl } : {}),
          thinkingEffort: agentRuntime.getThinkingEffort()
        });
      } catch {
        // best-effort — refuse-to-wipe is intentional
      }
    }

    append('system', result.summary);
    setModelSettings(undefined);
  }, [agentRuntime, append, modelSettings]);

  const confirmQuickSetup = useCallback(() => {
    const quickSetup = modelSettings?.quickSetup;
    if (!quickSetup) {
      return;
    }
    const result = applyQuickModelSetup(
      agentRuntime,
      quickSetup,
      loadKrossConfig()?.llm
    );
    if (!result.ok) {
      setModelSettings((current) =>
        current?.quickSetup
          ? {
              ...current,
              quickSetup: { ...current.quickSetup, error: result.message }
            }
          : current
      );
      return;
    }
    append('system', result.summary);
    setModelSettings(undefined);
  }, [agentRuntime, append, modelSettings]);

  const handleModelSettingsKey = useCallback((
    input: string,
    key: {
      escape?: boolean;
      leftArrow?: boolean;
      rightArrow?: boolean;
      upArrow?: boolean;
      downArrow?: boolean;
      return?: boolean;
      backspace?: boolean;
      delete?: boolean;
      ctrl?: boolean;
      meta?: boolean;
    }
  ): boolean => {
    if (!modelSettings) {
      return false;
    }
    if (modelSettings.quickSetup) {
      const setup = modelSettings.quickSetup;
      if (key.escape) {
        setModelSettings((current) => {
          if (!current?.quickSetup) return current;
          return {
            ...current,
            quickSetup: retreatQuickModelSetup(current.quickSetup)
          };
        });
        return true;
      }
      if (
        setup.step === 'protocol' &&
        (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)
      ) {
        setModelSettings((current) =>
          current?.quickSetup
            ? {
                ...current,
                quickSetup: moveQuickModelProtocol(
                  current.quickSetup,
                  key.leftArrow
                    ? 'left'
                    : key.rightArrow
                      ? 'right'
                      : key.upArrow
                        ? 'up'
                        : 'down'
                )
              }
            : current
        );
        return true;
      }
      if (key.return) {
        if (setup.step === 'review') {
          confirmQuickSetup();
        } else {
          setModelSettings((current) =>
            current?.quickSetup
              ? {
                  ...current,
                  quickSetup: advanceQuickModelSetup(
                    current.quickSetup,
                    loadKrossConfig()?.llm
                  )
                }
              : current
          );
        }
        return true;
      }
      if (key.backspace || key.delete) {
        setModelSettings((current) =>
          current?.quickSetup
            ? {
                ...current,
                quickSetup: updateQuickModelField(current.quickSetup, {
                  backspace: true
                })
              }
            : current
        );
        return true;
      }
      if (
        setup.step !== 'protocol' &&
        setup.step !== 'review' &&
        input.length > 0 &&
        !key.ctrl &&
        !key.meta
      ) {
        setModelSettings((current) =>
          current?.quickSetup
            ? {
                ...current,
                quickSetup: updateQuickModelField(current.quickSetup, {
                  append: input
                })
              }
            : current
        );
      }
      return true;
    }
    if (key.escape) {
      closeModelSettings();
      return true;
    }
    if (input.toLowerCase() === 'n') {
      setModelSettings((current) =>
        current
          ? {
              ...current,
              quickSetup: createQuickModelSetupState(
                agentRuntime,
                loadKrossConfig()?.llm
              )
            }
          : current
      );
      return true;
    }
    if (key.leftArrow) {
      setModelSettings((current) =>
        current ? switchSettingsSection(current, 'model') : current
      );
      return true;
    }
    if (key.rightArrow) {
      setModelSettings((current) =>
        current ? switchSettingsSection(current, 'effort') : current
      );
      return true;
    }
    if (key.upArrow) {
      setModelSettings((current) =>
        current ? moveSettingsSelection(current, 'up') : current
      );
      return true;
    }
    if (key.downArrow) {
      setModelSettings((current) =>
        current ? moveSettingsSelection(current, 'down') : current
      );
      return true;
    }
    if (key.return) {
      if (modelSettings.section === 'model') {
        setModelSettings((current) =>
          current ? switchSettingsSection(current, 'effort') : current
        );
        return true;
      }
      confirmModelSettings();
      return true;
    }
    // 面板打开时吞掉其它输入，避免落到 Composer
    return true;
  }, [
    agentRuntime,
    closeModelSettings,
    confirmModelSettings,
    confirmQuickSetup,
    modelSettings
  ]);

  const toggleModelSettings = useCallback(() => {
    if (pendingToolApproval) {
      return;
    }
    if (modelSettingsOpen) {
      closeModelSettings();
    } else {
      openModelSettings();
    }
  }, [closeModelSettings, modelSettingsOpen, openModelSettings, pendingToolApproval]);

  return {
    modelSettings,
    modelSettingsOpen,
    openModelSettings,
    openQuickModelSetup,
    closeModelSettings,
    confirmModelSettings,
    handleModelSettingsKey,
    toggleModelSettings
  };
}
