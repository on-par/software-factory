import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // The board subscribes to a same-origin /events; the factory server (#592) binds
      // 127.0.0.1:8787 and is loopback-only by design (ADR-0034), so proxying in dev keeps
      // its surface unchanged instead of teaching it CORS for the Vite origin.
      '/events': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      // The attach form and Settings screen share factoryd's loopback-only
      // control plane (POST /repos, GET /repos, GET/PUT /repos/<slug>/policy),
      // so the dev server proxies to it rather than teaching it CORS.
      '/repos': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});
