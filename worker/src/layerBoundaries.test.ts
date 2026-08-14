import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('worker layer boundaries', () => {
  it('keeps Core free of frontend and host imports', () => {
    expectSources(join(workerRoot, 'core/src'), ['react', 'frontend/', '../src/']);
  });

  it('keeps the Worker host free of UI packages', () => {
    expectSources(join(workerRoot, 'src'), ['react', 'frontend/']);
  });
});

function expectSources(root, forbidden) {
  for (const file of collectSourceFiles(root)) {
    const source = readFileSync(file, 'utf8');
    for (const token of forbidden) {
      expect(source, `${file} contains ${token}`).not.toContain(token);
    }
  }
}

function collectSourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    if (!statSync(path).isFile()) return [];
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}
