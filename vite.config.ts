import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Relative base so the static build works from any GitHub Pages sub-path.
// Two pages: the game (index.html) and the Georgetown world preview (preview.html, free-fly camera + perf hooks).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        preview: resolve(import.meta.dirname, 'preview.html'),
      },
    },
  },
});
