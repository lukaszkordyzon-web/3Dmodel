// Buduje pojedynczy plik HTML (JS i CSS wbudowane, bez importmapy), np. do publikacji jako artifact.
// Użycie: node tools/build-artifact.mjs [wyjście.html]   (wymaga: npm i esbuild)
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'dist/artifact.html';
const bundle = await build({
  entryPoints: ['app.js'], bundle: true, minify: true, format: 'iife', write: false,
  alias: { three: './vendor/three/three.module.js', 'three/addons': './vendor/three/examples/jsm' },
});
const js = bundle.outputFiles[0].text.replaceAll('</script', '<\\/script');
let html = readFileSync('index.html', 'utf8');
const css = readFileSync('style.css', 'utf8');
const title = html.match(/<title>.*?<\/title>/s)[0];
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script type="module"[^>]*><\/script>/, '');
writeFileSync(out, `${title}\n<style>\n${css}</style>\n${body}\n<script>\n${js}\n</script>\n`);
console.log('zapisano', out, (js.length / 1024).toFixed(0) + ' KB JS');
