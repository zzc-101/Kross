import { describe, expect, it, vi } from 'vitest';

import { buildOsc52Sequence, copyTextToClipboard } from './clipboard';

describe('copyTextToClipboard', () => {
  it('uses the native macOS clipboard locally', () => {
    const run = vi.fn(() => true);
    const write = vi.fn();

    expect(
      copyTextToClipboard('公益模型', {
        platform: 'darwin',
        env: {},
        stdout: { isTTY: true, write },
        run
      })
    ).toBe('native');
    expect(run).toHaveBeenCalledWith('pbcopy', [], '公益模型');
    expect(write).not.toHaveBeenCalled();
  });

  it('uses OSC 52 for an SSH terminal', () => {
    const run = vi.fn(() => false);
    const write = vi.fn();

    expect(
      copyTextToClipboard('远程文本', {
        platform: 'linux',
        env: { SSH_TTY: '/dev/pts/1' },
        stdout: { isTTY: true, write },
        run
      })
    ).toBe('osc52');
    expect(write).toHaveBeenCalledWith(buildOsc52Sequence('远程文本'));
  });

  it('rejects empty text', () => {
    expect(() => copyTextToClipboard('')).toThrow(/empty/);
  });
});
