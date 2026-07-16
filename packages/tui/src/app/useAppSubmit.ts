import { useCallback } from 'react';

import {
  t,
  type AgentMode,
  type AgentRuntime,
  type ConfigImportController,
  type ConfigImportPrompt,
  type PermissionMode
} from '@kross/core';

import type { SlashCommand } from '../ui';
import { executeCompactCommand, handleCommand } from './appCommands';
import type { RunTurnOutcome } from './useAgentRun';

export interface UseAppSubmitOptions {
  isHome: boolean;
  selectedRecentSession: number | undefined;
  resumeSession: (selector?: string) => Promise<boolean>;
  openModelSettings: () => void;
  slashSuggestions: SlashCommand[];
  slashSelectedIndex: number;
  openSessionPicker: () => boolean;
  ensureActiveSession: () => string | undefined;
  append: (from: 'user' | 'system' | 'agent' | 'thinking' | 'tool', text: string) => number;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  agentRuntime: AgentRuntime;
  setMode: React.Dispatch<React.SetStateAction<AgentMode>>;
  setPermissionMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  mode: AgentMode;
  importPrompt: ConfigImportPrompt | undefined;
  configImportController: ConfigImportController | undefined;
  setImportPrompt: React.Dispatch<React.SetStateAction<ConfigImportPrompt | undefined>>;
  setRuntimeGeneration: React.Dispatch<React.SetStateAction<number>>;
  toggleLastCollapsible: () => void;
  pendingConductorPlan: { prompt: string; mode: AgentMode } | undefined;
  choosePlanApproval: (approved: boolean) => Promise<void>;
  setLocaleGeneration: React.Dispatch<React.SetStateAction<number>>;
  processingRef: React.MutableRefObject<boolean>;
  queueRef: React.MutableRefObject<string[]>;
  setQueueLength: React.Dispatch<React.SetStateAction<number>>;
  runTurn: (prompt: string) => Promise<RunTurnOutcome>;
  commandAbortControllerRef: React.MutableRefObject<AbortController | undefined>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setAwaitingReply: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useAppSubmit({
  isHome,
  selectedRecentSession,
  resumeSession,
  openModelSettings,
  slashSuggestions,
  slashSelectedIndex,
  openSessionPicker,
  ensureActiveSession,
  append,
  setInput,
  agentRuntime,
  setMode,
  setPermissionMode,
  mode,
  importPrompt,
  configImportController,
  setImportPrompt,
  setRuntimeGeneration,
  toggleLastCollapsible,
  pendingConductorPlan,
  choosePlanApproval,
  setLocaleGeneration,
  processingRef,
  queueRef,
  setQueueLength,
  runTurn,
  commandAbortControllerRef,
  setStatus,
  setAwaitingReply
}: UseAppSubmitOptions) {
  return useCallback(async (value: string) => {
    const trimmed = value.trim();
    const runQueuedTurns = async (first: string): Promise<void> => {
      let next: string | undefined = first;
      try {
        while (next) {
          const outcome = await runTurn(next);
          if (outcome === 'cancelled' || outcome === 'paused') {
            if (outcome === 'cancelled' && queueRef.current.length > 0) {
              append(
                'system',
                t('app.queuePaused', { count: queueRef.current.length })
              );
            }
            break;
          }
          next = queueRef.current.shift();
          setQueueLength(queueRef.current.length);
        }
      } finally {
        processingRef.current = false;
      }
    };
    if (trimmed.length === 0) {
      if (!processingRef.current && queueRef.current.length > 0) {
        const next = queueRef.current.shift();
        setQueueLength(queueRef.current.length);
        if (next) {
          processingRef.current = true;
          await runQueuedTurns(next);
        }
        return;
      }
      if (isHome && selectedRecentSession !== undefined) {
        await resumeSession();
      }
      return;
    }

    // 打开设置面板（快捷入口，避免记一堆 /model /think 参数）
    if (trimmed === '/settings' || trimmed === '/model') {
      setInput('');
      openModelSettings();
      return;
    }

    // 斜杠提示打开时，若当前输入只是前缀，Enter 先补全选中命令。
    if (
      slashSuggestions.length > 0 &&
      !slashSuggestions.some((command) => command.name === trimmed || trimmed.startsWith(`${command.name} `))
    ) {
      const selected = slashSuggestions[slashSelectedIndex] ?? slashSuggestions[0];
      if (selected && trimmed !== selected.name) {
        setInput(`${selected.name} `);
        return;
      }
    }

    if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
      setInput('');
      const selector = trimmed.slice('/resume'.length).trim() || undefined;
      if (selector) {
        await resumeSession(selector);
      } else {
        // 无参：弹出会话选择，不直接恢复最近一条。
        openSessionPicker();
      }
      return;
    }

    setInput('');
    ensureActiveSession();
    append('user', `> ${trimmed}`);

    if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
      if (processingRef.current) {
        append('system', t('cmd.compact.busy'));
        return;
      }

      processingRef.current = true;
      const controller = new AbortController();
      commandAbortControllerRef.current = controller;
      append('system', t('cmd.compact.running'));
      let cancelled = false;
      try {
        append(
          'agent',
          await executeCompactCommand(
            trimmed,
            agentRuntime,
            mode,
            controller.signal
          )
        );
      } catch (error) {
        if (controller.signal.aborted) {
          cancelled = true;
          append('system', t('app.interrupted'));
        } else {
          append(
            'system',
            t('cmd.asyncFailed', {
              command: '/compact',
              message: error instanceof Error ? error.message : String(error)
            })
          );
        }
      } finally {
        if (commandAbortControllerRef.current === controller) {
          commandAbortControllerRef.current = undefined;
        }
        setStatus('ready');
        setAwaitingReply(false);
      }

      if (cancelled) {
        processingRef.current = false;
        setQueueLength(queueRef.current.length);
        if (queueRef.current.length > 0) {
          append(
            'system',
            t('app.queuePaused', { count: queueRef.current.length })
          );
        }
        return;
      }

      const next = queueRef.current.shift();
      setQueueLength(queueRef.current.length);
      if (next) {
        await runQueuedTurns(next);
      } else {
        processingRef.current = false;
      }
      return;
    }

    if (
      handleCommand(
        trimmed,
        append,
        setMode,
        setPermissionMode,
        agentRuntime,
        mode,
        importPrompt,
        configImportController,
        setImportPrompt,
        () => setRuntimeGeneration((current) => current + 1),
        toggleLastCollapsible,
        Boolean(pendingConductorPlan),
        choosePlanApproval,
        () => setLocaleGeneration((current) => current + 1)
      )
    ) {
      return;
    }

    if (processingRef.current) {
      queueRef.current.push(trimmed);
      setQueueLength(queueRef.current.length);
      append('system', t('app.queued', { count: queueRef.current.length }));
      return;
    }

    if (queueRef.current.length > 0) {
      queueRef.current.push(trimmed);
      setQueueLength(queueRef.current.length);
      const next = queueRef.current.shift();
      setQueueLength(queueRef.current.length);
      if (next) {
        processingRef.current = true;
        await runQueuedTurns(next);
      }
      return;
    }

    processingRef.current = true;
    await runQueuedTurns(trimmed);
  }, [
    agentRuntime,
    append,
    configImportController,
    importPrompt,
    mode,
    openModelSettings,
    runTurn,
    slashSelectedIndex,
    slashSuggestions,
    pendingConductorPlan,
    choosePlanApproval,
    ensureActiveSession,
    isHome,
    openSessionPicker,
    resumeSession,
    selectedRecentSession,
    toggleLastCollapsible,
    processingRef,
    queueRef,
    setInput,
    setLocaleGeneration,
    setMode,
    setPermissionMode,
    setImportPrompt,
    setQueueLength,
    setRuntimeGeneration,
    commandAbortControllerRef,
    setStatus,
    setAwaitingReply
  ]);
}
