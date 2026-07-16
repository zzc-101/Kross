import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const modesDir = path.dirname(fileURLToPath(import.meta.url));

function listNonTestTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...listNonTestTsFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    results.push(full);
  }
  return results;
}

describe('modes layer boundaries', () => {
  it('does not import from ../runtime/', () => {
    const violations: string[] = [];
    for (const file of listNonTestTsFiles(modesDir)) {
      const source = readFileSync(file, 'utf8');
      // Match relative imports into runtime from modes
      const re =
        /from\s+['"](?:\.\.\/)+runtime(?:\/[^'"]*)?['"]|import\s*\(\s*['"](?:\.\.\/)+runtime(?:\/[^'"]*)?['"]\s*\)/g;
      const matches = source.match(re);
      if (matches) {
        const rel = path.relative(modesDir, file);
        violations.push(`${rel}: ${matches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
