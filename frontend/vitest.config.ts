import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['web/**/*.test.ts', 'web/**/*.test.tsx', 'admin-web/**/*.test.ts', 'admin-web/**/*.test.tsx']
  }
});
