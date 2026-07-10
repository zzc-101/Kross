import { EventEmitter } from 'node:events';

import ansiEscapes from 'ansi-escapes';
import { describe, expect, it } from 'vitest';

import {
  createTerminalFrameOutput,
  isSynchronizedOutputSupported
} from './frameOutput';

describe('terminal frame output', () => {
  it('detects Ghostty synchronized output without enabling it for Terminal.app', () => {
    expect(
      isSynchronizedOutputSupported({
        TERM_PROGRAM: 'ghostty',
        TERM: 'xterm-ghostty'
      })
    ).toBe(true);
    expect(
      isSynchronizedOutputSupported({
        TERM_PROGRAM: 'Apple_Terminal',
        TERM: 'xterm-256color'
      })
    ).toBe(false);
  });

  it('updates only changed rows when synchronized output is unavailable', () => {
    const target = new RecordingStdout(80, 24);
    const output = createTerminalFrameOutput(target.asWriteStream(), {
      synchronized: false
    });

    output.write('header\nold body\nfooter\n');
    target.writes.length = 0;
    output.write(
      ansiEscapes.eraseLines(4) + 'header\nnew body\nfooter\n'
    );

    expect(target.writes).toHaveLength(1);
    expect(target.writes[0]).toContain('\x1b[2;1H');
    expect(target.writes[0]).toContain('new body');
    expect(target.writes[0]).not.toContain('header');
    expect(target.writes[0]).not.toContain(ansiEscapes.eraseLines(4));
  });

  it('keeps the logical previous frame when Ink prefixes clearTerminal', () => {
    const target = new RecordingStdout(80, 24);
    const output = createTerminalFrameOutput(target.asWriteStream(), {
      synchronized: false
    });

    output.write(
      ansiEscapes.clearTerminal + 'header\nold body\nfooter'
    );
    target.writes.length = 0;
    output.write(
      ansiEscapes.clearTerminal + 'header\nnew body\nfooter'
    );

    expect(target.writes).toHaveLength(1);
    expect(target.writes[0]).toContain('new body');
    expect(target.writes[0]).not.toContain('header');
    expect(target.writes[0]).not.toContain(ansiEscapes.clearTerminal);
  });

  it('commits a supported terminal frame inside one synchronized write', () => {
    const target = new RecordingStdout(80, 24);
    const output = createTerminalFrameOutput(target.asWriteStream(), {
      synchronized: true
    });

    output.write('header\nbody\nfooter\n');

    expect(target.writes).toHaveLength(1);
    expect(target.writes[0]).toMatch(/^\x1b\[\?2026h/);
    expect(target.writes[0]).toMatch(/\x1b\[\?2026l$/);
  });
});

class RecordingStdout extends EventEmitter {
  readonly writes: string[] = [];
  readonly isTTY = true;

  constructor(
    readonly columns: number,
    readonly rows: number
  ) {
    super();
  }

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(String(chunk));
    return true;
  }

  asWriteStream(): NodeJS.WriteStream {
    return this as unknown as NodeJS.WriteStream;
  }
}
