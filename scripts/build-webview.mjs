import esbuild from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import { sveltePreprocess } from 'svelte-preprocess';
import path from 'node:path';

const dev = process.argv.includes('--dev');
const watch = process.argv.includes('--watch');

// svelte-preprocess uses tsc which respects tsconfig rootDir: src.
// Library .svelte files (e.g. bits-ui) live outside src and break that check,
// so we only preprocess our own sources and pass library .svelte files through.
const srcRoot = path.resolve('src');
const ownPreprocess = sveltePreprocess();
const guardedPreprocess = {
  name: 'guarded-preprocess',
  markup: (args) => (args.filename && args.filename.startsWith(srcRoot) ? ownPreprocess.markup?.(args) : null),
  script: (args) => (args.filename && args.filename.startsWith(srcRoot) ? ownPreprocess.script?.(args) : null),
  style: (args) => (args.filename && args.filename.startsWith(srcRoot) ? ownPreprocess.style?.(args) : null),
};

const ctx = await esbuild.context({
  entryPoints: ['src/studio/webview/main.ts'],
  mainFields: ['svelte', 'browser', 'module', 'main'],
  conditions: ['svelte', 'browser'],
  bundle: true,
  outfile: 'dist/studio/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: !dev,
  sourcemap: dev,
  plugins: [
    esbuildSvelte({
      preprocess: guardedPreprocess,
      compilerOptions: { css: 'injected', runes: true },
    }),
  ],
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('Watching webview…');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
