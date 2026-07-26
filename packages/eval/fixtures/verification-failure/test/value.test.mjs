import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the implementation keeps the required value', () => {
  const source = readFileSync(
    new URL('../src/value.ts', import.meta.url),
    'utf8'
  );
  assert.match(source, /return 42;/u);
});
