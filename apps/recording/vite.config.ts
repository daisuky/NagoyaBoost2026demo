import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const build = new Date().toISOString();
export default defineConfig({
  define: { __APP_BUILD__: JSON.stringify(build) },
  plugins: [react(), {
    name: 'ippo-offline-shell',
    async closeBundle() {
      const files = (await readdir('dist/assets')).filter(f => /\.(js|css)$/.test(f)).sort().map(f => `/assets/${f}`);
      const id = createHash('sha256').update(files.join(',')).digest('hex').slice(0, 12);
      const sw = (await readFile('public/sw.js', 'utf8')).replace('__BUILD_ID__', id).replace('[] /* build-assets */', JSON.stringify(files));
      await writeFile('dist/sw.js', sw);
      await writeFile('dist/version.json', JSON.stringify({ build }));
    }
  }],
  server: { host: '127.0.0.1', strictPort: true, proxy: { '/api': 'http://127.0.0.1:8788' } }
});
