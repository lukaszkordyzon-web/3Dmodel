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
    world.createCollider(R.ColliderDesc.cuboid((b.sx / 2) * k, (b.sz / 2) * k, (b.sy / 2) * k).setFriction(0.3).setRestitution(0.05).setDensity(2600), rb);
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
  constructor(engine, fires) { // fires: [{ i, tMs, v: {x,y,z}, w: {x,y,z} }] (układ sceny)
    this.engine = engine;
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
        this.engine.fire(f.i, f.v, f.w);
      }
      this.engine.step(1 / 60);
      this.t = tn; steps++;
    }
    return steps;
  }
}


// Prędkości początkowe bloczków (układ sceny) w chwili odpalenia. Model poglądowy, nie przewidywanie:
// kierunek ku wolnej ścianie, większe przy ścianie i u góry ławy, skalowane jednostkowym zużyciem MW i parametrem power.
// Krzywa rzutu od zużycia jednostkowego MW (pf, kg/m³), wg doświadczenia: pf ≈ 0,1 – ława tylko się luzuje i pęka, prawie bez przemieszczenia;
// pf ≈ 0,5 – normalny strzał (g = 1); pf ≥ 0,7 – daleki wyrzut (g ≈ 1,8), niski usyp. Powyżej ok. 1 kg/m³ nasycenie (g ≤ 3).
export const PF_NONE = 0.1, PF_REF = 0.5, V_REF = 5; // V_REF [m/s]: prędkość pozioma przy pf = PF_REF (bez losowości i wpływu ściany)
export function throwFactor(pf) {
  if (!(pf > PF_NONE)) return 0;
  return Math.min(3, ((pf - PF_NONE) / (PF_REF - PF_NONE)) ** 1.5);
}

export function throwVelocities({ blocks, holes, polygon, floorZ, az, burden = 3, power = 1, rng = Math.random }) {
  const a0 = (az * Math.PI) / 180;
  const top = Math.max(...blocks.map((b) => b.z + b.sz / 2)) - floorZ || 1;
  return blocks.map((b) => {
    const h = holes[b.hole], pf = h.volume > 0 ? h.mass / h.volume : 0.4;
    const wFace = 0.45 + 0.55 * Math.exp(-distanceToEdge(polygon, b.x, b.y, az) / (3 * burden));
    const hf = Math.min(Math.max((b.z - floorZ) / top, 0), 1);               // 0 przy spągu, 1 przy wierzchu ławy
    const vH = V_REF * power * throwFactor(pf) * wFace * (0.9 + 0.1 * hf) * (0.8 + 0.4 * rng());
    const a = a0 + ((rng() - 0.5) * 40 * Math.PI) / 180;
    return { vH, v: { x: Math.sin(a) * vH, y: 0.6 * vH + Math.min(1, vH), z: -Math.cos(a) * vH }, w: { x: (rng() - 0.5) * 4, y: (rng() - 0.5) * 4, z: (rng() - 0.5) * 4 } };
  });
}
