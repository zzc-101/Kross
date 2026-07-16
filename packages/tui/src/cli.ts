export type CliAction =
  | { kind: 'run' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

export function parseCliArgs(args: readonly string[]): CliAction {
  if (args.length === 0) {
    return { kind: 'run' };
  }

  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { kind: 'help' };
  }

  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    return { kind: 'version' };
  }

  return {
    kind: 'error',
    message: `Unknown argument: ${args.join(' ')}`
  };
}

export function formatCliHelp(): string {
  return [
    'Kross - local-first terminal coding agent',
    '',
    'Usage:',
    '  kross              Start the interactive TUI in the current directory',
    '  kross --help       Show this help message',
    '  kross --version    Show the installed version',
    '',
    'Options:',
    '  -h, --help         Show help',
    '  -v, --version      Show version'
  ].join('\n');
}
