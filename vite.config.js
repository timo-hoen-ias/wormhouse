import { defineConfig } from 'vite';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

// Erzeugt nach dem Build dist/sw.js mit der Liste aller Dateien zum Vorab-Cachen
// (offline spielbar). Die Version ist ein Hash über alle Dateien: Jede Änderung
// am Spiel ergibt einen neuen Service Worker, der den alten Cache ersetzt.
function serviceWorker() {
  let outDir = 'dist';
  return {
    name: 'wormhouse-sw',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const files = [];
      const walk = (dir) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(p);
        }
      };
      walk(outDir);
      const hash = createHash('sha256');
      const assets = ['/'];
      for (const p of files.sort()) {
        const url = '/' + relative(outDir, p).split(sep).join('/');
        if (url === '/sw.js' || url === '/index.html' || url.endsWith('.map')) continue;
        assets.push(url);
        hash.update(url).update(readFileSync(p));
      }
      hash.update(readFileSync(join(outDir, 'index.html')));
      const tpl = readFileSync('scripts/sw-template.js', 'utf8');
      const sw = tpl
        .replace('__VERSION__', JSON.stringify(hash.digest('hex').slice(0, 12)))
        .replace('__ASSETS__', JSON.stringify(assets, null, 2));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

// `npm run dev:hot` startet Vite mit Hot-Reload und leitet /api (WebSockets)
// an `wrangler dev` auf Port 8787 weiter (in zweitem Terminal: `npm run dev:worker`).
export default defineConfig({
  plugins: [serviceWorker()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
});
