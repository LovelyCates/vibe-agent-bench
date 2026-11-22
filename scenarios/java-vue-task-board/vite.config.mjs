import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./frontend/', import.meta.url)),
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5180,
    proxy: {
      '/api': process.env.TASK_BOARD_API_URL ?? 'http://127.0.0.1:8180',
    },
  },
});
