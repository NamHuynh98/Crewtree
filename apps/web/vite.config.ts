import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const SERVER = 'http://127.0.0.1:4317';

/** Dev-only twin of the server's __BOOT__ injection (PLAN.md 11.1): language/theme before React renders. */
function crewtreeBoot(): Plugin {
  return {
    name: 'crewtree-boot',
    apply: 'serve',
    async transformIndexHtml(html) {
      try {
        const boot = (await fetch(`${SERVER}/api/boot`).then((r) => r.json())) as { language: string; theme: string };
        const json = JSON.stringify(boot).replace(/</g, '\\u003c');
        return html
          .replace(/<html lang="[^"]*">/, `<html lang="${boot.language}">`)
          .replace('<head>', `<head>\n    <script>window.__BOOT__ = ${json};</script>`);
      } catch {
        return html; // server not up yet: index.html keeps its defaults
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), crewtreeBoot()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: SERVER,
        changeOrigin: true,
      },
      '/ws': {
        target: SERVER.replace('http', 'ws'),
        ws: true,
      },
      '/auth': {
        target: SERVER,
        changeOrigin: true,
      },
    },
  },
});
