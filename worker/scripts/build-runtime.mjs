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
  // Bundle JS dependencies into the worker artifact. System `rg` is on PATH
  // in the image, so @vscode/ripgrep stays external.
  external: ['@vscode/ripgrep'],
  alias: {
    '@kross/core': resolve(root, 'core/src/index.ts')
  },
  logLevel: 'info'
});
