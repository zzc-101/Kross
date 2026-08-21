import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/admin/' : '/',
  server: {
    port: 4174,
    proxy: { '/api': 'http://localhost:8787' }
  },
  build: { outDir: 'dist', sourcemap: true }
}));
