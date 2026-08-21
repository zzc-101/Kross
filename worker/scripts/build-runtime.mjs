import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { build } from 'esbuild';

const output = process.argv[2] ?? 'build/worker.mjs';
const root = process.cwd();
const outfile = resolve(root, output);

await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minifySyntax: true,
  // Bundle JS dependencies into the worker artifact. Native addons stay
  // external so the image can ship only better-sqlite3 plus system `rg`.
  external: ['better-sqlite3', '@vscode/ripgrep'],
  alias: {
    '@kross/core': resolve(root, 'core/src/index.ts')
  },
  logLevel: 'info'
});
