import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

const apiProxyTarget = process.env.VEXALENS_API_URL || 'http://127.0.0.1:3000';
const apiProxy = {
  '/api': {
    target: apiProxyTarget,
    changeOrigin: true,
    timeout: 300_000,
    proxyTimeout: 300_000,
  },
};

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: apiProxy,
    },
    preview: {
      proxy: apiProxy,
    },
  };
});
