/**
 * 终端鼠标/触控板滚动上报。
 *
 * 启用 1002 + 1006（SGR）后，滚轮事件形如：
 *   ESC [ < 64 ; col ; row M
 *
 * 注意：不要启用 1015（urxvt）。它会发无 `<` 的 CSI（如 ESC[98;60;21M），
 * 若未从 stdin 剥离，ESC 被消费后就会变成输入框乱码 `[98;60;21M`。
 *
 * 所有鼠标 CSI 必须在进入 Ink 之前从 stdin 滤掉；useMouseScroll 只订阅
 * 过滤层发出的滚轮事件。
 */

const ENABLE_MOUSE =
  // 按键 + 按住左键时的 motion + SGR 坐标。不启用 1003/1015。
  '\x1b[?1002h\x1b[?1006h';
const DISABLE_MOUSE =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l';

export type ScrollDirection = 'up' | 'down';

export interface WheelEvent {
  direction: ScrollDirection;
  /** 本次事件建议滚动行数（触控板可能连续多帧，每帧 1 步） */
  steps: number;
  col: number;
  row: number;
}

export type WheelListener = (event: WheelEvent) => void;

/** 左键单击（不含拖拽/滚轮） */
export interface MouseClickEvent {
  col: number;
  row: number;
}

export type ClickListener = (event: MouseClickEvent) => void;

/** 左键手势；drag 仅在按钮按住时由 1002 模式上报。 */
export interface MousePointerEvent {
  phase: 'down' | 'drag' | 'up';
  col: number;
  row: number;
}

export type PointerListener = (event: MousePointerEvent) => void;

const wheelListeners = new Set<WheelListener>();
const clickListeners = new Set<ClickListener>();
const pointerListeners = new Set<PointerListener>();

let filterInstalled = false;
let pendingCarry = '';
let originalEmit: ((event: string | symbol, ...args: unknown[]) => boolean) | null =
  null;
let filteredStdin: NodeJS.ReadStream | null = null;
let leftGesture:
  | { col: number; row: number; dragged: boolean }
  | undefined;

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

/** 订阅滚轮事件（由 stdin 过滤层分发）。 */
export function subscribeWheel(listener: WheelListener): () => void {
  wheelListeners.add(listener);
  return () => {
    wheelListeners.delete(listener);
  };
}

/** 订阅左键单击（展开 thinking 等）。 */
export function subscribeClick(listener: ClickListener): () => void {
  clickListeners.add(listener);
  return () => {
    clickListeners.delete(listener);
  };
}

/** 订阅左键 down/drag/up，用于 TUI 内文本选择。 */
export function subscribePointer(listener: PointerListener): () => void {
  pointerListeners.add(listener);
  return () => {
    pointerListeners.delete(listener);
  };
}

/**
 * 在 Ink 启动前安装：拦截 stdin data，剥离鼠标 CSI，再把剩余字节交给 Ink。
 * 返回卸载函数。
 */
export function installMouseInputFilter(
  stdin: NodeJS.ReadStream = process.stdin
): () => void {
  if (filterInstalled && filteredStdin === stdin) {
    return uninstallMouseInputFilter;
  }
  if (filterInstalled) {
    uninstallMouseInputFilter();
  }

  filteredStdin = stdin;
  pendingCarry = '';
  originalEmit = stdin.emit.bind(stdin) as (
    event: string | symbol,
    ...args: unknown[]
  ) => boolean;

  const emit = originalEmit;
  stdin.emit = function patchedEmit(
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event === 'data' && args[0] != null) {
      const raw = args[0];
      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : String(raw);

      if (!pendingCarry && !text.includes('\x1b') && !looksLikeMouseResidue(text)) {
        return emit(event, ...args);
      }

      const { events, pointers, rest, carry } = filterMouseSequences(
        pendingCarry + text
      );
      pendingCarry = carry;

      for (const wheel of events) {
        for (const listener of wheelListeners) {
          try {
            listener(wheel);
          } catch (error) {
            console.error('[mouseTracking] wheel listener failed:', error);
          }
        }
      }
      for (const pointer of pointers) {
        for (const listener of pointerListeners) {
          try {
            listener(pointer);
          } catch (error) {
            console.error('[mouseTracking] pointer listener failed:', error);
          }
        }
        dispatchClickFromPointer(pointer);
      }

      if (rest.length === 0) {
        // 整段都是鼠标序列，不向下游传递
        return false;
      }

      if (typeof raw === 'string') {
        return emit(event, rest);
      }
      return emit(event, Buffer.from(rest, 'utf8'));
    }
    return emit(event, ...args);
  } as typeof stdin.emit;

  filterInstalled = true;
  return uninstallMouseInputFilter;
}

export function uninstallMouseInputFilter(): void {
  if (!filterInstalled || !filteredStdin || !originalEmit) {
    filterInstalled = false;
    pendingCarry = '';
    originalEmit = null;
    filteredStdin = null;
    leftGesture = undefined;
    return;
  }
  filteredStdin.emit = originalEmit as typeof filteredStdin.emit;
  filterInstalled = false;
  pendingCarry = '';
  originalEmit = null;
  filteredStdin = null;
  leftGesture = undefined;
}

/**
 * 从 chunk 中解析滚轮事件，并剔除全部鼠标序列（含非滚轮点击/拖拽）。
 * carry：跨 chunk 未完成的 CSI 前缀。
 */
export function filterMouseSequences(chunk: string): {
  events: WheelEvent[];
  pointers: MousePointerEvent[];
  rest: string;
  carry: string;
} {
  const events: WheelEvent[] = [];
  const pointers: MousePointerEvent[] = [];
  let rest = '';
  let i = 0;

  while (i < chunk.length) {
    if (chunk[i] !== '\x1b') {
      rest += chunk[i];
      i += 1;
      continue;
    }

    const parsed = tryParseMouseAt(chunk, i);
    if (parsed.kind === 'incomplete') {
      return { events, pointers, rest, carry: chunk.slice(i) };
    }
    if (parsed.kind === 'mouse') {
      if (parsed.event) {
        events.push(parsed.event);
      }
      if (parsed.pointer) {
        pointers.push(parsed.pointer);
      }
      i = parsed.end;
      continue;
    }

    // 普通 ESC 序列，原样保留（交给 Ink 处理）
    rest += chunk[i];
    i += 1;
  }

  return { events, pointers, rest, carry: '' };
}

/**
 * 输入框兜底：清掉已泄漏的鼠标残片（ESC 被吃掉后的 `[98;60;21M` 等）。
 * 仅匹配高置信度模式，避免误伤正常输入。
 */
export function stripMouseArtifactsFromInput(value: string): string {
  return value
    .replace(/\x1b\[<?\d+;\d+;\d+[Mm]/g, '')
    .replace(/\[<\d+;\d+;\d+[Mm]/g, '')
    .replace(/\[\d{1,3};\d{1,3};\d{1,3}[Mm]/g, '');
}

function looksLikeMouseResidue(text: string): boolean {
  return /\[<?\d+;\d+;\d+[Mm]/.test(text);
}

type ParseResult =
  | { kind: 'incomplete' }
  | { kind: 'not-mouse' }
  | {
      kind: 'mouse';
      end: number;
      event: WheelEvent | null;
      pointer: MousePointerEvent | null;
    };

function tryParseMouseAt(chunk: string, start: number): ParseResult {
  // ESC [
  if (chunk[start] !== '\x1b' || chunk[start + 1] !== '[') {
    return { kind: 'not-mouse' };
  }

  // X10：ESC [ M Cb Cx Cy
  if (chunk[start + 2] === 'M') {
    if (chunk.length < start + 6) {
      return { kind: 'incomplete' };
    }
    const cb = chunk.charCodeAt(start + 3) - 32;
    const col = chunk.charCodeAt(start + 4) - 32;
    const row = chunk.charCodeAt(start + 5) - 32;
    const parsed = mouseFromButton(cb, col, row, false);
    return {
      kind: 'mouse',
      end: start + 6,
      event: parsed.wheel,
      pointer: parsed.pointer
    };
  }

  // SGR / urxvt 风格：ESC [ <opt btn ; x ; y M/m
  let j = start + 2;
  let hasLt = false;
  if (chunk[j] === '<') {
    hasLt = true;
    j += 1;
  }

  const numStart = j;
  // 需要完整 btn;x;y + final
  while (j < chunk.length && /[0-9;]/.test(chunk[j] ?? '')) {
    j += 1;
  }

  if (j >= chunk.length) {
    // 仍在数字/分号中，或尚无 final byte
    return { kind: 'incomplete' };
  }

  const final = chunk[j];
  if (final !== 'M' && final !== 'm') {
    return { kind: 'not-mouse' };
  }

  const body = chunk.slice(numStart, j);
  const parts = body.split(';');
  if (parts.length !== 3) {
    // 其它 CSI（如颜色 0;31;40m 也可能三参数小写 m）
    // 带 < 的几乎一定是 SGR 鼠标；无 < 且 final 为 M 也当鼠标
    if (!hasLt && final === 'm') {
      return { kind: 'not-mouse' };
    }
    if (parts.length < 3) {
      return { kind: 'not-mouse' };
    }
  }

  const button = Number(parts[0]);
  const col = Number(parts[1]);
  const row = Number(parts[2]);
  if (![button, col, row].every((n) => Number.isFinite(n))) {
    return { kind: 'not-mouse' };
  }

  // 无 < 且小写 m：更像 SGR 颜色，放行
  if (!hasLt && final === 'm') {
    return { kind: 'not-mouse' };
  }

  const isRelease = final === 'm';
  const parsed = mouseFromButton(button, col, row, isRelease);
  return {
    kind: 'mouse',
    end: j + 1,
    event: parsed.wheel,
    pointer: parsed.pointer
  };
}

function mouseFromButton(
  button: number,
  col: number,
  row: number,
  isRelease: boolean
): { wheel: WheelEvent | null; pointer: MousePointerEvent | null } {
  const motion = (button & 32) !== 0;
  // 去掉 shift/meta/ctrl（4/8/16）与 motion bit(32)，保留滚轮/按键基准码
  const base = button & ~0x3c;
  // SGR：64=上滚 65=下滚；旧式 4/5
  if (base === 64 || base === 4) {
    return {
      wheel: { direction: 'up', steps: 1, col, row },
      pointer: null
    };
  }
  if (base === 65 || base === 5) {
    return {
      wheel: { direction: 'down', steps: 1, col, row },
      pointer: null
    };
  }
  if (base === 0) {
    return {
      wheel: null,
      pointer: {
        phase: isRelease ? 'up' : motion ? 'drag' : 'down',
        col,
        row
      }
    };
  }
  // X10 release encodes button=3 and has no separate lowercase final byte.
  if (base === 3) {
    return { wheel: null, pointer: { phase: 'up', col, row } };
  }
  return { wheel: null, pointer: null };
}

function dispatchClickFromPointer(pointer: MousePointerEvent): void {
  if (pointer.phase === 'down') {
    leftGesture = { col: pointer.col, row: pointer.row, dragged: false };
    return;
  }
  if (!leftGesture) {
    return;
  }
  if (pointer.phase === 'drag') {
    leftGesture.dragged = true;
    return;
  }

  const gesture = leftGesture;
  leftGesture = undefined;
  if (gesture.dragged) {
    return;
  }
  const click = { col: pointer.col, row: pointer.row };
  for (const listener of clickListeners) {
    try {
      listener(click);
    } catch (error) {
      console.error('[mouseTracking] click listener failed:', error);
    }
  }
}
