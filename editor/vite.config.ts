import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);
const pdfjs = dirname(require.resolve('pdfjs-dist/package.json'));
const assets = ['cmaps', 'iccs', 'standard_fonts', 'wasm'];

export default defineConfig({
  build: {
    outDir: 'dist/client',
    rollupOptions: { output: { manualChunks: { pdfjs: ['pdfjs-dist'] } } },
  },
  plugins: [{
    name: 'local-pdfjs-assets',
    apply: 'build',
    async writeBundle({ dir }) {
      if (!dir) throw new Error('Missing Vite output directory');
      await Promise.all(assets.map((asset) =>
        cp(join(pdfjs, asset), join(dir, 'pdfjs', asset), { recursive: true }),
      ));
    },
  }],
});
