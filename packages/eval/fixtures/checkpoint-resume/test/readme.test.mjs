import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('README contains the approved update', () => {
  assert.equal(readFileSync('README.md', 'utf8'), 'approved content\n');
});
