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

// Druga próbka: naturalna ściana po poprzednim strzale (100 × 70 m, siatka 0,5 m).
// Krawędź skarpy faluje ±1 m wokół x = 58 (zabiór pierwszego szeregu 2–4 m przy rzędzie na x = 55),
// skarpa ma zmienną szerokość i wybrzuszenia, przy podnóżu zostaje próg (toe), na dolnej półce resztki urobku i bloki.
{
  const W2 = 100, H2 = 70, s2 = 0.5, nx2 = W2 / s2 + 1, ny2 = H2 / s2 + 1;
  const f = (y) => 0.55 * Math.sin(0.19 * y) + 0.3 * Math.sin(0.47 * y + 1.3) + 0.15 * Math.sin(1.1 * y + 0.4);
  let fMin = Infinity, fMax = -Infinity;
  for (let y = 0; y <= H2; y += 0.1) { const v = f(y); fMin = Math.min(fMin, v); fMax = Math.max(fMax, v); }
  const crest = (y) => 58 + -1 + (2 * (f(y) - fMin)) / (fMax - fMin);     // 57 … 59 m
  const width = (y) => 2.4 + 1.3 * (0.5 + 0.5 * Math.sin(0.33 * y + 2));  // szerokość skarpy w poziomie 2,4–3,7 m
  const boulders = [[66, 12, 0.9], [71, 30, 1.1], [64, 47, 0.8], [75, 55, 1.2], [68, 63, 0.7], [62, 22, 0.6]];
  const z2 = (x, y) => {
    const xc = crest(y), w = width(y), top = 110 + 0.12 * Math.sin(x * 0.9) * Math.cos(y * 0.7) + 0.003 * y;
    let z;
    if (x <= xc) z = top - (x > xc - 2 ? 0.25 * Math.max(0, Math.sin(y * 0.8)) * (1 - (xc - x) / 2) : 0); // spękania za krawędzią
    else if (x >= xc + w) z = 98;
    else {
      const t = (x - xc) / w;
      const bulge = 0.45 * Math.sin(y * 0.9 + x * 0.6) * Math.sin(Math.PI * t);                       // nierówności na skarpie
      z = top - (top - 98) * Math.pow(t, 0.85) + bulge;
    }
    const toe = xc + w;                                                                             // próg przy podnóżu
    z += 0.7 * Math.exp(-(((x - toe - 1.2) / 1.4) ** 2)) * (0.5 + 0.5 * Math.sin(0.27 * y + 0.5));
    if (x > toe) {
      z += 0.25 * Math.max(0, Math.sin(x * 0.7 + 1) * Math.sin(y * 0.55)) * Math.exp(-(x - toe) / 12);  // resztki urobku
      for (const [bx, by, r] of boulders) z += r * Math.exp(-(((x - bx) ** 2 + (y - by) ** 2) / (r * r)));
    }
    return Math.max(z, 97.9);
  };
  const L = ['# syntetyczna naturalna ściana po strzale'];
  for (let j = 0; j < ny2; j++) for (let i = 0; i < nx2; i++) L.push(`v ${(i * s2).toFixed(2)} ${(j * s2).toFixed(2)} ${z2(i * s2, j * s2).toFixed(3)}`);
  for (let j = 0; j < ny2 - 1; j++) for (let i = 0; i < nx2 - 1; i++) {
    const a = j * nx2 + i + 1, b = a + 1, c = a + nx2, d = c + 1;
    L.push(`f ${a} ${b} ${d}`, `f ${a} ${d} ${c}`);
  }
  writeFileSync('samples/sciana-naturalna.obj', L.join('\n') + '\n');
}
