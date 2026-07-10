import ansiEscapes from 'ansi-escapes';

const BEGIN_SYNCHRONIZED_UPDATE = '\x1b[?2026h';
const END_SYNCHRONIZED_UPDATE = '\x1b[?2026l';
const CURSOR_HOME = '\x1b[H';
const ERASE_LINE = '\x1b[2K';
const ERASE_TO_LINE_END = '\x1b[K';
const RESET_STYLE = '\x1b[0m';

export interface TerminalFrameOutputOptions {
  synchronized?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Claude Code 同类终端能力判断：Ghostty 等使用 DEC 2026 原子提交，
 * Apple Terminal 等不支持环境依赖行差异避免先擦空整个视窗。
 */
export function isSynchronizedOutputSupported(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.TMUX) {
    return false;
  }

  const termProgram = env.TERM_PROGRAM;
  const term = env.TERM;
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true;
  }

  if (term?.includes('kitty') || env.KITTY_WINDOW_ID) {
    return true;
  }
  if (term === 'xterm-ghostty' || term?.startsWith('foot')) {
    return true;
  }
  if (term?.includes('alacritty') || env.ZED_TERM || env.WT_SESSION) {
    return true;
  }

  const vteVersion = Number.parseInt(env.VTE_VERSION ?? '', 10);
  return Number.isFinite(vteVersion) && vteVersion >= 6800;
}

/**
 * 包装 Ink stdout，把默认的「eraseLines + 整帧」转换为一次行差异写入。
 * 代理保留原 stdout 的尺寸、事件和 TTY 属性，Ink 无需感知输出层变化。
 */
export function createTerminalFrameOutput(
  stdout: NodeJS.WriteStream,
  options: TerminalFrameOutputOptions = {}
): NodeJS.WriteStream {
  if (!stdout.isTTY) {
    return stdout;
  }

  const writer = new TerminalFrameWriter(
    stdout,
    options.synchronized ??
      isSynchronizedOutputSupported(options.env ?? process.env)
  );

  return new Proxy(stdout, {
    get(target, property) {
      if (property === 'write') {
        return writer.write;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? value.bind(target)
        : value;
    }
  });
}

class TerminalFrameWriter {
  private previousFrame: string[] | undefined;
  private previousInkLineCount = 0;

  constructor(
    private readonly stdout: NodeJS.WriteStream,
    private readonly synchronized: boolean
  ) {}

  readonly write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean => {
    const text =
      typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk).toString(
            typeof encodingOrCallback === 'string'
              ? encodingOrCallback
              : 'utf8'
          );
    const frame = this.extractFrame(text);
    if (!frame) {
      return forwardWrite(
        this.stdout,
        chunk,
        encodingOrCallback,
        callback
      );
    }

    const patches = renderFrameDiff(
      this.previousFrame,
      frame.lines,
      this.stdout.rows
    );
    this.previousFrame = frame.lines;
    this.previousInkLineCount = frame.inkLineCount;
    if (patches.length === 0) {
      invokeWriteCallback(encodingOrCallback, callback);
      return true;
    }

    const output = this.synchronized
      ? BEGIN_SYNCHRONIZED_UPDATE + patches + END_SYNCHRONIZED_UPDATE
      : patches;
    return forwardWrite(
      this.stdout,
      output,
      encodingOrCallback,
      callback
    );
  };

  private extractFrame(text: string): {
    lines: string[];
    inkLineCount: number;
  } | null {
    let output = text;
    let recognized = this.previousFrame === undefined;

    if (this.previousInkLineCount > 0) {
      const erasePrevious = ansiEscapes.eraseLines(this.previousInkLineCount);
      if (output.startsWith(erasePrevious)) {
        output = output.slice(erasePrevious.length);
        recognized = true;
      }
    }
    if (output.startsWith(ansiEscapes.clearTerminal)) {
      output = output.slice(ansiEscapes.clearTerminal.length);
      recognized = true;
    }

    if (!recognized || !output.includes('\n')) {
      return null;
    }

    const inkLineCount = output.split('\n').length;
    const lines = output.split('\n');
    if (lines.at(-1) === '') {
      lines.pop();
    }
    return { lines, inkLineCount };
  }
}

function renderFrameDiff(
  previous: string[] | undefined,
  next: string[],
  terminalRows: number
): string {
  let output = previous ? '' : CURSOR_HOME;
  const rowCount = Math.max(previous?.length ?? 0, next.length);
  for (let index = 0; index < rowCount; index += 1) {
    const before = previous?.[index];
    const after = next[index] ?? '';
    if (before === after) {
      continue;
    }

    output += cursorTo(index + 1);
    output += after.length > 0
      ? after + RESET_STYLE + ERASE_TO_LINE_END
      : ERASE_LINE;
  }

  if (output.length > 0) {
    output += cursorTo(Math.max(1, terminalRows));
  }
  return output;
}

function cursorTo(row: number): string {
  return `\x1b[${row};1H`;
}

function forwardWrite(
  stdout: NodeJS.WriteStream,
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void
): boolean {
  const write = stdout.write.bind(stdout) as (
    data: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ) => boolean;
  return write(chunk, encodingOrCallback, callback);
}

function invokeWriteCallback(
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void
): void {
  if (typeof encodingOrCallback === 'function') {
    encodingOrCallback(null);
  } else {
    callback?.(null);
  }
}
