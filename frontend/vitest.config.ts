import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    server: {
      deps: {
        inline: [/antd/, /@ant-design/]
      }
    },
    include: ['web/**/*.test.ts', 'web/**/*.test.tsx', 'admin-web/**/*.test.ts', 'admin-web/**/*.test.tsx']
  }
});
