import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ToolGateway } from '../tools/toolGateway';
import type { McpToolClient } from './mcpClient';
import { connectAndRegisterMcpTools, formatMcpToolResult } from './register';

const fixtureServer = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/mockMcpServer.mjs'
);

describe('connectAndRegisterMcpTools', () => {
  it('marks MCP isError results as failed with recovery metadata', () => {
    const result = formatMcpToolResult({
      isError: true,
      content: [{ type: 'text', text: 'invalid remote input' }]
    });
    expect(result).toMatchObject({
      status: 'failed',
      data: {
        error: {
          source: 'mcp',
          category: 'protocol',
          retryable: false
        }
      }
    });
  });

  it('connects a stdio MCP server and registers tools on the gateway', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-mcp-reg-'));
    try {
      const kross = join(homeDir, '.kross');
      mkdirSync(kross, { recursive: true });
      writeFileSync(
        join(kross, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            mock: {
              command: process.execPath,
              args: [fixtureServer]
            }
          }
        })
      );

      const gateway = new ToolGateway();
      const manager = await connectAndRegisterMcpTools(gateway, { homeDir });
      try {
        const snapshot = manager.snapshot();
        expect(snapshot.results[0]?.error).toBeUndefined();
        expect(snapshot.registeredToolNames).toContain('mock__echo');

        const tools = gateway.listTools();
        const echo = tools.find((tool) => tool.name === 'mock__echo');
        expect(echo?.risk).toBe('read');
        expect(echo?.description).toContain('[MCP:mock]');

        const result = await gateway.call({
          runId: 'run-mcp-1',
          name: 'mock__echo',
          input: { message: 'hi' }
        });
        expect(result.status).toBe('completed');
        expect(result.content).toContain('echo:hi');
      } finally {
        await manager.close();
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('soft-fails a broken server without throwing', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-mcp-bad-'));
    try {
      const kross = join(homeDir, '.kross');
      mkdirSync(kross, { recursive: true });
      writeFileSync(
        join(kross, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            broken: {
              command: process.execPath,
              args: ['-e', 'process.exit(1)'],
              connectTimeoutMs: 2000
            }
          }
        })
      );

      const warnings: string[] = [];
      const gateway = new ToolGateway();
      const manager = await connectAndRegisterMcpTools(gateway, {
        homeDir,
        onWarning: (message) => warnings.push(message)
      });
      try {
        expect(manager.snapshot().registeredToolNames).toEqual([]);
        expect(manager.snapshot().results[0]?.error).toBeTruthy();
        expect(warnings.length).toBeGreaterThan(0);
      } finally {
        await manager.close();
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('redacts raw stderr from manager warnings', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-mcp-diagnostic-'));
    try {
      const kross = join(homeDir, '.kross');
      mkdirSync(kross, { recursive: true });
      writeFileSync(
        join(kross, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            mock: { command: 'unused' }
          }
        })
      );
      const warnings: string[] = [];
      const client = {
        connect: async () => undefined,
        listTools: async () => [],
        callTool: async () => ({}),
        close: async () => undefined,
        onDiagnostic: (listener) => {
          listener({
            level: 'warning',
            code: 'stderr',
            message: 'SECRET_TOKEN=do-not-log'
          });
          return () => undefined;
        }
      } satisfies McpToolClient;

      const manager = await connectAndRegisterMcpTools(new ToolGateway(), {
        homeDir,
        createClient: () => client,
        onWarning: (message) => warnings.push(message)
      });
      await manager.close();

      expect(warnings).toEqual([
        'MCP server "mock" stderr: server emitted stderr output'
      ]);
      expect(warnings.join('\n')).not.toContain('SECRET_TOKEN');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
