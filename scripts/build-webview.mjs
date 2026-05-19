import esbuild from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import { sveltePreprocess } from 'svelte-preprocess';

const dev = process.argv.includes('--dev');
const watch = process.argv.includes('--watch');

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
      preprocess: sveltePreprocess(),
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
