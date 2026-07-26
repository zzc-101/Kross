#!/usr/bin/env node
import { runServerMigrations } from './serverMigrations';

const parsed = parseArgs(process.argv.slice(2));
if ('error' in parsed) {
  console.error(parsed.error);
  process.exitCode = 2;
} else if (parsed.help) {
  console.log(formatHelp());
} else {
  const report = await runServerMigrations(parsed);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode =
    report.status === 'blocked' || report.status === 'rolled-back' ? 1 : 0;
}

function parseArgs(args: readonly string[]):
  | { help: true }
  | { apply: boolean; dataDir?: string; help?: false }
  | { error: string } {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { help: true };
  }
  let apply = false;
  let dryRun = false;
  let dataDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--apply') {
      if (apply) return { error: '--apply can only be provided once' };
      apply = true;
      continue;
    }
    if (value === '--dry-run') {
      if (dryRun) return { error: '--dry-run can only be provided once' };
      dryRun = true;
      continue;
    }
    if (value === '--data-dir') {
      const next = args[index + 1];
      if (!next) return { error: '--data-dir requires a value' };
      if (dataDir) return { error: '--data-dir can only be provided once' };
      dataDir = next;
      index += 1;
      continue;
    }
    return { error: `unknown cloud migration option: ${value}` };
  }
  if (apply && dryRun) {
    return { error: 'use either --apply or --dry-run, not both' };
  }
  return { apply, ...(dataDir ? { dataDir } : {}) };
}

function formatHelp(): string {
  return [
    'Kross Cloud control-plane migration',
    '',
    'Stop the Gateway before applying migrations.',
    '',
    'Usage:',
    '  node dist/server-migrate.mjs [--dry-run] [--data-dir <path>]',
    '  node dist/server-migrate.mjs --apply [--data-dir <path>]',
    '',
    'Options:',
    '  --dry-run          Plan only; this is the default',
    '  --apply            Back up, apply atomically, and roll back on failure',
    '  --data-dir <path>  Override KROSS_SERVER_DATA',
    '  -h, --help'
  ].join('\n');
}
