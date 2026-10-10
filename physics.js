// Fizyka ruchu bloczków po odpaleniu: silnik Rapier (WebAssembly) albo uproszczony zamiennik balistyczny.
// Układ silnika = układ sceny Three.js (Y w górę): lokalne (x, y, z) -> (x, z, -y).
import { groundHeight, distanceToEdge } from './blocks.js';

export const G = 9.81;
export const toWorld = (x, y, z) => ({ x, y: z, z: -y });

// Ładuje Rapier z pierwszego działającego adresu; null, gdy się nie da (np. blokada WebAssembly).
export async function loadRapier(urls) {
  for (const url of urls) {
    if (!url) continue;
    try {
      const mod = await import(/* @vite-ignore */ url);
      const R = mod.default ?? mod;
      await R.init();
      return R;
    } catch { /* następny adres */ }
  }
  return null;
}

// ---------- silnik Rapier ----------
// blocks od indeksu opts.movableFrom to ruchoma skała otoczenia: ciała dynamiczne, uśpione do pierwszego kontaktu.
export function createRapierEngine(R, ground, blocks, opts = {}) {
  const movableFrom = opts.movableFrom ?? Infinity;
  const world = new R.World({ x: 0, y: -G, z: 0 });
  world.timestep = 1 / 60;
  const verts = new Float32Array(ground.nx * ground.ny * 3);
  for (let j = 0; j < ground.ny; j++) for (let i = 0; i < ground.nx; i++) {
    const k = (j * ground.nx + i) * 3;
    verts[k] = ground.x0 + i * ground.dx; verts[k + 1] = ground.h[j * ground.nx + i]; verts[k + 2] = -(ground.y0 + j * ground.dx);
  }
  const idx = [];
  for (let j = 0; j < ground.ny - 1; j++) for (let i = 0; i < ground.nx - 1; i++) {
    const a = j * ground.nx + i, b = a + 1, c = a + ground.nx, d = c + 1;
    idx.push(a, b, c, b, d, c); // normalne ku górze (oś Z sceny = −y lokalnego, więc kolejność jest odwrócona)
  }
  // flaga naprawia „zahaczanie” bloków o wewnętrzne krawędzie trójkątów terenu
  const flags = 'flags' in opts ? opts.flags : R.TriMeshFlags?.FIX_INTERNAL_EDGES;
  world.createCollider(R.ColliderDesc.trimesh(verts, new Uint32Array(idx), flags));
  let lowest = Infinity; for (const h of ground.h) lowest = Math.min(lowest, h);
  world.createCollider(R.ColliderDesc.cuboid(1000, 0.5, 1000).setTranslation(ground.x0, lowest - 4, -ground.y0)); // zabezpieczenie przed „wypadnięciem”
  const bodies = blocks.map((b, i) => {
    const p = toWorld(b.x, b.y, b.z);
    const desc = i >= movableFrom ? R.RigidBodyDesc.dynamic().setCanSleep(true).setSleeping(true) : R.RigidBodyDesc.fixed();
    const rb = world.createRigidBody(desc.setTranslation(p.x, p.y, p.z));
    const k = 0.9; // luz między bloczkami (spękany, rozluźniony urobek)
    // tarcie i odbicie wg pomiarów dla wapienia z urobku (tarcie 0,576 ± 0,13, restytucja normalna 0,315 ± 0,064; MDPI Appl. Sci. 2025)
    world.createCollider(R.ColliderDesc.cuboid((b.sx / 2) * k, (b.sz / 2) * k, (b.sy / 2) * k).setFriction(b.friction ?? 0.58).setRestitution(b.restitution ?? 0.32).setDensity(b.rho ?? 2600), rb); // materiał bloczka (np. glina: lżejsza, lepka)
    rb.setAngularDamping(3); rb.setLinearDamping(0.1); // nieregularna skała nie turla się jak kostki
    return rb;
  });
  const fired = [];
  const wasAwake = new Uint8Array(blocks.length);
  return {
    kind: 'rapier', fired,
    fire(i, v, w) {
      const rb = bodies[i];
      rb.setBodyType(R.RigidBodyType.Dynamic, true);
      rb.setLinvel(v, true); rb.setAngvel(w, true);
      fired.push(i);
    },
    step() { world.step(); },
    // pozycja ruchomej skały: tylko gdy się rusza (albo właśnie zasnęła); zwraca, czy zapisano pozę
    poseIfMoving(i, out, o) {
      const asleep = bodies[i].isSleeping();
      if (asleep && !wasAwake[i]) return false;
      wasAwake[i] = asleep ? 0 : 1;
      this.pose(i, out, o);
      return true;
    },
    pose(i, out, o) {
      const t = bodies[i].translation(), q = bodies[i].rotation();
      out[o] = t.x; out[o + 1] = t.y; out[o + 2] = t.z; out[o + 3] = q.x; out[o + 4] = q.y; out[o + 5] = q.z; out[o + 6] = q.w;
    },
    dispose() { world.free(); },
  };
}

// ---------- zamiennik: balistyka z kolizją z terenem (bez zderzeń bloczków między sobą) ----------
export function createBallisticEngine(ground, blocks) {
  const st = blocks.map((b) => ({ p: toWorld(b.x, b.y, b.z), hy: b.sz / 2, v: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 }, q: [0, 0, 0, 1], rest: true }));
  const fired = [];
  return {
    kind: 'ballistic', fired,
    fire(i, v, w) { Object.assign(st[i], { v: { ...v }, w: { ...w }, rest: false }); fired.push(i); },
    step(dt) {
      for (const i of fired) {
        const s = st[i];
        if (s.rest) continue;
        s.v.y -= G * dt;
        s.p.x += s.v.x * dt; s.p.y += s.v.y * dt; s.p.z += s.v.z * dt;
        const h = groundHeight(ground, s.p.x, -s.p.z) + s.hy;
        if (s.p.y < h) {
          s.p.y = h;
          s.v.y = s.v.y < -1.5 ? -s.v.y * 0.2 : 0;
          s.v.x *= 0.6; s.v.z *= 0.6; s.w.x *= 0.5; s.w.y *= 0.5; s.w.z *= 0.5;
          if (Math.hypot(s.v.x, s.v.y, s.v.z) < 0.2) { s.rest = true; s.v = { x: 0, y: 0, z: 0 }; }
        }
        const [qx, qy, qz, qw] = s.q, hx = 0.5 * dt;
        s.q = norm([qx + hx * (s.w.x * qw + s.w.y * qz - s.w.z * qy), qy + hx * (s.w.y * qw + s.w.z * qx - s.w.x * qz), qz + hx * (s.w.z * qw + s.w.x * qy - s.w.y * qx), qw - hx * (s.w.x * qx + s.w.y * qy + s.w.z * qz)]);
      }
    },
    poseIfMoving() { return false; },
    pose(i, out, o) { const s = st[i]; out[o] = s.p.x; out[o + 1] = s.p.y; out[o + 2] = s.p.z; out[o + 3] = s.q[0]; out[o + 4] = s.q[1]; out[o + 5] = s.q[2]; out[o + 6] = s.q[3]; },
    dispose() {},
  };
}
const norm = (q) => { const l = Math.hypot(...q) || 1; return q.map((x) => x / l); };

// Symulacja w czasie: odpalenia w zadanych chwilach (ms), krok stały 1/60 s.
export class BlastSim {
  constructor(engine, fires, adjust = null) { // fires: [{ i, tMs, v: {x,y,z}, w: {x,y,z} }] (układ sceny); adjust(f) → v w chwili odpalenia
    this.engine = engine; this.adjust = adjust;
    this.fires = [...fires].sort((a, b) => a.tMs - b.tMs);
    this.t = 0; this.next = 0;
  }
  advanceTo(tMs, maxSteps = 1e9) {
    const dt = 1000 / 60;
    let steps = 0;
    while (this.t < tMs - 1e-9 && steps < maxSteps) {
      const tn = this.t + dt;
      while (this.next < this.fires.length && this.fires[this.next].tMs <= tn) {
        const f = this.fires[this.next++];
        this.engine.fire(f.i, this.adjust ? this.adjust(f) : f.v, f.w);
      }
      this.engine.step(1 / 60);
      this.t = tn; steps++;
    }
    return steps;
  }
}


// Odciążenie 3D w chwili odpalenia: sąsiednie bloczki (także nad i pod, w promieniu R), które już odpaliły i odjechały,
// zostawiły wolne miejsce; prędkość bloczka skręca w jego stronę (wagą relief), wartość prędkości bez zmian.
// pos: Float32Array 3·n (pozycje startowe, układ sceny), moved(j) → waga sąsiada j (0 = nie ruszył; np. jego przesunięcie w m).
export function neighborLists(pos, R) {
  const n = pos.length / 3, cell = R, grid = new Map(), key = (a, b, c) => `${a},${b},${c}`;
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(pos[3 * i] / cell), Math.floor(pos[3 * i + 1] / cell), Math.floor(pos[3 * i + 2] / cell));
    (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(pos[3 * i] / cell), cy = Math.floor(pos[3 * i + 1] / cell), cz = Math.floor(pos[3 * i + 2] / cell), L = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      for (const j of grid.get(key(cx + a, cy + b, cz + c)) ?? []) {
        if (j !== i && Math.hypot(pos[3 * j] - pos[3 * i], pos[3 * j + 1] - pos[3 * i + 1], pos[3 * j + 2] - pos[3 * i + 2]) <= R) L.push(j);
      }
    }
    out.push(L);
  }
  return out;
}
export function relief3d(i, v, pos, nbrs, moved, relief, bias = null) {
  let x = bias?.x ?? 0, y = bias?.y ?? 0, z = bias?.z ?? 0; // bias: dodatkowa „wolna przestrzeń” (np. powietrze nad ławą), w tych samych jednostkach co wagi sąsiadów
  for (const j of nbrs[i]) {
    const wj = +moved(j); // waga: true/false albo przesunięcie sąsiada [m] – im dalej odjechał, tym więcej miejsca
    if (!(wj > 0)) continue;
    const dx = pos[3 * j] - pos[3 * i], dy = pos[3 * j + 1] - pos[3 * i + 1], dz = pos[3 * j + 2] - pos[3 * i + 2], d = Math.hypot(dx, dy, dz);
    x += (wj * dx) / d; y += (wj * dy) / d; z += (wj * dz) / d;
  }
  const L = Math.hypot(x, y, z), sp = Math.hypot(v.x, v.y, v.z);
  if (L < 1e-6 || sp < 1e-6 || !(relief > 0)) return v;
  const k = relief * Math.min(1, L / 1.0); // siła skrętu rośnie z „ilością” wolnej przestrzeni (≈ 1 m przesunięcia sąsiadów = pełna waga)
  const ux = v.x / sp + (k * x) / L, uy = v.y / sp + (k * y) / L, uz = v.z / sp + (k * z) / L, U = Math.hypot(ux, uy, uz);
  return U < 1e-6 ? v : { x: (ux / U) * sp, y: (uy / U) * sp, z: (uz / U) * sp };
}

// Prędkości początkowe bloczków (układ sceny) w chwili odpalenia. Model poglądowy, nie przewidywanie:
// kierunek ku wolnej ścianie, większe przy ścianie i u góry ławy, skalowane jednostkowym zużyciem MW i parametrem power.
// Krzywa rzutu od zużycia jednostkowego MW (pf, kg/m³), wg doświadczenia: pf ≈ 0,1 – ława tylko się luzuje i pęka, prawie bez przemieszczenia;
// pf ≈ 0,5 – normalny strzał (g = 1); pf ≥ 0,7 – daleki wyrzut (g ≈ 1,8), niski usyp. Powyżej ok. 1 kg/m³ nasycenie (g ≤ 3).
export const HEAVE = 6; // [m/s] spęcznienie: każdy odstrzał podnosi się i opada; przy pf = 0,5 u góry ławy ok. 6 m/s w górę (≈ 1,8 m), u spągu ok. 40%
// Richards & Moore (2004): prędkość wyrzutu v = k·(√m / B)^1,3 (m – ładunek [kg/m], B – zabiór lub przybitka [m]).
// k dla flyrocku 13,5 (skała miękka) … 27 (twarda) – górna obwiednia; dla ruchu masy przyjmujemy mniejsze k (domyślnie 10, do kalibracji).
export const K_RM = 10, V_MAX = 40;
// Bilans energii (wspólny dla skały i gliny): część η energii MW ponad próg luzowania przechodzi w energię ruchu urobku
// (energia kinetyczna urobku ∝ energii wybuchu – Zhang 2016/2021). Na 1 m³: ½·ρ·v² = η·(pf − PF0)·Q, Q = 3,8 MJ/kg × RWS/100.
export const Q_ANFO = 3.8e6, ETA = 0.04, PF0 = 0.1;
// Impuls ciśnienia gazów z oporem materiału: ρ·B·v = (P − σt)·t → v ∝ (P − σt) / ρ.
// Względem skały odniesienia (UCS_ref, ρ_ref): f = ((P − σt) / (P − σt,ref)) · (ρ_ref / ρ), σt ≈ UCS/10.
// P – efektywne ciśnienie gazów w fazie ruchu urobku (założenie ~30 MPa); bez danych MWD f = 1.
export const P_GAS = 30;
export function impulseFactor(ucs, rho, ucsRef, rhoRef, P = P_GAS) {
  const st = Math.max(0, ucs) / 10, stRef = Math.max(0, ucsRef) / 10;
  return (Math.max(0.05 * P, P - st) / Math.max(0.05 * P, P - stRef)) * (rhoRef / rho);
}
export const energyVelocity = (pf, rws = 100, rho = 2600, eta = ETA) => Math.sqrt((2 * eta * Math.max(0, pf - PF0) * Q_ANFO * (rws / 100)) / rho);
export const rmVelocity = (m, L, k = K_RM) => (m > 0 && L > 0 ? k * (Math.sqrt(m) / L) ** 1.3 : 0);
// poniżej pf ≈ 0,1 ława tylko się luzuje: łagodne wygaszenie do pf = 0,3
export const pfGate = (pf) => Math.min(1, Math.max(0, (pf - 0.1) / 0.2));
export const PF_NONE = 0.1, PF_REF = 0.5, V_REF = 5; // V_REF [m/s]: prędkość pozioma przy pf = PF_REF (bez losowości i wpływu ściany)
export function heave(pf, power, hf, u = 0.5, vBase = null) { // vBase: prędkość R&M otworu (bez wpływu ściany); podrzut = 0,8·vBase
  const base = vBase != null ? 0.8 * vBase : HEAVE * throwFactor(pf);
  return base * power * (0.4 + 0.6 * hf) * (0.85 + 0.3 * u);
}
export function throwFactor(pf) {
  if (!(pf > PF_NONE)) return 0;
  return Math.min(3, ((pf - PF_NONE) / (PF_REF - PF_NONE)) ** 1.5);
}

// Wyrzut w górę przy krótkiej przybitce (kratering): skalowana głębokość ukrycia ładunku SDoB = Dsb / Wt^(1/3) [m/kg^(1/3)],
// Dsb = przybitka do góry ładunku + połowa 10 średnic, Wt = masa 10 średnic ładunku u góry (Chiappetta, McKenzie).
// SDoB > 1,3 – brak lub minimalny kratering; 0,4–1,2 – dopuszczalne; < 0,4 – silny wyrzut i podmuch (raporty wg Chiappetty/McKenzie);
// 0,92–1,4 to zakres projektowy dla fragmentacji. Poniżej 0,4 wyrzut jeszcze rośnie, do 1,5×.
export const SDOB_SAFE = 1.3, SDOB_FULL = 0.4, V_CRATER = 22; // V_CRATER [m/s]: pionowa prędkość bloczka nad ładunkiem przy pełnym krateringu
export function sdob({ stemTop, kgPerM, diameterMm }) {
  const d = diameterMm / 1000;
  if (!(kgPerM > 0) || !(d > 0)) return Infinity;
  const wt = kgPerM * 10 * d;
  return (Math.max(0, stemTop) + 5 * d) / Math.cbrt(wt);
}
export function craterFactor(s) {
  return Math.min(1.5, Math.max(0, (SDOB_SAFE - s) / (SDOB_SAFE - SDOB_FULL))); // > 1 poniżej SDoB 0,6: przybitka ≈ 0 – wyrzut masowy
}

// Kierunek „odciążenia”: suma wektorów jednostkowych od otworu do sąsiadów (w promieniu R) odpalonych wcześniej.
// Urobek przesuwa się w stronę, z której idzie otwarcie serii, bo tam robi się miejsce (ruch prostopadły do izochron).
export function reliefDirs(holes, R) {
  return holes.map((h) => {
    let x = 0, y = 0;
    for (const o of holes) {
      if (o === h || o.tFire == null || h.tFire == null || !(o.tFire < h.tFire)) continue;
      const dx = o.x - h.x, dy = o.y - h.y, d = Math.hypot(dx, dy);
      if (d > 1e-6 && d <= R) { x += dx / d; y += dy / d; }
    }
    const L = Math.hypot(x, y);
    return L > 1e-6 ? { x: x / L, y: y / L } : null;
  });
}

export function throwVelocities({ blocks, holes, polygon, floorZ, az, burden = 3, spacing = burden, power = 1, relief = 0.8, craterK = 1, kRM = K_RM, eta = ETA, rhoRock = 2600, rng = Math.random }) {
  const a0 = (az * Math.PI) / 180;
  const top = Math.max(...blocks.map((b) => b.z + b.sz / 2)) - floorZ || 1;
  const crater = holes.map((h) => (h.stemTop != null ? craterFactor(sdob(h)) : 0));
  const rel = relief > 0 ? reliefDirs(holes, 1.6 * Math.max(burden, spacing)) : holes.map(() => null);
  return blocks.map((b) => {
    const h = holes[b.hole], pf = h.volume > 0 ? h.mass / h.volume : 0.4;
    const wFace = 0.45 + 0.55 * Math.exp(-distanceToEdge(polygon, b.x, b.y, az) / (3 * burden));
    const hf = Math.min(Math.max((b.z - floorZ) / top, 0), 1);               // 0 przy spągu, 1 przy wierzchu ławy
    const useE = h.rws != null, useRM = !useE && h.mPerM > 0 && burden > 0;
    // prędkość bazowa: bilans energii (gęstość skały ρ), awaryjnie Richards & Moore albo krzywa pf
    const vBase = useE ? energyVelocity(pf, h.rws, rhoRock, eta) : useRM ? rmVelocity(h.mPerM, burden, kRM) * pfGate(pf) : null;
    const vH = (vBase != null ? vBase : V_REF * throwFactor(pf)) * power * wFace * (0.9 + 0.1 * hf) * (0.8 + 0.4 * rng());
    // kierunek: azymut nachylenia otworu (otwór pionowy – ku wolnej ścianie), wektor prostopadły do osi otworu:
    // przy nachyleniu α od pionu wylot jest pod kątem α nad poziomem; niewielkie rozproszenie ±10°
    const inclined = h.incl > 0.5 && h.inclAz != null;
    let a = inclined ? (h.inclAz * Math.PI) / 180 : a0;
    const rd = rel[b.hole];
    if (rd) { const ux = Math.sin(a) + relief * rd.x, uy = Math.cos(a) + relief * rd.y; if (Math.hypot(ux, uy) > 1e-6) a = Math.atan2(ux, uy); } // azymut (0° = +Y)
    a += ((rng() - 0.5) * 20 * Math.PI) / 180;
    const el = inclined ? (h.incl * Math.PI) / 180 : 0;
    const vh = vH * Math.cos(el), vUp0 = vH * Math.sin(el) + heave(pf, power, hf, rng(), vBase); // + spęcznienie (unoszenie) urobku, niezależne od odległości od ściany
    const v = { x: Math.sin(a) * vh, y: vUp0, z: -Math.cos(a) * vh };
    const cf = crater[b.hole] ?? 0, rr = rng();
    if (cf > 0 && craterK > 0 && h.z != null) {
      // stożek krateru nad górą ładunku: im bliżej otworu i wylotu, tym mocniej w górę i na boki
      const s = Math.max(b.sx, b.sz), dsb = Math.max(0, h.stemTop) + 0.005 * h.diameterMm;
      // im mniejsze SDoB, tym szerszy i głębszy stożek: przy przybitce ≈ 0 wyrzut masowy z dużej części ławy
      const r = Math.hypot(b.x - h.x, b.y - h.y), R = 1.2 * dsb + s + cf * 0.6 * burden;
      const depth = Math.max(0, h.z - (b.z + b.sz / 2));                    // głębokość wierzchu bloczka pod wylotem otworu
      const Dl = dsb + s + cf * 0.5 * top;
      const w = cf * Math.max(0, 1 - (r / R) ** 2) * Math.max(0, 1 - depth / Dl);
      if (w > 0) {
        // prędkość krateringu wg Richards & Moore (przybitka zamiast zabioru), ograniczona do V_MAX; craterK – waga do kalibracji
        const vc = h.kgPerM > 0 ? Math.min(V_MAX, rmVelocity(h.kgPerM, Math.max(0.1, h.stemTop), kRM)) : V_CRATER;
        const vUp = vc * craterK * power * w * (0.75 + 0.5 * rr);
        const ang = r > 1e-3 ? Math.atan2(b.y - h.y, b.x - h.x) : rr * 2 * Math.PI;
        v.y += vUp; v.x += 0.45 * vUp * Math.cos(ang); v.z -= 0.45 * vUp * Math.sin(ang);
      }
    }
    return { vH, crater: cf, v, w: { x: (rng() - 0.5) * 4, y: (rng() - 0.5) * 4, z: (rng() - 0.5) * 4 } };
  });
}
