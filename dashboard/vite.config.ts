import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  base: '/dashboard/',
  build: {
    outDir: resolve(__dirname, '../dist/dashboard'),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    port: 4102,
    proxy: {
      '/control': 'http://localhost:4100',
      '/v1': 'http://localhost:4100',
      '/api': 'http://localhost:4100',
    },
  },
});
