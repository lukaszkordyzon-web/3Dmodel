// Generuje syntetyczny model ławy kamieniołomu (OBJ, Z w górę) do testów: node gen-sample.mjs
import { writeFileSync } from 'node:fs';
const W = 120, H = 80, step = 1;               // m
const nx = W / step + 1, ny = H / step + 1;
const z = (x, y) => {
  // górna półka z=110 dla x<70, skarpa 70..74, dolna półka z=98 za nią, lekka falistość
  const t = Math.min(1, Math.max(0, (x - 70) / 4));
  const base = 110 - 12 * t * t * (3 - 2 * t);
  return base + 0.15 * Math.sin(x * 0.7) * Math.cos(y * 0.5) + 0.002 * y;
};
const lines = ['# syntetyczna ława testowa'];
for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  const x = i * step, y = j * step;
  lines.push(`v ${x.toFixed(3)} ${y.toFixed(3)} ${z(x, y).toFixed(3)}`);
}
for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
  const a = j * nx + i + 1, b = a + 1, c = a + nx, d = c + 1;
  lines.push(`f ${a} ${b} ${d}`, `f ${a} ${d} ${c}`);
}
writeFileSync('samples/lawa-testowa.obj', lines.join('\n') + '\n');
