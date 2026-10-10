// Syntetyczne dane MWD (Measure While Drilling) dla wiertnicy z młotkiem na wierzchu (top hammer, Ø ~100 mm).
// Dwa „kamieniołomy”: wapień warstwowany z upadem warstw i spękaniami oraz zwięzła skała magmowa.
// Geologia jest ciągła w przestrzeni (warstwy, ciosy, kawerny, strefy zwietrzenia), a każdy otwór
// „wierci” przez nią z próbkowaniem co 10 cm, więc sąsiednie otwory widzą te same warstwy na różnej głębokości.
// Odpowiedź wiertnicy to model poglądowy (kierunki zależności jak w praktyce MWD), nie kalibracja konkretnej maszyny.

const rngOf = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rad = (d) => (d * Math.PI) / 180;
// normalna płaszczyzny o upadzie dip w kierunku dipDir (azymut od +Y zgodnie z ruchem wskazówek, oś Z w górę)
const planeNormal = (dip, dipDir) => ({ x: Math.sin(rad(dip)) * Math.sin(rad(dipDir)), y: Math.sin(rad(dip)) * Math.cos(rad(dipDir)), z: Math.cos(rad(dip)) });
const dot = (n, x, y, z) => n.x * x + n.y * y + n.z * z;

// Sekwencja warstw wzdłuż współrzędnej prostopadłej do uławicenia s ∈ [s0, s1].
function layerSequence(r, s0, s1, kinds) {
  const out = [];
  let s = s0;
  while (s < s1) {
    const k = kinds(r);
    const t = k.t[0] + r() * (k.t[1] - k.t[0]);
    out.push({ from: s, to: s + t, ...k, ucs: k.ucs[0] + r() * (k.ucs[1] - k.ucs[0]) });
    s += t;
  }
  return out;
}

// Ciosy: rodzina równoległych płaszczyzn z nieregularnym odstępem.
function jointSet(r, dip, dipDir, spacing, range) {
  const n = planeNormal(dip, dipDir), pos = [];
  for (let d = -range; d < range; d += spacing[0] + r() * (spacing[1] - spacing[0])) pos.push({ d, open: 0.4 + 0.6 * r() });
  return { n, pos };
}
const nearJoint = (set, x, y, z, w) => {
  const d = dot(set.n, x, y, z);
  let best = 0;
  for (const p of set.pos) { const e = Math.abs(d - p.d); if (e < w) best = Math.max(best, p.open * (1 - e / w)); }
  return best;
};

export const MWD_SETS = {
  wapien: {
    name: 'Wapień warstwowany (upad 25° na N, strzał prostopadle do upadu)',
    density: 2.6, dip: 25, dipDir: 0,
  },
  zwiezla: {
    name: 'Skała zwięzła – granodioryt z żyłą aplitu',
    density: 2.72, dip: 0, dipDir: 0,
  },
};

// Model geologii dla zestawu; origin – punkt odniesienia (np. środek obrysu), zTop – przybliżony wierzch ławy.
export function buildGeology(setId, { origin = { x: 0, y: 0, z: 0 }, faceAz = 90, seed = 7 } = {}) {
  const r = rngOf(seed * 7919 + (setId === 'wapien' ? 1 : 2));
  const o = origin;
  if (setId === 'wapien') {
    const nB = planeNormal(25, 0);                               // uławicenie: upad 25° w kierunku N (+Y), prostopadle do kierunku strzału (+X)
    const layers = layerSequence(r, -40, 40, (rr) => {
      const u = rr();
      if (u < 0.12) return { type: 'marl', label: 'margiel / przerost ilasty', t: [0.05, 0.3], ucs: [12, 28], clay: 0.8 };
      if (u < 0.42) return { type: 'marly', label: 'wapień marglisty', t: [0.3, 1.1], ucs: [40, 65], clay: 0.3 };
      return { type: 'lime', label: 'wapień zwięzły', t: [0.5, 1.9], ucs: [85, 130], clay: 0 };
    });
    const J1 = jointSet(r, 82, faceAz, [1.0, 2.2], 60);          // cios równoległy do ściany (strzał wzdłuż jego normalnej)
    const J2 = jointSet(r, 86, (faceAz + 90) % 360, [1.8, 3.5], 60);
    const voids = [];
    for (let i = 0; i < 26; i++) voids.push({ x: (r() - 0.5) * 50, y: (r() - 0.5) * 50, z: -2 - r() * 12, rad: 0.25 + r() * 0.6 });
    return {
      setId, density: 2.6,
      props(x, y, z, zTop) {
        const lx = x - o.x, ly = y - o.y, lz = z - o.z, s = dot(nB, lx, ly, lz);
        let L = layers[0], contact = 1e9;
        for (const l of layers) { if (s >= l.from && s < l.to) { L = l; contact = Math.min(s - l.from, l.to - s); break; } }
        const depth = zTop != null ? zTop - z : 3;
        let frac = 0.05;
        frac = Math.max(frac, (contact < 0.06 ? 0.7 : 0) * (L.type === 'marl' ? 0.6 : 1));            // rozwarstwienie na kontakcie ławic
        frac = Math.max(frac, nearJoint(J1, lx, ly, lz, 0.12), 0.8 * nearJoint(J2, lx, ly, lz, 0.1));
        if (depth < 1.0) frac = Math.max(frac, 0.55 * (1 - depth));                                  // strefa naruszona przewiertem/strzałem z wyższej ławy
        let isVoid = false;
        for (const v of voids) if (Math.hypot(lx - v.x, ly - v.y, (lz - v.z) * 1.6) < v.rad) { isVoid = L.type === 'lime'; if (isVoid) break; }
        return { ucs: L.ucs, frac: clamp(frac, 0, 1), clay: L.clay, void: isVoid, type: L.type, label: L.label };
      },
    };
  }
  // granodioryt: masywny, łagodna zmienność wytrzymałości, rzadkie ciosy, spękania odciążeniowe, żyła aplitu
  const J1 = jointSet(r, 78, faceAz, [3, 5.5], 60), J2 = jointSet(r, 84, (faceAz + 90) % 360, [3.5, 6], 60);
  const sheet = jointSet(r, 8, (faceAz + 180) % 360, [3.5, 5], 40);  // spękania równoległe do powierzchni (odciążeniowe)
  const nDyke = planeNormal(62, (faceAz + 35) % 360), dyke0 = (r() - 0.5) * 6, dykeT = 1.2;
  return {
    setId, density: 2.72,
    props(x, y, z, zTop) {
      const lx = x - o.x, ly = y - o.y, lz = z - o.z, depth = zTop != null ? zTop - z : 3;
      let ucs = 185 + 25 * Math.sin(lx * 0.11 + 1) * Math.cos(ly * 0.09) + 12 * Math.sin(lz * 0.7 + lx * 0.2);
      let type = 'granite', label = 'granodioryt';
      if (Math.abs(dot(nDyke, lx, ly, lz) - dyke0) < dykeT / 2) { ucs = 245; type = 'aplite'; label = 'żyła aplitu'; }
      let frac = 0.03;
      frac = Math.max(frac, nearJoint(J1, lx, ly, lz, 0.1), nearJoint(J2, lx, ly, lz, 0.08), 0.8 * nearJoint(sheet, lx, ly, lz, 0.08));
      if (depth < 1.2) { frac = Math.max(frac, 0.6 * (1 - depth / 1.2)); ucs *= 0.75 + 0.25 * (depth / 1.2); } // zwietrzenie i naruszenie przy wierzchu
      return { ucs, frac: clamp(frac, 0, 1), clay: 0, void: false, type, label };
    },
  };
}

// „Wiercenie” otworu przez geologię: próbki co step [m] wzdłuż osi otworu.
export function drillHole(geo, hole, { step = 0.1, seed = 1 } = {}) {
  const r = rngOf(seed * 104729 + 17);
  const L = hole.length, dir = hole.dir ?? { x: 0, y: 0, z: -1 };
  const out = [];
  let t = 0, rotPrev = 50;
  for (let d = 0; d <= L + 1e-9; d += step) {
    const x = hole.x + dir.x * d, y = hole.y + dir.y * d, z = hole.z + dir.z * d;
    const p = geo.props(x, y, z, hole.z);
    const n = () => (r() - 0.5) * 2;
    const collar = d < 0.4 ? 1 - d / 0.4 : 0;                                      // nawiercanie: mniejszy posuw
    const ucsEff = p.ucs * (1 - 0.45 * p.frac);
    let rop = 2.5 * Math.pow(60 / Math.max(8, ucsEff), 0.6) * (1 + 0.5 * p.frac) * (1 - 0.5 * collar) * (1 + 0.05 * n());
    let feed = 78 - 22 * p.frac - 30 * collar + 2 * n();
    let perc = 188 - 14 * p.frac - 40 * collar + 3 * n();
    let rot = 40 + 0.06 * p.ucs + 30 * p.frac + 28 * p.clay + (p.frac > 0.3 ? 45 * p.frac * r() : 0) + 1.5 * n();
    let damp = 52 + 28 * p.frac + 2 * n();
    let flush = 9.2 - 3.5 * p.frac + 2.5 * p.clay + 0.25 * n();
    let rpm = 118 - 14 * p.clay - 8 * (rot > 90 ? 1 : 0) + 2 * n();
    if (p.void) { rop = 7 + 2 * r(); feed = 30 + 5 * n(); perc = 110 + 10 * n(); rot = 32 + 3 * n(); damp = 95 + 5 * n(); flush = 3 + n(); }
    rot = 0.6 * rot + 0.4 * rotPrev; rotPrev = rot;                                  // bezwładność układu obrotu
    t += (step / Math.max(0.05, rop)) * 60;
    out.push({ depth: +d.toFixed(2), time: +t.toFixed(1), rop: +rop.toFixed(3), feed: +feed.toFixed(1), perc: +perc.toFixed(1), rot: +rot.toFixed(1), damp: +damp.toFixed(1), flush: +flush.toFixed(2), rpm: +rpm.toFixed(0), x, y, z, truth: p });
  }
  return out;
}

// Interpretacja jak w oprogramowaniu MWD: z surowych parametrów szacujemy wytrzymałość i wskaźnik spękań,
// a z nich współczynnik skały A wg Lilly (RMD z spękań, JPS z gęstości szczelin, HF z UCS).
export function interpretHole(samples, { density = 2.6, jpa = 30 } = {}) {
  const n = samples.length, ucs = new Float32Array(n), fi = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i], ropN = s.rop * Math.sqrt(78 / Math.max(20, s.feed));     // normalizacja posuwu
    ucs[i] = clamp(60 * Math.pow(2.5 / Math.max(0.05, ropN), 1 / 0.6), 5, 300);
    let m = 0, c = 0;
    for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) { m += samples[j].rot; c++; }
    fi[i] = clamp(Math.abs(s.rot - m / c) / 18 + (s.damp - 52) / 40 + Math.max(0, 9 - s.flush) / 8, 0, 1);
  }
  const frac = Array.from(fi, (v, i) => v > 0.45 && (i === 0 || fi[i - 1] <= 0.45));  // początek zdarzenia = szczelina
  const A = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) if (frac[j]) k++;   // szczeliny w oknie 1 m
    const jps = k >= 3 ? 10 : k >= 1 ? 20 : 50;
    const rmd = fi[i] > 0.6 ? 10 : fi[i] > 0.3 ? 20 : 50;
    const E = 0.35 * ucs[i];                                                          // E [GPa] ≈ 0,35·UCS [MPa] (przybliżenie)
    const hf = E < 50 ? E / 3 : ucs[i] / 5;
    A[i] = 0.06 * (rmd + jps + jpa + (25 * density - 50) + hf);
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const len = samples.length ? samples[n - 1].depth : 0;
  return { ucs, fi, A, fractures: frac.filter(Boolean).length, perM: len > 0 ? frac.filter(Boolean).length / len : 0, meanUcs: mean(ucs), meanA: mean(A) };
}

export function mwdCsv(samples, { planId = '', holeId = '', holeName = '', setName = '' } = {}) {
  const head = [`# Syntetyczne dane MWD (do testów, nie z rzeczywistej wiertnicy)`, `# Zestaw: ${setName}`, `# PlanId: ${planId}; HoleId: ${holeId}; HoleName: ${holeName}`,
    'Depth_m;Time_s;PenetrationRate_m_min;FeedPressure_bar;PercussionPressure_bar;RotationPressure_bar;DamperPressure_bar;FlushPressure_bar;RotationSpeed_rpm;X;Y;Z'];
  return head.concat(samples.map((s) => [s.depth, s.time, s.rop, s.feed, s.perc, s.rot, s.damp, s.flush, s.rpm, s.x.toFixed(2), s.y.toFixed(2), s.z.toFixed(2)].join(';'))).join('\n') + '\n';
}
