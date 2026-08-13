import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('SaaS compose topology', () => {
  it('keeps the Docker socket out of Server and has no dependency cycle', async () => {
    const compose = await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const blocks = serviceBlocks(compose);
    expect(blocks.server).not.toContain('/var/run/docker.sock');
    expect(blocks.orchestrator).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(findCycle({
      postgres: [], migrate: ['postgres'], server: ['migrate'],
      orchestrator: ['worker-image'], 'worker-image': [], web: ['server'], 'admin-web': ['server']
    })).toBeUndefined();
    expect(blocks.server).toContain('KROSS_ORCHESTRATOR_URL: http://orchestrator:8790');
    expect(blocks.web).toContain('condition: service_healthy');
  });

  it('smoke checks the exact Dev Identity header used by Server', async () => {
    const smoke = await readFile(new URL('../../../scripts/cloud-container-smoke.sh', import.meta.url), 'utf8');
    expect(smoke).toContain("'x-kross-user-id':'smoke-user'");
    expect(smoke).not.toContain('x-kross-dev-user');
    expect(smoke).toContain('docker compose config --quiet');
    expect(smoke).toContain('docker compose up -d --build web admin-web orchestrator');
    expect(smoke).toContain('docker compose port admin-web 8788');
    expect(smoke).toContain("orchestrator node -e");
  });
});

function serviceBlocks(source: string): Record<string, string> {
  const output: Record<string, string> = {};
  const matches = [...source.matchAll(/^  ([a-z][a-z0-9-]+):\n/gm)];
  for (const [index, match] of matches.entries()) {
    output[match[1]!] = source.slice(match.index!, matches[index + 1]?.index ?? source.indexOf('\nvolumes:'));
  }
  return output;
}

function findCycle(graph: Record<string, string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string, path: string[]): string[] | undefined => {
    if (visiting.has(node)) return [...path, node];
    if (visited.has(node)) return undefined;
    visiting.add(node);
    for (const dependency of graph[node] ?? []) {
      const cycle = visit(dependency, [...path, node]);
      if (cycle) return cycle;
    }
    visiting.delete(node);
    visited.add(node);
    return undefined;
  };
  for (const node of Object.keys(graph)) {
    const cycle = visit(node, []);
    if (cycle) return cycle;
  }
  return undefined;
}
