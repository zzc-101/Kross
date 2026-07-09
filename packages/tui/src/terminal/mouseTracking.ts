/**
 * 终端鼠标/触控板滚动上报。
 * 启用 SGR 鼠标模式后，滚轮与 Mac 触摸板滑动会以 CSI 序列进入 stdin。
 *
 * 序列示例（SGR）：
 *   上滚 ESC[<64;col;rowM
 *   下滚 ESC[<65;col;rowM
 */

const ENABLE_MOUSE =
  // 基础按键上报 + SGR 坐标格式 + 扩展滚轮
  '\x1b[?1000h\x1b[?1006h\x1b[?1015h';
const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1006l\x1b[?1015l';

export type ScrollDirection = 'up' | 'down';

export interface WheelEvent {
  direction: ScrollDirection;
  /** 本次事件建议滚动行数（触控板可能连续多帧，每帧 1 步） */
  steps: number;
  col: number;
  row: number;
}

export function enableMouseTracking(
  stdout: NodeJS.WriteStream = process.stdout
): void {
  if (!stdout.isTTY) {
    return;
  }
  stdout.write(ENABLE_MOUSE);
}

export function disableMouseTracking(
  stdout: NodeJS.WriteStream = process.stdout
): void {
  if (!stdout.isTTY) {
    return;
  }
  stdout.write(DISABLE_MOUSE);
}

/**
 * 从 stdin chunk 中解析滚轮事件，返回事件列表与剔除鼠标序列后的剩余文本。
 * 剩余文本可忽略（Ink 自己也会收到同一 chunk）；我们主要用事件驱动滚动。
 */
export function parseMouseWheelChunk(chunk: string): {
  events: WheelEvent[];
  rest: string;
} {
  const events: WheelEvent[] = [];
  // SGR：CSI < btn ; x ; y M/m
  const sgr = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let rest = chunk;
  let match: RegExpExecArray | null;

  const matches: Array<{ start: number; end: number; event: WheelEvent | null }> =
    [];

  while ((match = sgr.exec(chunk)) !== null) {
    const button = Number(match[1]);
    const col = Number(match[2]);
    const row = Number(match[3]);
    const event = wheelFromButton(button, col, row);
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      event
    });
  }

  // 旧版 X10：ESC [ M Cb Cx Cy（各 1 字节，值 = 坐标/按钮 + 32）
  const x10 = /\x1b\[M([\s\S])([\s\S])([\s\S])/g;
  while ((match = x10.exec(chunk)) !== null) {
    // 跳过已落在 SGR 内的
    const start = match.index;
    if (matches.some((m) => start >= m.start && start < m.end)) {
      continue;
    }
    const cb = (match[1] ?? ' ').charCodeAt(0) - 32;
    const col = (match[2] ?? ' ').charCodeAt(0) - 32;
    const row = (match[3] ?? ' ').charCodeAt(0) - 32;
    const event = wheelFromButton(cb, col, row);
    matches.push({
      start,
      end: start + match[0].length,
      event
    });
  }

  matches.sort((a, b) => a.start - b.start);
  let cursor = 0;
  let cleaned = '';
  for (const m of matches) {
    cleaned += chunk.slice(cursor, m.start);
    if (m.event) {
      events.push(m.event);
    }
    cursor = m.end;
  }
  cleaned += chunk.slice(cursor);
  rest = cleaned;

  return { events, rest };
}

function wheelFromButton(
  button: number,
  col: number,
  row: number
): WheelEvent | null {
  // 去掉 shift/meta/ctrl 修饰（4/8/16），保留滚轮基准码
  // SGR：64=上滚 65=下滚；旧式部分终端用 4/5
  const base = button & ~0x1c;
  if (base === 64 || base === 4) {
    return { direction: 'up', steps: 1, col, row };
  }
  if (base === 65 || base === 5) {
    return { direction: 'down', steps: 1, col, row };
  }
  // 66/67 横向滚轮，忽略
  return null;
}
