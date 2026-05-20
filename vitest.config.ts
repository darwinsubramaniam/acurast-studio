import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  resolve: {
    conditions: ['browser'],
  },
  plugins: [
    svelte({
      preprocess: [],           // Svelte 5 handles TS natively — skip svelte-preprocess
      compilerOptions: { runes: true },
    }),
  ],
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      'src/test/suite/**',
    ],
    setupFiles: ['src/test/webview/setup.ts'],
  },
});
