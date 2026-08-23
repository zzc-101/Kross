import { describe, expect, it } from 'vitest';

import { parseExtractedItems } from './memoryExtract';

describe('parseExtractedItems', () => {
  it('reads a JSON object from model text', () => {
    const items = parseExtractedItems('Here you go\n{"items":[{"kind":"preference","content":"用中文回复"},{"kind":"fact","content":"项目用 Java 21"}]}');
    expect(items).toEqual([
      { kind: 'preference', content: '用中文回复' },
      { kind: 'fact', content: '项目用 Java 21' }
    ]);
  });

  it('returns nothing for invalid or empty payloads', () => {
    expect(parseExtractedItems('no json')).toEqual([]);
    expect(parseExtractedItems('{"items":[]}')).toEqual([]);
    expect(parseExtractedItems('{"items":[{"kind":"fact","content":""}]}')).toEqual([]);
  });
});
