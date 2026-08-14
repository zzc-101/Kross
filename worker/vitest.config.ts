import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'core/src/**/*.test.ts']
  },
  resolve: {
    alias: {
      '@kross/core': new URL('./core/src/index.ts', import.meta.url).pathname
    }
  }
});
