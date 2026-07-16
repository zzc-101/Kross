import { describe, expect, it, vi } from 'vitest';

import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenAiProtocolClient } from '../llm/openAiProtocolClient';
import { PiAiLlmClient } from '../llm/piAiLlmClient';
import { createRuntimeOptionsFromEnv } from './createAgentHost';

describe('createRuntimeOptionsFromEnv', () => {
  it('wires trace store and optional OpenAI-compatible LLM client', () => {
    const options = createRuntimeOptionsFromEnv('/tmp/local-agent', {
      AGENT_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'key',
      OPENAI_MODEL: 'gpt-test'
    });

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
    const withValue = createRuntimeOptionsFromEnv('/tmp/local-agent', {
      AGENT_MAX_TOOL_ITERATIONS: '40'
    });
    expect(withValue.maxToolIterations).toBe(40);

    const invalid = createRuntimeOptionsFromEnv('/tmp/local-agent', {
      AGENT_MAX_TOOL_ITERATIONS: '0'
    });
    expect(invalid.maxToolIterations).toBeUndefined();
  });

  it('reuses injected tooling gateway when provided', () => {
    const first = createRuntimeOptionsFromEnv('/tmp/local-agent', {});
    expect(first.toolGateway).toBeDefined();
    expect(first.todoStore).toBeDefined();
    expect(first.runSubagent).toBeDefined();
    const setLlmClient = vi.fn();
    const second = createRuntimeOptionsFromEnv(
      '/tmp/local-agent',
      {},
      undefined,
      {},
      {
        toolGateway: first.toolGateway!,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reuses opaque store instance
        traceStore: first.traceStore as any,
        todoStore: first.todoStore!,
        setLlmClient,
        runSubagent: first.runSubagent!,
        workspaceRoots: first.workspaceRoots!,
        skillRegistry: first.skillRegistry!,
        mutationCoordinator: first.mutationCoordinator!
      }
    );
    expect(second.toolGateway).toBe(first.toolGateway);
    expect(second.traceStore).toBe(first.traceStore);
    expect(second.todoStore).toBe(first.todoStore);
    expect(second.runSubagent).toBe(first.runSubagent);
    expect(setLlmClient).toHaveBeenCalled();
  });

  it('registers TodoWrite and TodoRead on the gateway', () => {
    const options = createRuntimeOptionsFromEnv('/tmp/local-agent', {});
    const names = options.toolGateway?.listTools().map((tool) => tool.name) ?? [];
    expect(names).toContain('TodoWrite');
    expect(names).toContain('TodoRead');
    expect(names).toContain('ReadSkill');
    expect(names).toContain('ApplyPatch');
  });

  it('applies config contextWindow even when credentials come from env', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-runtime-home-'));
    try {
      mkdirSync(join(homeDir, '.kross'), { recursive: true });
      writeFileSync(
        join(homeDir, '.kross/config.json'),
        JSON.stringify({
          llm: {
            provider: 'openai',
            model: 'saved-model',
            contextWindow: 384000
          }
        })
      );

      const options = createRuntimeOptionsFromEnv(
        '/tmp/local-agent',
        {
          AGENT_LLM_PROVIDER: 'openai',
          OPENAI_API_KEY: 'env-key',
          OPENAI_MODEL: 'env-model'
        },
        undefined,
        { homeDir }
      );

      expect(options.llmClient?.contextWindow).toBe(384_000);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('uses saved Kross config when provider env is not configured', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-runtime-home-'));
    try {
      mkdirSync(join(homeDir, '.kross'), { recursive: true });
      writeFileSync(
        join(homeDir, '.kross/config.json'),
        JSON.stringify({
          llm: {
            provider: 'openai',
            apiKey: 'saved-key',
            model: 'gpt-saved',
            baseUrl: 'https://saved.example/v1',
            contextWindow: 384000
          }
        })
      );
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const options = createRuntimeOptionsFromEnv(
        '/tmp/local-agent',
        {},
        async (url, init) => {
          calls.push({ url, init });
          return new Response(
            JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
            { headers: { 'content-type': 'application/json' } }
          );
        },
        { homeDir }
      );

      await options.llmClient?.complete({
        messages: [{ role: 'user', content: 'hi' }]
      });

      expect(options.llmClient).toBeInstanceOf(OpenAiProtocolClient);
      expect(options.llmClient?.contextWindow).toBe(384_000);
      expect(calls[0]?.url).toBe('https://saved.example/v1/chat/completions');
      expect(calls[0]?.init.headers).toMatchObject({
        authorization: 'Bearer saved-key'
      });
      expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
        model: 'gpt-saved'
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('applies context governance settings from Kross config', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-runtime-home-'));
    try {
      mkdirSync(join(homeDir, '.kross'), { recursive: true });
      writeFileSync(
        join(homeDir, '.kross/config.json'),
        JSON.stringify({
          context: {
            preserveFullTurns: 2,
            preserveRecentTokens: 12_000,
            compactionInstructions: '保留精确文件路径'
          }
        })
      );

      const options = createRuntimeOptionsFromEnv(
        '/tmp/local-agent',
        {},
        undefined,
        { homeDir }
      );
      expect(options.sessionContext?.getPolicy().preserveFullTurns).toBe(2);
      expect(options.sessionContext?.getPolicy().preserveRecentTokens).toBe(
        12_000
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
