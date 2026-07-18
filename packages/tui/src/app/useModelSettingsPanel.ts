import { useCallback, useState } from 'react';

import {
  getLlmProviderDefinition,
  loadKrossConfig,
  updateKrossLlmConfig,
  updateKrossPublicModelConfig,
  type AgentRuntime
} from '@kross/core';

import {
  applyModelSettings,
  createModelSettingsState,
  moveSettingsSelection,
  switchSettingsSection,
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

  const handleModelSettingsKey = useCallback((
    key: {
      escape?: boolean;
      leftArrow?: boolean;
      rightArrow?: boolean;
      upArrow?: boolean;
      downArrow?: boolean;
      return?: boolean;
    }
  ): boolean => {
    if (!modelSettings) {
      return false;
    }
    if (key.escape) {
      closeModelSettings();
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
  }, [closeModelSettings, confirmModelSettings, modelSettings]);

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
    closeModelSettings,
    confirmModelSettings,
    handleModelSettingsKey,
    toggleModelSettings
  };
}
