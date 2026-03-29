import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildId = new Date().toISOString();

export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(buildId)
  },
  plugins: [react()],
  server: {
    port: 4173
  }
});
