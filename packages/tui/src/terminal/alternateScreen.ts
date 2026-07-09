/**
 * 进入 / 退出 alternate screen buffer。
 * 全屏 TUI 应用在启动时进入，退出时还原 shell 画面。
 */

import {
  disableMouseTracking,
  enableMouseTracking,
  installMouseInputFilter,
  uninstallMouseInputFilter
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
  stdout: NodeJS.WriteStream = process.stdout,
  stdin: NodeJS.ReadStream = process.stdin
): void {
  if (!stdout.isTTY) {
    return;
  }
  // 必须在 Ink 订阅 stdin 之前安装：否则鼠标 CSI 会泄漏进输入框
  installMouseInputFilter(stdin);
  stdout.write(ENTER_ALT);
  stdout.write(CLEAR_HOME);
  // 滚轮 / 触摸板滑动（仅 1000+1006 SGR，不用 1015）
  enableMouseTracking(stdout);
}

export function leaveAlternateScreen(
  stdout: NodeJS.WriteStream = process.stdout
): void {
  if (!stdout.isTTY) {
    return;
  }
  disableMouseTracking(stdout);
  uninstallMouseInputFilter();
  stdout.write(LEAVE_ALT);
}
