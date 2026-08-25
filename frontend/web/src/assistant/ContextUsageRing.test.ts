import { describe, expect, it } from 'vitest';

import { compactTokenCount } from './ContextUsageRing';

describe('compactTokenCount', () => {
  it('将上下文 Token 数压缩为适合提示框的格式', () => {
    expect(compactTokenCount(0)).toBe('0');
    expect(compactTokenCount(3_100)).toBe('3.1K');
    expect(compactTokenCount(256_000)).toBe('256K');
    expect(compactTokenCount(1_250_000)).toBe('1.3M');
  });
});
