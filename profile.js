// Profil (przekrój pionowy) przez teren i otwory. Współrzędne lokalne: X, Y poziomo, Z w górę (metry).
// Płaszczyzna przekroju przechodzi przez punkt origin w kierunku azymutu (0 = +Y, zgodnie z ruchem wskazówek zegara).

export function buildProfile({ origin, azimuthDeg, half = 12, band = 1, holes, sampleZ, targets, step = 0.25 }) {
  const az = (azimuthDeg * Math.PI) / 180;
  const ux = Math.sin(az), uy = Math.cos(az); // wzdłuż przekroju
  const vx = Math.cos(az), vy = -Math.sin(az); // prostopadle (odległość boczna)
  const toS = (x, y) => (x - origin.x) * ux + (y - origin.y) * uy;
  const toD = (x, y) => (x - origin.x) * vx + (y - origin.y) * vy;

  const terrain = [];
  for (let s = -half; s <= half + 1e-9; s += step) {
    const z = sampleZ(origin.x + ux * s, origin.y + uy * s);
    if (z !== null && z !== undefined) terrain.push([s, z]);
  }

  const out = [];
  for (const h of holes) {
    const d = toD(h.x, h.y);
    if (Math.abs(d) > band) continue;
    const at = (t) => ({ x: h.x + h.dir.x * t, y: h.y + h.dir.y * t, z: h.z + h.dir.z * t });
    const pt = (t) => { const p = at(t); return { s: toS(p.x, p.y), z: p.z }; };
    const collar = pt(0), toe = pt(h.length);
    if (Math.max(collar.s, toe.s) < -half || Math.min(collar.s, toe.s) > half) continue;
    out.push({
      id: h.id, name: h.name, type: h.type, d, collar, toe,
      segs: (h.segments ?? [{ kind: 'stemming', from: 0, to: h.length }]).map((g) => ({ ...g, a: pt(g.from), b: pt(g.to) })),
    });
  }

  // Zabiór: pole przekroju terenu ponad poziomem docelowym w zakresie otworów (m²).
  let take = null;
  const base = targets.normal;
  if (out.length && terrain.length > 1) {
    const sFrom = Math.min(...out.map((h) => h.collar.s)), sTo = Math.max(...out.map((h) => h.collar.s));
    let area = 0;
    for (let i = 1; i < terrain.length; i++) {
      const [s0, z0] = terrain[i - 1], [s1, z1] = terrain[i];
      if (s1 <= sFrom || s0 >= sTo) continue;
      const a = Math.max(s0, sFrom), b = Math.min(s1, sTo);
      const za = z0 + ((z1 - z0) * (a - s0)) / (s1 - s0), zb = z0 + ((z1 - z0) * (b - s0)) / (s1 - s0);
      area += (Math.max(0, za - base) + Math.max(0, zb - base)) * 0.5 * (b - a);
    }
    take = { sFrom, sTo, width: sTo - sFrom, area };
  }
  const zs = [...terrain.map((t) => t[1]), targets.normal, targets.profile, ...out.flatMap((h) => [h.collar.z, h.toe.z])].filter(Number.isFinite);
  return { half, terrain, holes: out, targets, take, zMin: Math.min(...zs), zMax: Math.max(...zs) };
}

// Rysowanie na <canvas>. zOffset: lokalne Z -> rzeczywista rzędna (do podpisów). colors: id produktu -> kolor.
export function drawProfile(canvas, data, { zOffset = 0, colors = {} } = {}) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#14171c'; g.fillRect(0, 0, W, H);
  if (!data || !data.terrain.length) {
    g.fillStyle = '#8b95a3'; g.font = '13px system-ui'; g.fillText('Brak terenu w tym przekroju.', 16, 28);
    return;
  }
  const mL = 54, mR = 14, mT = 14, mB = 26;
  const zr = Math.max(1, data.zMax - data.zMin) * 1.12, zMid = (data.zMax + data.zMin) / 2;
  const scale = Math.min((W - mL - mR) / (2 * data.half), (H - mT - mB) / zr);
  const cx = mL + (W - mL - mR) / 2, cy = mT + (H - mT - mB) / 2;
  const X = (s) => cx + s * scale, Y = (z) => cy - (z - zMid) * scale;

  g.font = '11px system-ui'; g.lineWidth = 1;
  g.strokeStyle = '#2c333d'; g.fillStyle = '#8b95a3';
  const zStep = zr > 30 ? 5 : zr > 12 ? 2 : 1;
  for (let z = Math.ceil((zMid - zr / 2 + zOffset) / zStep) * zStep; z <= zMid + zr / 2 + zOffset; z += zStep) {
    const y = Y(z - zOffset); g.beginPath(); g.moveTo(mL, y); g.lineTo(W - mR, y); g.stroke();
    g.textAlign = 'right'; g.fillText(z.toFixed(0), mL - 6, y + 4);
  }
  g.textAlign = 'center';
  for (let s = -Math.floor(data.half / 5) * 5; s <= data.half; s += 5) g.fillText(`${s} m`, X(s), H - 8);

  if (data.take) { // zabiór
    g.fillStyle = 'rgba(240,163,10,.22)';
    g.beginPath();
    let started = false;
    for (const [s, z] of data.terrain) {
      if (s < data.take.sFrom || s > data.take.sTo) continue;
      if (!started) { g.moveTo(X(s), Y(data.targets.normal)); started = true; }
      g.lineTo(X(s), Y(Math.max(z, data.targets.normal)));
    }
    g.lineTo(X(data.take.sTo), Y(data.targets.normal)); g.closePath(); g.fill();
  }

  g.strokeStyle = '#c9d1db'; g.lineWidth = 2; g.beginPath();
  data.terrain.forEach(([s, z], i) => (i ? g.lineTo(X(s), Y(z)) : g.moveTo(X(s), Y(z))));
  g.stroke();

  g.setLineDash([6, 4]); g.lineWidth = 1.5; g.textAlign = 'left';
  for (const [k, c, label] of [['normal', '#3b82f6', 'zwykłe'], ['profile', '#7bd88f', 'profilowe']]) {
    const t = data.targets[k];
    if (!Number.isFinite(t) || (k === 'profile' && t === data.targets.normal)) continue;
    g.strokeStyle = c; g.fillStyle = c; g.beginPath(); g.moveTo(mL, Y(t)); g.lineTo(W - mR, Y(t)); g.stroke();
    g.fillText(`${(t + zOffset).toFixed(2)} (${label})`, mL + 6, Y(t) - 4);
  }
  g.setLineDash([]);

  for (const h of data.holes) {
    for (const sg of h.segs) {
      g.lineWidth = sg.kind === 'charge' ? 5 : sg.kind === 'plug' ? 6 : sg.kind === 'deck' || sg.kind === 'air' ? 3 : 2;
      g.strokeStyle = sg.kind === 'charge' ? colors[sg.productId] ?? '#ff6b3d' : sg.kind === 'deck' ? '#a1887f' : sg.kind === 'air' ? '#7dd3fc' : sg.kind === 'plug' ? '#ffffff' : sg.kind === 'empty' ? '#475569' : '#9aa4b0';
      g.beginPath(); g.moveTo(X(sg.a.s), Y(sg.a.z)); g.lineTo(X(sg.b.s), Y(sg.b.z)); g.stroke();
    }
    g.fillStyle = h.type === 'profile' ? '#7bd88f' : '#2ec4f1';
    g.beginPath(); g.arc(X(h.collar.s), Y(h.collar.z), 3.5, 0, 7); g.fill();
    g.fillStyle = '#e4e8ee'; g.textAlign = 'center'; g.font = '11px system-ui';
    g.fillText(String(h.name ?? h.id), X(h.collar.s), Y(h.collar.z) - 8);
  }
}
