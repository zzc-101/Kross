import { afterEach, describe, expect, it, vi } from 'vitest';

import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenAiProtocolClient } from '../llm/openAiProtocolClient';
import { PiAiLlmClient } from '../llm/piAiLlmClient';
import {
  bootstrapRuntimeTooling,
  createAgentHost,
  createRuntimeOptionsFromEnv
} from './createAgentHost';

const managedHomes: string[] = [];

afterEach(() => {
  for (const homeDir of managedHomes.splice(0)) {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

function createManagedHome(): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'kross-host-managed-home-'));
  managedHomes.push(homeDir);
  return homeDir;
}

describe('createRuntimeOptionsFromEnv', () => {
  it('creates replacement runtimes over shared tooling and closes once', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-agent-host-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-agent-host-home-'));
    const host = await createAgentHost({
      workspaceRoot: workspace,
      env: {},
      config: { homeDir, krossHome: join(homeDir, '.kross') }
    });
    const closeSpy = vi.spyOn(host.tooling, 'close');
    try {
      const first = host.createRuntime();
      const second = host.createRuntime();

      expect(first).not.toBe(second);
      expect(first.getTodoStore()).toBe(second.getTodoStore());
      await host.close();
      await host.close();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(() => host.createRuntime()).toThrow('AgentHost is closed');
    } finally {
      await host.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('host close terminates all active managed processes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-host-process-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-host-home-'));
    const tooling = await bootstrapRuntimeTooling(workspace, {}, { homeDir });
    try {
      const started = await tooling.processManager.start({
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`
      });
      await tooling.close();
      expect(tooling.processManager.poll(started.processId).status).toBe('killed');
    } finally {
      await tooling.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('dispatches redacted lifecycle hooks once at the shared host boundary', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-host-hooks-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-host-hooks-home-'));
    const hook = vi.fn(async (_event: unknown) => undefined);
    const host = await createAgentHost({
      workspaceRoot: workspace,
      env: {},
      config: { homeDir },
      experimentalLifecycleHooks: { hooks: [hook] }
    });
    try {
      host.createRuntime();
      host.createRuntime();
      await host.tooling.traceStore.append({
        id: 'hook-event',
        runId: 'run-hook',
        type: 'tool_call.started',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {
          toolName: 'Read',
          risk: 'read',
          input: { token: 'must-not-leak' }
        }
      });
      await host.close();

      expect(hook).toHaveBeenCalledOnce();
      expect(hook.mock.calls[0]?.[0]).toEqual({
        version: 1,
        type: 'tool.started',
        runId: 'run-hook',
        timestamp: '2026-01-01T00:00:00.000Z',
        tool: { name: 'Read', risk: 'read' }
      });
      expect(JSON.stringify(hook.mock.calls)).not.toContain('must-not-leak');
    } finally {
      await host.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('wires trace store and optional OpenAI-compatible LLM client', () => {
    const options = createRuntimeOptionsFromEnv(
      '/tmp/local-agent',
      {
        AGENT_LLM_PROVIDER: 'openai',
        OPENAI_API_KEY: 'key',
        OPENAI_MODEL: 'gpt-test'
      },
      undefined,
      { homeDir: createManagedHome() }
    );

    expect(options.traceStore).toBeDefined();
    expect(options.llmClient).toBeInstanceOf(PiAiLlmClient);
  });

  it('omits LLM client when provider env is not configured', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-runtime-home-'));
    try {
      const options = createRuntimeOptionsFromEnv(
        '/tmp/local-agent',
        {},
        undefined,
        { homeDir }
      );

      expect(options.traceStore).toBeDefined();
      expect(options.llmClient).toBeUndefined();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('parses AGENT_MAX_TOOL_ITERATIONS when valid', () => {
    const homeDir = createManagedHome();
    const withValue = createRuntimeOptionsFromEnv(
      '/tmp/local-agent',
      { AGENT_MAX_TOOL_ITERATIONS: '40' },
      undefined,
      { homeDir }
    );
    expect(withValue.maxToolIterations).toBe(40);

    const invalid = createRuntimeOptionsFromEnv(
      '/tmp/local-agent',
      { AGENT_MAX_TOOL_ITERATIONS: '0' },
      undefined,
      { homeDir }
    );
    expect(invalid.maxToolIterations).toBeUndefined();
  });

  it('reuses injected tooling gateway when provided', () => {
    const first = createRuntimeOptionsFromEnv(
      '/tmp/local-agent',
      {},
      undefined,
      { homeDir: createManagedHome() }
    );
    expect(first.toolGateway).toBeDefined();
    expect(first.todoStore).toBeDefined();
    expect(first.runSubagent).toBeDefined();
    const setLlmClient = vi.fn();
    const second = createRuntimeOptionsFromEnv(
      '/tmp/local-agent',
      {},
      undefined,
      { homeDir: createManagedHome() },
      {
        toolGateway: first.toolGateway!,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reuses opaque store instance
        traceStore: first.traceStore as any,
        todoStore: first.todoStore!,
        setLlmClient,
        runSubagent: first.runSubagent!,
        skillRegistry: first.skillRegistry!,
        mutationCoordinator: first.mutationCoordinator!
      }
    );
    expect(second.toolGateway).toBe(first.toolGateway);
    expect(second.traceStore).toBe(first.traceStore);
    expect(second.todoStore).toBe(first.todoStore);
    expect(second.runSubagent).toBe(first.runSubagent);
    expect(setLlmClient).toHaveBeenCalled();
    second.onLlmClientChanged?.(undefined);
    expect(setLlmClient).toHaveBeenLastCalledWith(undefined);
  });
});
