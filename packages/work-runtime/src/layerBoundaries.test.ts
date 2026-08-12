import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = resolve(packageRoot, '..');

describe('SaaS package layer boundaries', () => {
  it('keeps Core independent from SaaS product packages', () => {
    expectPackageSources('core', [
      '@kross/work-domain',
      '@kross/work-runtime',
      '@kross/protocol',
      '@kross/server',
      '@kross/worker',
      '@kross/web'
    ]);
  });

  it('keeps the local TUI independent from SaaS domain and hosts', () => {
    expectPackageSources('tui', [
      '@kross/work-domain',
      '@kross/work-runtime',
      '@kross/protocol',
      '@kross/server',
      '@kross/worker',
      '@kross/web'
    ]);
  });

  it('keeps Work Domain browser-safe and infrastructure-free', () => {
    expectPackageSources('work-domain', [
      'node:',
      '@kross/core',
      '@kross/protocol',
      '@kross/server',
      '@kross/worker',
      '@kross/web',
      'react'
    ]);
  });

  it('keeps Work Runtime independent from control-plane and UI packages', () => {
    expectPackageSources('work-runtime', [
      '@kross/protocol',
      '@kross/server',
      '@kross/orchestrator',
      '@kross/worker',
      '@kross/web',
      'react'
    ]);
  });
});

function expectPackageSources(packageName: string, forbidden: string[]): void {
  const root = join(packagesRoot, packageName);
  const files = collectSourceFiles(join(root, 'src'));
  const manifest = readFileSync(join(root, 'package.json'), 'utf8');

  for (const token of forbidden) {
    expect(manifest, `${packageName}/package.json imports ${token}`).not.toContain(
      `"${token}"`
    );
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const importedPackages = extractImportedPackages(source);
      expect(
        importedPackages.some(
          (specifier) =>
            specifier === token ||
            specifier.startsWith(`${token}/`) ||
            (token.endsWith(':') && specifier.startsWith(token))
        ),
        `${file} imports ${token}`
      ).toBe(false);
    }
  }
}

function collectSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    if (!statSync(path).isFile()) return [];
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

function extractImportedPackages(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern =
    /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;

  for (const match of source.matchAll(importPattern)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}
