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

// Two separate IIFE bundles, one per webview entry point: the Studio side-panel
// SPA and the standalone Loki log-viewer editor tab.
const BUNDLES = [
  { entry: 'src/studio/webview/main.ts', outfile: 'dist/studio/webview.js' },
  { entry: 'src/studio/logviewer/main.ts', outfile: 'dist/studio/logviewer.js' },
];

function makeCtx({ entry, outfile }) {
  return esbuild.context({
    entryPoints: [entry],
    mainFields: ['svelte', 'browser', 'module', 'main'],
    conditions: ['svelte', 'browser'],
    bundle: true,
    outfile,
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
}

const contexts = await Promise.all(BUNDLES.map(makeCtx));

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching webview…');
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
