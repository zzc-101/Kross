import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  McpClient,
  McpStdioClient,
  MCP_PROTOCOL_VERSION
} from './mcpClient';
import type {
  McpTransport,
  McpTransportDiagnosticListener,
  McpTransportRequestOptions
} from './transport';

const fixtureServer = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/mockMcpServer.mjs'
);

describe('McpClient transport lifecycle', () => {
  it('drives the MCP handshake and tools over an injected transport', async () => {
    const transport = new RecordingTransport();
    const client = new McpClient(transport, {
      clientName: 'test-client',
      clientVersion: '1.2.3'
    });

    await client.connect();
    const tools = await client.listTools();
    const result = await client.callTool('echo', { message: 'hello' });
    await client.close();
    await client.close();

    expect(tools).toEqual([{ name: 'echo' }]);
    expect(result.content?.[0]?.text).toBe('echo:hello');
    expect(transport.methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call'
    ]);
    expect(transport.initializeParams).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {}
    });
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('propagates abort and timeout through the stdio transport', async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: [fixtureServer]
    });
    await client.connect();
    try {
      const controller = new AbortController();
      const aborted = client.callTool(
        'slow',
        { delayMs: 200 },
        { signal: controller.signal }
      );
      controller.abort('test cancellation');
      await expect(aborted).rejects.toMatchObject({
        name: 'AbortError',
        message: 'test cancellation'
      });

      await expect(
        client.callTool('slow', { delayMs: 200 }, { timeoutMs: 10 })
      ).rejects.toThrow('MCP request timed out: tools/call');
    } finally {
      await client.close();
      await client.close();
    }
  });

  it('reports stdio spawn failures as diagnostics without an unhandled error event', async () => {
    const client = new McpStdioClient({
      command: '/definitely/missing/kross-mcp-server'
    });
    const diagnostics: string[] = [];
    client.onDiagnostic((diagnostic) => {
      diagnostics.push(`${diagnostic.code}:${diagnostic.message}`);
    });

    await expect(client.connect()).rejects.toThrow();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining('transport-error:spawn')
      ])
    );
    await client.close();
  });
});

class RecordingTransport implements McpTransport {
  readonly kind = 'recording';
  readonly methods: string[] = [];
  readonly close = vi.fn(async () => undefined);
  initializeParams?: unknown;

  start(): void {
    this.methods.push('initialize');
  }

  async request(
    method: string,
    params?: unknown,
    _options?: McpTransportRequestOptions
  ): Promise<unknown> {
    if (method !== 'initialize') {
      this.methods.push(method);
    } else {
      this.initializeParams = params;
    }
    if (method === 'tools/list') {
      return { tools: [{ name: 'echo' }] };
    }
    if (method === 'tools/call') {
      const message = (params as { arguments?: { message?: string } })
        .arguments?.message;
      return {
        content: [{ type: 'text', text: `echo:${message ?? ''}` }]
      };
    }
    return {};
  }

  notify(method: string): void {
    this.methods.push(method);
  }

  onDiagnostic(_listener: McpTransportDiagnosticListener): () => void {
    return () => undefined;
  }
}
