import { describe, expect, it, vi } from 'vitest';

import {
  canUseAlternateScreen,
  enterAlternateScreen,
  leaveAlternateScreen
} from './alternateScreen';

describe('alternateScreen', () => {
  it('detects TTY capability', () => {
    expect(
      canUseAlternateScreen(
        { isTTY: true } as NodeJS.WriteStream,
        { isTTY: true } as NodeJS.ReadStream
      )
    ).toBe(true);
    expect(
      canUseAlternateScreen(
        { isTTY: false } as NodeJS.WriteStream,
        { isTTY: true } as NodeJS.ReadStream
      )
    ).toBe(false);
  });

  it('writes enter/leave sequences only for TTY stdout', () => {
    const ttyWrite = vi.fn();
    const nonTtyWrite = vi.fn();

    enterAlternateScreen({ isTTY: true, write: ttyWrite } as unknown as NodeJS.WriteStream);
    leaveAlternateScreen({ isTTY: true, write: ttyWrite } as unknown as NodeJS.WriteStream);
    enterAlternateScreen({ isTTY: false, write: nonTtyWrite } as unknown as NodeJS.WriteStream);
    leaveAlternateScreen({ isTTY: false, write: nonTtyWrite } as unknown as NodeJS.WriteStream);

    expect(ttyWrite).toHaveBeenCalled();
    expect(nonTtyWrite).not.toHaveBeenCalled();
    expect(String(ttyWrite.mock.calls[0]?.[0])).toContain('1049');
  });
});
