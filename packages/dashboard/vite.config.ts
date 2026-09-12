import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// packages/server (SSE /events) and factoryd (repo control plane /repos) both default to
// 127.0.0.1:8787, so an operator running both processes can't point both proxy entries at one
// listener. The /repos target is env-overridable for that case; consolidating the two listeners
// is a separate decision for epic #1376.
const FACTORYD_URL = process.env.FACTORYD_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // The board subscribes to a same-origin /events; the factory server (#592) binds
      // 127.0.0.1:8787 and is loopback-only by design (ADR-0034), so proxying in dev keeps
      // its surface unchanged instead of teaching it CORS for the Vite origin.
      '/events': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      // The repo lifecycle panel talks to factoryd's /repos control plane, which is also
      // loopback-only by design (ADR-0034) — proxy it here instead of teaching factoryd CORS.
      '/repos': { target: FACTORYD_URL, changeOrigin: false },
    },
  },
});
