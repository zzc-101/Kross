import { spawnSync } from 'node:child_process';

export type ClipboardDelivery =
  | 'native'
  | 'tmux'
  | 'osc52';

export interface ClipboardRuntime {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;
  run?: (command: string, args: string[], text: string) => boolean;
}

/**
 * Copy selected TUI text without requiring a command.
 *
 * Local sessions prefer the OS clipboard. SSH falls back to OSC 52 so the
 * user's terminal owns the clipboard; tmux also receives its paste buffer.
 */
export function copyTextToClipboard(
  text: string,
  runtime: ClipboardRuntime = {}
): ClipboardDelivery {
  if (text.length === 0) {
    throw new Error('clipboard text is empty');
  }

  const platform = runtime.platform ?? process.platform;
  const env = runtime.env ?? process.env;
  const stdout = runtime.stdout ?? process.stdout;
  const run = runtime.run ?? runClipboardCommand;
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);

  if (!remote) {
    for (const candidate of nativeClipboardCommands(platform, env)) {
      if (run(candidate.command, candidate.args, text)) {
        // Keep tmux copy-mode users in sync when available; native clipboard
        // success remains authoritative if tmux is absent or rejects input.
        if (env.TMUX) {
          run('tmux', ['load-buffer', '-'], text);
        }
        return 'native';
      }
    }
  }

  if (env.TMUX && run('tmux', ['load-buffer', '-'], text)) {
    if (!remote) {
      return 'tmux';
    }
    // Over SSH also attempt OSC 52 for the client terminal clipboard.
  }

  if (stdout.isTTY) {
    stdout.write(buildOsc52Sequence(text));
    return 'osc52';
  }

  throw new Error('no clipboard backend is available');
}

export function buildOsc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

function nativeClipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): Array<{ command: string; args: string[] }> {
  if (platform === 'darwin') {
    return [{ command: 'pbcopy', args: [] }];
  }
  if (platform === 'win32') {
    return [
      {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-Command',
          'Set-Clipboard -Value ([Console]::In.ReadToEnd())'
        ]
      }
    ];
  }
  if (platform === 'linux') {
    const commands: Array<{ command: string; args: string[] }> = [];
    if (env.WAYLAND_DISPLAY) {
      commands.push({ command: 'wl-copy', args: [] });
    }
    if (env.DISPLAY) {
      commands.push(
        { command: 'xclip', args: ['-selection', 'clipboard'] },
        { command: 'xsel', args: ['--clipboard', '--input'] }
      );
    }
    return commands;
  }
  return [];
}

function runClipboardCommand(
  command: string,
  args: string[],
  text: string
): boolean {
  const result = spawnSync(command, args, {
    input: text,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 2_000,
    windowsHide: true
  });
  return !result.error && result.status === 0;
}
