import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import ansiEscapes from 'ansi-escapes';
import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App, type AppTestApi } from '../App';
import { createTerminalFrameOutput } from '../terminal/frameOutput';

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
});

describe('fullscreen output', () => {
  it('does not clear the whole terminal on initial render or input updates', async () => {
    const processWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stdout = new FakeStdout(80, 24);
    const frameOutput = createTerminalFrameOutput(
      stdout as unknown as NodeJS.WriteStream,
      { synchronized: false }
    );
    const stdin = new FakeStdin();
    let api: AppTestApi | undefined;
    const instance = render(
      <App fullscreen onReady={(value) => (api = value)} />,
      {
        stdout: frameOutput,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false
      }
    );
    cleanup.push(() => {
      instance.unmount();
      processWrite.mockRestore();
    });

    await waitFor(() => api !== undefined);
    stdout.writes.length = 0;
    api?.setInput('触摸板滚动测试');
    await waitFor(() => stdout.writes.length > 0);

    expect(stdout.writes.length).toBeGreaterThan(0);
    expect(
      stdout.writes.some((chunk) => chunk.includes(ansiEscapes.clearTerminal))
    ).toBe(false);
    expect(
      stdout.writes.some((chunk) => chunk.includes(ansiEscapes.eraseLines(24)))
    ).toBe(false);
  });
});

class FakeStdout extends EventEmitter {
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
}

class FakeStdin extends PassThrough {
  readonly isTTY = true;

  setRawMode(): this {
    return this;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitFor timed out');
    }
    await delay(10);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
