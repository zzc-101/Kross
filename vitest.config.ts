import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('./apps/web/src', import.meta.url).pathname
    }
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx'
    ],
    setupFiles: ['apps/tui/src/test/setup.ts']
  }
});
