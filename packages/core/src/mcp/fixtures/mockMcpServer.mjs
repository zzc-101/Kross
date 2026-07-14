#!/usr/bin/env node
/**
 * Minimal MCP stdio server for tests (Content-Length framing).
 * Tools: echo — returns the input message.
 */
import { Buffer } from 'node:buffer';

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const parsed = readMessage(buffer);
    if (!parsed) {
      break;
    }
    buffer = parsed.rest;
    handle(parsed.message);
  }
});

function readMessage(buf) {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    return undefined;
  }
  const header = buf.subarray(0, headerEnd).toString('utf8');
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) {
    return undefined;
  }
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  if (buf.length < bodyStart + length) {
    return undefined;
  }
  const body = buf.subarray(bodyStart, bodyStart + length).toString('utf8');
  const rest = buf.subarray(bodyStart + length);
  return { message: JSON.parse(body), rest };
}

function write(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  process.stdout.write(Buffer.concat([header, body]));
}

function handle(message) {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.method === 'notifications/initialized') {
    return;
  }
  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '0.0.1' }
      }
    });
    return;
  }
  if (message.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo a message',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string' }
              },
              required: ['message']
            },
            annotations: { readOnlyHint: true }
          }
        ]
      }
    });
    return;
  }
  if (message.method === 'tools/call') {
    const args = message.params?.arguments ?? {};
    const text = String(args.message ?? '');
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: `echo:${text}` }],
        isError: false
      }
    });
    return;
  }
  if (message.id !== undefined) {
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` }
    });
  }
}
