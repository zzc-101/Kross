import {
  HEADLESS_SCHEMA_VERSION,
  headlessExecRequestSchema,
  type HeadlessExecRequest
} from './headless/contract';

export type CliAction =
  | { kind: 'run' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'exec-help' }
  | { kind: 'exec'; request: HeadlessExecRequest }
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

  if (args[0] === 'exec') {
    return parseExecArgs(args.slice(1));
  }

  return {
    kind: 'error',
    message: `Unknown argument: ${args.join(' ')}`
  };
}

function parseExecArgs(args: readonly string[]): CliAction {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { kind: 'exec-help' };
  }

  let task: string | undefined;
  let stdin = false;
  let json = false;
  let mode: HeadlessExecRequest['mode'] = 'auto';
  let permission: HeadlessExecRequest['permission'] = 'default';
  let cwd: string | undefined;
  let sessionId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--stdin') {
      if (stdin) return cliError('--stdin can only be provided once');
      stdin = true;
      continue;
    }
    if (value === '--json') {
      if (json) return cliError('--json can only be provided once');
      json = true;
      continue;
    }
    if (
      value === '--mode' ||
      value === '--permission' ||
      value === '--cwd' ||
      value === '--session'
    ) {
      const optionValue = args[index + 1];
      if (!optionValue) {
        return cliError(`${value} requires a value`);
      }
      index += 1;
      if (value === '--mode') {
        if (!['auto', 'plan', 'conductor'].includes(optionValue)) {
          return cliError(`Unsupported mode: ${optionValue}`);
        }
        mode = optionValue as HeadlessExecRequest['mode'];
      } else if (value === '--permission') {
        if (!['default', 'classifier', 'auto'].includes(optionValue)) {
          return cliError(`Unsupported permission: ${optionValue}`);
        }
        permission = optionValue as HeadlessExecRequest['permission'];
      } else if (value === '--cwd') {
        cwd = optionValue;
      } else {
        sessionId = optionValue;
      }
      continue;
    }
    if (value?.startsWith('-')) {
      return cliError(`Unknown exec option: ${value}`);
    }
    if (task !== undefined) {
      return cliError('exec accepts exactly one task argument');
    }
    task = value;
  }

  if (!json) {
    return cliError('exec currently requires --json');
  }
  if (stdin && task !== undefined) {
    return cliError('use either a task argument or --stdin, not both');
  }
  if (!stdin && !task) {
    return cliError('exec requires a task argument or --stdin');
  }

  return {
    kind: 'exec',
    request: headlessExecRequestSchema.parse({
      schemaVersion: HEADLESS_SCHEMA_VERSION,
      input: stdin ? { source: 'stdin' } : { source: 'argument', task },
      mode,
      permission,
      cwd,
      sessionId,
      json: true
    })
  };
}

function cliError(message: string): CliAction {
  return { kind: 'error', message };
}

export function formatCliHelp(): string {
  return [
    'Kross - local-first terminal coding agent',
    '',
    'Usage:',
    '  kross              Start the interactive TUI in the current directory',
    '  kross exec ...     Run one non-interactive task as NDJSON',
    '  kross --help       Show this help message',
    '  kross --version    Show the installed version',
    '',
    'Options:',
    '  -h, --help         Show help',
    '  -v, --version      Show version'
  ].join('\n');
}

export function formatExecHelp(): string {
  return [
    'Kross headless execution',
    '',
    'Usage:',
    '  kross exec "<task>" --json [options]',
    '  kross exec --stdin --json [options]',
    '',
    'Options:',
    '  --mode auto|plan|conductor',
    '  --permission default|classifier|auto',
    '  --cwd <path>',
    '  --session <id>',
    '  --stdin',
    '  --json',
    '  -h, --help'
  ].join('\n');
}
