/**
 * 进入 / 退出 alternate screen buffer。
 * 全屏 TUI 应用在启动时进入，退出时还原 shell 画面。
 */

import {
  disableMouseTracking,
  enableMouseTracking
} from './mouseTracking';

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';
const CLEAR_HOME = '\x1b[2J\x1b[H';

export function canUseAlternateScreen(
  stdout: NodeJS.WriteStream = process.stdout,
  stdin: NodeJS.ReadStream = process.stdin
): boolean {
  return Boolean(stdout.isTTY && stdin.isTTY);
}

export function enterAlternateScreen(
  stdout: NodeJS.WriteStream = process.stdout
): void {
  if (!stdout.isTTY) {
    return;
  }
  stdout.write(ENTER_ALT);
  stdout.write(CLEAR_HOME);
  // 滚轮 / 触摸板滑动
  enableMouseTracking(stdout);
}

export function leaveAlternateScreen(
  stdout: NodeJS.WriteStream = process.stdout
): void {
  if (!stdout.isTTY) {
    return;
  }
  disableMouseTracking(stdout);
  stdout.write(LEAVE_ALT);
}
