import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMcpServersConfig } from './config';

describe('loadMcpServersConfig', () => {
  it('merges mcp.json and config.json with config.json winning on conflicts', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-mcp-config-'));
    try {
      const kross = join(homeDir, '.kross');
      mkdirSync(kross, { recursive: true });
      writeFileSync(
        join(kross, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            a: { command: 'echo', args: ['from-mcp-json'] },
            b: { command: 'echo', args: ['only-mcp'] }
          }
        })
      );
      writeFileSync(
        join(kross, 'config.json'),
        JSON.stringify({
          mcpServers: {
            a: { command: 'node', args: ['from-config'], disabled: true }
          }
        })
      );

      const servers = loadMcpServersConfig({ homeDir });
      expect(servers.a).toMatchObject({
        command: 'node',
        args: ['from-config'],
        disabled: true
      });
      expect(servers.b).toMatchObject({
        command: 'echo',
        args: ['only-mcp']
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('accepts bare server maps in mcp.json', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kross-mcp-bare-'));
    try {
      const kross = join(homeDir, '.kross');
      mkdirSync(kross, { recursive: true });
      writeFileSync(
        join(kross, 'mcp.json'),
        JSON.stringify({
          demo: { command: 'npx', args: ['-y', 'fake'] }
        })
      );
      const servers = loadMcpServersConfig({ homeDir });
      expect(servers.demo?.command).toBe('npx');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
