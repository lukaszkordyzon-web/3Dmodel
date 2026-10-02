// Buduje pojedynczy plik HTML (JS i CSS wbudowane, bez importmapy), np. do publikacji jako artifact.
// Użycie: node tools/build-artifact.mjs [wyjście.html] [--standalone] [--inline-sample]   (wymaga: npm i esbuild)
//   --standalone     pełny dokument HTML (doctype, meta), np. do osadzenia w iframe
//   --inline-sample  model przykładowy wbudowany w plik (bez fetch)
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const out = args.find((a) => !a.startsWith('--')) ?? 'dist/artifact.html';
const bundle = await build({
  entryPoints: ['app.js'], bundle: true, minify: true, format: 'iife', write: false,
  alias: { three: './vendor/three/three.module.js', 'three/addons': './vendor/three/examples/jsm' },
});
const js = bundle.outputFiles[0].text.replaceAll('</script', '<\\/script');
let html = readFileSync('index.html', 'utf8');
const css = readFileSync('style.css', 'utf8');
const title = html.match(/<title>.*?<\/title>/s)[0];
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script type="module"[^>]*><\/script>/, '');
const sample = flags.has('--inline-sample')
  ? `<script>window.__SAMPLE_OBJ__=${JSON.stringify(readFileSync('samples/lawa-testowa.obj', 'utf8')).replaceAll('</', '<\\/')};</script>\n`
  : '';
const page = `${title}\n<style>\n${css}</style>\n${body}\n${sample}<script>\n${js}\n</script>\n`;
const head = '<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<style>html,body{margin:0;height:100%}</style>\n';
writeFileSync(out, flags.has('--standalone') ? head + page : page);
console.log('zapisano', out, (js.length / 1024).toFixed(0) + ' KB JS');
