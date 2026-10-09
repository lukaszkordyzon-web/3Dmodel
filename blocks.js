// Bryła do odstrzału jako bloczki: komórki w obrysie od rzędnej docelowej do terenu.
import { pointInPolygon, polygonArea, distToEdge } from './blast.js';

// Rozmiar bloczka tak, żeby bloczków było nie więcej niż maxBlocks.
export function autoBlockSize(polygon, sampleZ, floorZ, maxBlocks) {
  const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let sum = 0, n = 0;
  const step = Math.max(1, Math.max(x1 - x0, y1 - y0) / 60);
  for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) {
    if (!pointInPolygon(x, y, polygon)) continue;
    const z = sampleZ(x, y);
    if (z != null) { sum += Math.max(0, z - floorZ); n++; }
  }
  const V = n ? (sum / n) * polygonArea(polygon) : 0;
  return Math.min(5, Math.max(0.5, Math.cbrt(V / maxBlocks)));
}

// holes: [{ x, y, tFire (ms) }]; zwraca bloczki { x, y, z, sx, sy, sz, hole }.
export function buildBlocks({ polygon, sampleZ, floorZ, size, holes }) {
  const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const blocks = [];
  for (let cx = x0 + size / 2; cx < x1; cx += size) {
    for (let cy = y0 + size / 2; cy < y1; cy += size) {
      if (!pointInPolygon(cx, cy, polygon)) continue;
      const top = sampleZ(cx, cy);
      if (top == null || top - floorZ < 0.2) continue;
      const nz = Math.max(1, Math.round((top - floorZ) / size));
      const hz = (top - floorZ) / nz;
      let best = -1, bd = Infinity;
      holes.forEach((h, i) => { const d = (h.x - cx) ** 2 + (h.y - cy) ** 2; if (d < bd) { bd = d; best = i; } });
      for (let j = 0; j < nz; j++) blocks.push({ x: cx, y: cy, z: floorZ + (j + 0.5) * hz, sx: size, sy: size, sz: hz, hole: best });
    }
  }
  return blocks;
}

// Kierunek ku wolnej ścianie (azymut od +Y zgodnie z ruchem wskazówek zegara): krawędzie obrysu, za którymi teren
// wyraźnie spada. Waga krawędzi = spadek × długość; wynik to średnia wektorowa normalnych krawędzi o dużym spadku.
export function faceAzimuth({ polygon, sampleZ, fallbackAz = 0 }) {
  const cx = polygon.reduce((s, p) => s + p.x, 0) / polygon.length, cy = polygon.reduce((s, p) => s + p.y, 0) / polygon.length;
  const edges = [];
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ax = polygon[j].x, ay = polygon[j].y, bx = polygon[i].x, by = polygon[i].y;
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    let nx = (by - ay) / L, ny = -(bx - ax) / L;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; } // normalna na zewnątrz obrysu
    const mean = (ds) => { let s = 0, n = 0; for (const d of ds) { const z = sampleZ(mx + nx * d, my + ny * d); if (z != null) { s += z; n++; } } return n ? s / n : null; };
    const zin = mean([-2, -4]), zout = mean([3, 6, 9]);
    if (zin == null || zout == null) continue; // brak danych terenu: pomijamy (nie jest to „wolna ściana”)
    edges.push({ nx, ny, drop: zin - zout, L });
  }
  const maxDrop = Math.max(0, ...edges.map((e) => e.drop));
  if (maxDrop < 0.5) return fallbackAz;
  let sx = 0, sy = 0;
  for (const e of edges) if (e.drop >= 0.5 * maxDrop) { sx += e.nx * e.drop * e.L; sy += e.ny * e.drop * e.L; }
  return (((Math.atan2(sx, sy) * 180) / Math.PI) + 360) % 360;
}

// Odległość od punktu do krawędzi obrysu wzdłuż kierunku az (do wolnej ściany); do skalowania prędkości rozrzutu.
export function distanceToEdge(polygon, x, y, azDeg) {
  const ux = Math.sin((azDeg * Math.PI) / 180), uy = Math.cos((azDeg * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ax = polygon[j].x, ay = polygon[j].y, bx = polygon[i].x, by = polygon[i].y;
    const ex = bx - ax, ey = by - ay, den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - x) * ey - (ay - y) * ex) / den, s = ((ax - x) * uy - (ay - y) * ux) / den;
    if (t >= 0 && s >= 0 && s <= 1 && t < best) best = t;
  }
  return Number.isFinite(best) ? best : 0;
}

// Teren dla symulacji: siatka wysokości. W obrysie jest rzędna docelowa (bryła usunięta), poza nim teren.
// cutDist > 0: teren jest ścięty do rzędnej docelowej także w pasie otoczenia (tam stoją ruchome bloczki skały).
export function buildGround({ polygon, sampleZ, floorZ, margin = 45, maxCells = 160, cutDist = 0 }) {
  const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y);
  const x0 = Math.min(...xs) - margin, y0 = Math.min(...ys) - margin;
  const w = Math.max(...xs) + margin - x0, h = Math.max(...ys) + margin - y0;
  const dx = Math.max(0.5, Math.max(w, h) / maxCells);
  const nx = Math.ceil(w / dx) + 1, ny = Math.ceil(h / dx) + 1;
  const hg = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * dx, y = y0 + j * dx, t = sampleZ(x, y);
      // strefa wycięta jest o komórkę szersza od obrysu, żeby stroma rampa terenu nie wchodziła w skrajne bloczki
      const inside = pointInPolygon(x, y, polygon), de = inside ? 0 : distToEdge(x, y, polygon);
      let cut = inside || de < dx * 1.01 || (cutDist > 0 && de <= cutDist + dx * 1.01);
      if (!cut && cutDist > 0 && t != null && t > floorZ + 0.3) { // dalej w skarpie (poza otoczeniem) teren też ścinamy, żeby resztka skarpy nie była niewidzialną ścianą
        const gx = (sampleZ(x + dx, y) ?? t) - (sampleZ(x - dx, y) ?? t), gy = (sampleZ(x, y + dx) ?? t) - (sampleZ(x, y - dx) ?? t);
        if (Math.hypot(gx, gy) / (2 * dx) > 0.35) cut = true;
      }
      hg[j * nx + i] = cut ? Math.min(t ?? floorZ, floorZ) : (t ?? floorZ - 3);
    }
  }
  return { x0, y0, dx, nx, ny, h: hg };
}

// Wysokość terenu w punkcie (interpolacja dwuliniowa, poza siatką wartość z brzegu).
export function groundHeight(g, x, y) {
  const fx = Math.min(Math.max((x - g.x0) / g.dx, 0), g.nx - 1), fy = Math.min(Math.max((y - g.y0) / g.dx, 0), g.ny - 1);
  const i = Math.min(Math.floor(fx), g.nx - 2), j = Math.min(Math.floor(fy), g.ny - 2), tx = fx - i, ty = fy - j;
  const a = g.h[j * g.nx + i], b = g.h[j * g.nx + i + 1], c = g.h[(j + 1) * g.nx + i], d = g.h[(j + 1) * g.nx + i + 1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

// Otoczenie: nieodpalane bloczki skały wokół obrysu, do odległości dist (m). Rozmiar rośnie, żeby bloczków było nie więcej niż maxBlocks.
export function buildSurround({ polygon, sampleZ, floorZ, size, dist, maxBlocks = 3000 }) {
  if (!(dist > 0)) return { blocks: [], size, dist: 0 };
  // ta sama siatka i ten sam rozmiar co bloczki serii (początek siatki w narożniku obrysu), bez luki przy obrysie;
  // limit liczby bloczków skraca zasięg otoczenia, a nie powiększa bloczków
  const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y);
  const gx = Math.min(...xs) + size / 2, gy = Math.min(...ys) + size / 2;
  let d0 = dist, blocks = [];
  for (let guard = 0; guard < 30; guard++) {
    blocks = [];
    const kx0 = Math.floor((Math.min(...xs) - d0 - gx) / size), kx1 = Math.ceil((Math.max(...xs) + d0 - gx) / size);
    const ky0 = Math.floor((Math.min(...ys) - d0 - gy) / size), ky1 = Math.ceil((Math.max(...ys) + d0 - gy) / size);
    for (let kx = kx0; kx <= kx1; kx++) {
      for (let ky = ky0; ky <= ky1; ky++) {
        const cx = gx + kx * size, cy = gy + ky * size;
        if (pointInPolygon(cx, cy, polygon) || distToEdge(cx, cy, polygon) > d0) continue;
        const top = sampleZ(cx, cy);
        if (top == null || top - floorZ < 0.2) continue;
        const nz = Math.max(1, Math.round((top - floorZ) / size)), hz = (top - floorZ) / nz;
        for (let j = 0; j < nz; j++) blocks.push({ x: cx, y: cy, z: floorZ + (j + 0.5) * hz, sx: size, sy: size, sz: hz, hole: -1 });
      }
    }
    if (blocks.length <= maxBlocks) break;
    d0 *= 0.85;
  }
  return { blocks, size, dist: d0 };
}
