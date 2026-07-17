import { createHash } from 'node:crypto';

export type VerificationKind = 'test' | 'typecheck' | 'build' | 'lint';

export interface VerificationCommandIdentity {
  label: string;
  kinds: VerificationKind[];
  fingerprint: string;
}

const COMMAND_PREFIX =
  String.raw`(?:^|(?:&&|\|\||;|\|)\s*)(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*`;

export function fingerprintCommand(command: string): string {
  return createHash('sha256')
    .update(command.trim().replace(/\s+/g, ' '))
    .digest('hex');
}

/** Return a bounded, argument-safe identity for recognized verification commands. */
export function identifyVerificationCommand(
  command: string
): VerificationCommandIdentity | undefined {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (!normalized || hasStatusMaskingOperator(command)) return undefined;

  const matches: Array<{ label: string; kind: VerificationKind }> = [];
  collectPackageManagerChecks(normalized, matches);
  collectKnownChecks(normalized, matches);

  const unique = matches.filter(
    (match, index) =>
      matches.findIndex(
        (candidate) =>
          candidate.label === match.label && candidate.kind === match.kind
      ) === index
  );
  if (unique.length === 0) return undefined;

  return {
    label: unique.map((match) => match.label).join(' && ').slice(0, 240),
    kinds: [...new Set(unique.map((match) => match.kind))],
    fingerprint: fingerprintCommand(command)
  };
}

/**
 * Verification relies on the shell command's final exit status. Reject control
 * operators that can replace or detach the check's status; quoted characters
 * remain ordinary arguments. `&&` is safe because later commands run only when
 * every earlier command succeeded.
 */
function hasStatusMaskingOperator(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ';' || char === '|' || char === '\n' || char === '\r') {
      return true;
    }
    if (char === '&' && command[index + 1] === '&') {
      index += 1;
      continue;
    }
    if (
      char === '&' &&
      command[index - 1] !== '>' &&
      command[index + 1] !== '>'
    ) {
      return true;
    }
  }
  return false;
}

/** 从用户输入中提取明确要求执行的验证命令；普通讨论命令名称不会触发。 */
export function identifyRequestedVerificationCommand(
  input: string
): VerificationCommandIdentity | undefined {
  if (/(?:如何|怎么|怎样)(?:运行|执行|跑)|\bhow\s+to\s+run\b/i.test(input)) {
    return undefined;
  }
  const direct = identifyVerificationCommand(input);
  if (direct) return direct;

  const imperative = /(?:请|帮我)?(?:运行|执行|跑一下|跑|验证)|\brun\b/gi;
  for (const match of input.matchAll(imperative)) {
    const tail = input.slice((match.index ?? 0) + match[0].length).trim();
    const fenced = /^[:：\s]*[`'"]([^`'"]+)[`'"]/.exec(tail)?.[1];
    const line = tail.replace(/^[:：\s]+/, '').split(/\r?\n/, 1)[0];
    const identified = identifyVerificationCommand(fenced ?? line ?? '');
    if (identified) return identified;
  }
  return undefined;
}

function collectPackageManagerChecks(
  command: string,
  out: Array<{ label: string; kind: VerificationKind }>
): void {
  const scriptPattern = new RegExp(
    `${COMMAND_PREFIX}(npm|pnpm|yarn|bun)\\s+(?:run\\s+)?([A-Za-z0-9:_-]+)\\b`,
    'gi'
  );
  for (const match of command.matchAll(scriptPattern)) {
    const manager = match[1]?.toLowerCase();
    const script = match[2]?.toLowerCase();
    if (!manager || !script) continue;
    const kind = scriptKind(script);
    if (!kind) continue;
    const run = manager === 'yarn' || manager === 'bun' ? '' : 'run ';
    out.push({
      label:
        script === 'test' ? `${manager} test` : `${manager} ${run}${script}`,
      kind
    });
  }
}

function collectKnownChecks(
  command: string,
  out: Array<{ label: string; kind: VerificationKind }>
): void {
  const checks: Array<[string, string, VerificationKind]> = [
    [String.raw`(?:npx\s+)?vitest\b`, 'vitest', 'test'],
    [String.raw`(?:npx\s+)?jest\b`, 'jest', 'test'],
    [String.raw`(?:npx\s+)?tsc\b[^;&|]*--noEmit\b`, 'tsc --noEmit', 'typecheck'],
    [String.raw`(?:npx\s+)?eslint\b`, 'eslint', 'lint'],
    [String.raw`(?:pytest|python(?:3)?\s+-m\s+pytest)\b`, 'pytest', 'test'],
    [String.raw`go\s+test\b`, 'go test', 'test'],
    [String.raw`cargo\s+test\b`, 'cargo test', 'test'],
    [String.raw`(?:mvn|mvnw|\.\/mvnw)\s+(?:test|verify)\b`, 'maven test', 'test'],
    [String.raw`(?:gradle|gradlew|\.\/gradlew)\s+[^;&|]*\btest\b`, 'gradle test', 'test'],
    [String.raw`dotnet\s+test\b`, 'dotnet test', 'test'],
    [String.raw`swift\s+test\b`, 'swift test', 'test'],
    [String.raw`make\s+(?:test|check)\b`, 'make test', 'test']
  ];
  for (const [body, label, kind] of checks) {
    if (new RegExp(`${COMMAND_PREFIX}${body}`, 'i').test(command)) {
      out.push({ label, kind });
    }
  }
}

function scriptKind(script: string): VerificationKind | undefined {
  if (/^(?:test|test[:_-])/.test(script)) return 'test';
  if (/^(?:typecheck|type-check|check:types|check-types)$/.test(script)) {
    return 'typecheck';
  }
  if (/^(?:build|build[:_-]|package:check|package-check)/.test(script)) {
    return 'build';
  }
  if (/^(?:lint|lint[:_-])/.test(script)) return 'lint';
  return undefined;
}
