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
    // 避免污染 process.stdin：提供假 stdin 给鼠标过滤安装
    const fakeStdin = {
      emit: vi.fn()
    } as unknown as NodeJS.ReadStream;

    enterAlternateScreen(
      { isTTY: true, write: ttyWrite } as unknown as NodeJS.WriteStream,
      fakeStdin
    );
    leaveAlternateScreen({ isTTY: true, write: ttyWrite } as unknown as NodeJS.WriteStream);
    enterAlternateScreen(
      { isTTY: false, write: nonTtyWrite } as unknown as NodeJS.WriteStream,
      fakeStdin
    );
    leaveAlternateScreen({ isTTY: false, write: nonTtyWrite } as unknown as NodeJS.WriteStream);

    expect(ttyWrite).toHaveBeenCalled();
    expect(nonTtyWrite).not.toHaveBeenCalled();
    expect(String(ttyWrite.mock.calls[0]?.[0])).toContain('1049');
    // 仅 1000+1006，不应再启用 1015（会注入无 < 的乱码序列）
    const written = ttyWrite.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('1006');
    expect(written).not.toContain('1015h');
  });
});
