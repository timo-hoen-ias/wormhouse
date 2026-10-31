import { defineConfig } from 'vite';

// `npm run dev:hot` startet Vite mit Hot-Reload und leitet /api (WebSockets)
// an `wrangler dev` auf Port 8787 weiter (in zweitem Terminal: `npm run dev:worker`).
export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
});
