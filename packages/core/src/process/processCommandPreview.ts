const DEFAULT_COMMAND_PREVIEW_CHARS = 160;

/**
 * Build a bounded, approval-friendly command shape without retaining argument
 * values. Commands, option names and inline environment keys are useful for
 * review; positional arguments and option values may contain credentials.
 */
export function formatProcessCommandPreview(
  command: string,
  maxChars = DEFAULT_COMMAND_PREVIEW_CHARS
): string {
  const tokens = tokenizeCommand(command);
  const commands: string[] = [];
  const flags: string[] = [];
  const envKeys: string[] = [];
  let argumentCount = 0;
  let expectsCommand = true;

  for (const token of tokens) {
    if (isCommandSeparator(token)) {
      expectsCommand = true;
      continue;
    }
    if (isShellOperator(token)) continue;

    if (expectsCommand) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token);
      if (assignment) {
        if (envKeys.length < 4) envKeys.push(`${assignment[1]}=…`);
        continue;
      }
      commands.push(safeExecutableName(token));
      expectsCommand = false;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      if (flags.length < 8) flags.push(safeFlagName(token));
    } else {
      argumentCount += 1;
    }
  }

  const shape = [
    ...envKeys,
    commands.length > 0 ? commands.slice(0, 4).join(' → ') : 'command',
    ...flags
  ].join(' ');
  const argumentLabel = `${argumentCount} arg${argumentCount === 1 ? '' : 's'}`;
  return truncate(
    `$ ${shape} · ${argumentLabel} · ${command.length} chars`,
    Math.max(24, maxChars)
  );
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = () => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      if (char === '\n' || char === '\r') tokens.push(';');
      continue;
    }
    if ('|&;<>'.includes(char)) {
      flush();
      const next = command[index + 1];
      if (next === char || (char === '>' && next === '>')) {
        tokens.push(`${char}${next}`);
        index += 1;
      } else {
        tokens.push(char);
      }
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

function isCommandSeparator(token: string): boolean {
  return token === '|' || token === '||' || token === '&&' || token === ';';
}

function isShellOperator(token: string): boolean {
  return token === '&' || token === '<' || token === '>' || token === '>>';
}

function safeExecutableName(token: string): string {
  const leaf = token.split(/[\\/]/).pop() || 'command';
  const safe = leaf.replace(/[^A-Za-z0-9._+-]/g, '');
  return safe.length > 0 ? truncate(safe, 40) : 'command';
}

function safeFlagName(token: string): string {
  if (!token.startsWith('--') && token.length > 2) {
    const shortOption = token.slice(0, 2).replace(/[^A-Za-z0-9._+-]/g, '');
    return `${shortOption || '-'}…`;
  }
  const name = token.startsWith('--') ? (token.split('=', 1)[0] ?? '--') : token;
  const safe = name.replace(/[^A-Za-z0-9._+-]/g, '');
  return safe.length > 0 ? truncate(safe, 40) : '-';
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}
