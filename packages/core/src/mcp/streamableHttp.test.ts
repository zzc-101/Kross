import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TraceEvent } from '../domain';
import { ToolGateway } from '../tools/toolGateway';
import { AgentRuntime } from '../runtime/agentRuntime';
import type { TraceStore } from '../trace/traceStore';
import { McpClient } from './mcpClient';
import { connectAndRegisterMcpTools } from './register';
import { StreamableHttpTransport } from './streamableHttp';
import { McpHttpError } from './streamableHttp';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe('StreamableHttpTransport', () => {
  it('registers remote tools with auth, reconnects sessions, resumes SSE, and deletes sessions', async () => {
    const fixture = await startFixtureServer();
    cleanups.push(fixture.close);
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-mcp-http-'));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
    mkdirSync(join(homeDir, '.kross'), { recursive: true });
    writeFileSync(
      join(homeDir, '.kross', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          remote: {
            transport: 'streamable-http',
            url: fixture.endpoint,
            headers: {
              'X-Kross-Test': 'fixture',
              Authorization: 'must-be-rejected'
            },
            authorization: {
              type: 'bearer-env',
              env: 'KROSS_TEST_MCP_TOKEN'
            }
          }
        }
      })
    );

    const gateway = new ToolGateway();
    const manager = await connectAndRegisterMcpTools(gateway, {
      homeDir,
      env: { KROSS_TEST_MCP_TOKEN: 'secret-token' }
    });
    try {
      expect(manager.snapshot().results[0]?.error).toBeUndefined();
      const remote = gateway
        .listTools()
        .find((tool) => tool.name === 'remote__echo');
      expect(remote?.risk).toBe('network');

      const result = await gateway.call({
        runId: 'run-http-mcp',
        name: 'remote__echo',
        input: { message: 'hello' },
        approved: true
      });
      expect(result.content).toBe('echo:hello');
      expect(fixture.state.initializeCount).toBe(2);
      expect(fixture.state.resumeCount).toBe(1);
      expect(fixture.state.authenticatedRequests).toBeGreaterThan(0);
      expect(fixture.state.badAuthorizationHeader).toBe(false);
      expect(fixture.state.badProtocolHeader).toBe(false);

      expect(await manager.listResources()).toEqual([
        expect.objectContaining({
          serverId: 'remote',
          uri: 'file:///fixture/readme.md'
        })
      ]);
      expect(
        (await manager.readResource(
          'remote',
          'file:///fixture/readme.md'
        )).result.contents?.[0]?.text
      ).toBe('# Fixture resource');
      expect(await manager.listPrompts()).toEqual([
        expect.objectContaining({
          serverId: 'remote',
          name: 'review'
        })
      ]);
      expect(
        (await manager.getPrompt('remote', 'review', {
          target: 'README.md'
        })).result.messages?.[0]?.content.text
      ).toBe('Review README.md');

      const runtime = new AgentRuntime({
        traceStore: new MemoryTraceStore(),
        mcpManager: manager
      });
      const attached = await runtime.runMcpCommand(
        'resource remote file:///fixture/readme.md'
      );
      expect(attached).toContain('external / untrusted');
      expect(
        runtime.inspectContext({
          requestedMode: 'auto',
          currentUserInput: ''
        }).includedSources
      ).toContain(
        'mcp-resource:remote:file:///fixture/readme.md'
      );
      const promptPreview = await runtime.runMcpCommand(
        'prompt remote review {"target":"README.md"}'
      );
      expect(promptPreview).toContain('未自动执行');
      expect(promptPreview).toContain('Review README.md');
    } finally {
      await manager.close();
    }
    expect(fixture.state.deleteCount).toBe(1);
  });

  it('sends an explicit cancellation notification for aborted HTTP calls', async () => {
    const fixture = await startFixtureServer();
    cleanups.push(fixture.close);
    const client = new McpClient(
      new StreamableHttpTransport({
        endpoint: fixture.endpoint,
        bearerToken: 'secret-token'
      })
    );
    await client.connect();
    try {
      const controller = new AbortController();
      const pending = client.callTool(
        'slow',
        { delayMs: 10_000 },
        { signal: controller.signal }
      );
      controller.abort('user cancelled');
      await expect(pending).rejects.toMatchObject({
        name: 'AbortError',
        message: 'user cancelled'
      });
      await vi.waitFor(() => {
        expect(fixture.state.cancellations).toContain('user cancelled');
      });
    } finally {
      await client.close();
    }
  });

  it('surfaces OAuth resource metadata without exposing bearer tokens', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(undefined, {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'WWW-Authenticate':
            'Bearer resource_metadata="https://auth.example.com/resource", scope="tools:read"'
        }
      })
    );
    const client = new McpClient(
      new StreamableHttpTransport({
        endpoint: 'https://mcp.example.com/mcp',
        bearerToken: 'do-not-expose',
        fetchImpl
      })
    );

    const error = await client.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpHttpError);
    expect(error).toMatchObject({
      status: 401,
      resourceMetadata: 'https://auth.example.com/resource',
      scope: 'tools:read'
    });
    expect(String(error)).not.toContain('do-not-expose');
    await client.close();
  });
});

async function startFixtureServer(): Promise<{
  endpoint: string;
  state: FixtureState;
  close: () => Promise<void>;
}> {
  const state: FixtureState = {
    initializeCount: 0,
    listCount: 0,
    resumeCount: 0,
    deleteCount: 0,
    authenticatedRequests: 0,
    badAuthorizationHeader: false,
    badProtocolHeader: false,
    cancellations: [],
    pendingCallId: undefined
  };
  const server = createServer((request, response) => {
    void handleFixtureRequest(request, response, state);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('missing fixture server address');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

interface FixtureState {
  initializeCount: number;
  listCount: number;
  resumeCount: number;
  deleteCount: number;
  authenticatedRequests: number;
  badAuthorizationHeader: boolean;
  badProtocolHeader: boolean;
  cancellations: string[];
  pendingCallId?: number;
}

async function handleFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: FixtureState
): Promise<void> {
  if (request.headers.authorization === 'Bearer secret-token') {
    state.authenticatedRequests += 1;
  } else {
    state.badAuthorizationHeader = true;
  }
  if (
    request.headers.authorization === 'Bearer must-be-rejected' ||
    request.headers['x-kross-test'] === undefined
  ) {
    state.badAuthorizationHeader = true;
  }

  if (request.method === 'DELETE') {
    if (request.headers['mcp-protocol-version'] !== '2025-11-25') {
      state.badProtocolHeader = true;
    }
    state.deleteCount += 1;
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'GET') {
    if (request.headers['mcp-protocol-version'] !== '2025-11-25') {
      state.badProtocolHeader = true;
    }
    state.resumeCount += 1;
    expect(request.headers['last-event-id']).toBe('cursor-1');
    const result = {
      jsonrpc: '2.0',
      id: state.pendingCallId,
      result: {
        content: [{ type: 'text', text: 'echo:hello' }],
        isError: false
      }
    };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`id: cursor-2\ndata: ${JSON.stringify(result)}\n\n`);
    return;
  }

  const message = (await readJson(request)) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  };
  const protocolHeader = request.headers['mcp-protocol-version'];
  if (message.method === 'initialize') {
    if (protocolHeader !== undefined) state.badProtocolHeader = true;
  } else if (protocolHeader !== '2025-11-25') {
    state.badProtocolHeader = true;
  }
  if (message.method === 'initialize') {
    state.initializeCount += 1;
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'MCP-Session-Id': `session-${state.initializeCount}`
    });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {}
          },
          serverInfo: { name: 'fixture', version: '1.0.0' }
        }
      })
    );
    return;
  }
  if (message.method === 'notifications/initialized') {
    response.writeHead(202).end();
    return;
  }
  if (message.method === 'notifications/cancelled') {
    const reason = (message.params as { reason?: unknown } | undefined)?.reason;
    state.cancellations.push(String(reason ?? ''));
    response.writeHead(202).end();
    return;
  }
  if (message.method === 'tools/list') {
    state.listCount += 1;
    if (state.listCount === 1) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo over HTTP',
              inputSchema: {
                type: 'object',
                properties: { message: { type: 'string' } },
                required: ['message']
              },
              annotations: { readOnlyHint: true }
            }
          ]
        }
      })
    );
    return;
  }
  if (message.method === 'resources/list') {
    sendJsonResult(response, message.id, {
      resources: [
        {
          uri: 'file:///fixture/readme.md',
          name: 'Fixture README',
          mimeType: 'text/markdown'
        }
      ]
    });
    return;
  }
  if (message.method === 'resources/read') {
    sendJsonResult(response, message.id, {
      contents: [
        {
          uri: 'file:///fixture/readme.md',
          mimeType: 'text/markdown',
          text: '# Fixture resource'
        }
      ]
    });
    return;
  }
  if (message.method === 'prompts/list') {
    sendJsonResult(response, message.id, {
      prompts: [
        {
          name: 'review',
          description: 'Review a target',
          arguments: [{ name: 'target', required: true }]
        }
      ]
    });
    return;
  }
  if (message.method === 'prompts/get') {
    const args = message.params?.arguments as
      | Record<string, string>
      | undefined;
    sendJsonResult(response, message.id, {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Review ${args?.target ?? ''}`
          }
        }
      ]
    });
    return;
  }
  if (message.method === 'tools/call' && message.params?.name === 'echo') {
    state.pendingCallId = message.id;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('id: cursor-1\nretry: 1\ndata:\n\n');
    return;
  }
  if (message.method === 'tools/call' && message.params?.name === 'slow') {
    request.on('close', () => {
      if (!response.writableEnded) response.destroy();
    });
    return;
  }
  response.writeHead(400).end();
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJsonResult(
  response: ServerResponse,
  id: number | undefined,
  result: unknown
): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

class MemoryTraceStore implements TraceStore {
  private readonly events: TraceEvent[] = [];

  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }

  async listRunIds(): Promise<string[]> {
    return [...new Set(this.events.map((event) => event.runId))];
  }
}
