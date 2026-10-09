// Wizualizacja odstrzału: bloczki wg czasu odpalenia, rozpad na odłamki (Kuz-Ram) i fizyka ruchu.
// To ilustracja poglądowa, nie przewidywanie (nie służy do wyznaczania stref bezpieczeństwa ani zasięgu odłamków).
import * as THREE from 'three';
import { buildBlocks, buildGround, autoBlockSize, faceAzimuth } from './blocks.js';
import { sample as rrSample } from './fragmentation.js';
import { createRapierEngine, createBallisticEngine, BlastSim, loadRapier, throwVelocities } from './physics.js';

// Skala kolorów czasu (sekwencyjna, czytelna dla osób z zaburzeniami widzenia barw): ciemny fiolet, błękit, zieleń, żółty.
const STOPS = [[0.267, 0.005, 0.329], [0.231, 0.318, 0.545], [0.128, 0.567, 0.551], [0.369, 0.789, 0.383], [0.993, 0.906, 0.144]];
export function timeColor(f, out = new THREE.Color()) {
  const x = Math.min(Math.max(f, 0), 1) * (STOPS.length - 1), i = Math.min(Math.floor(x), STOPS.length - 2), t = x - i;
  return out.setRGB(STOPS[i][0] + (STOPS[i + 1][0] - STOPS[i][0]) * t, STOPS[i][1] + (STOPS[i + 1][1] - STOPS[i][1]) * t, STOPS[i][2] + (STOPS[i + 1][2] - STOPS[i][2]) * t);
}

const mulberry32 = (a) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const easeOut = (x) => 1 - (1 - Math.min(Math.max(x, 0), 1)) ** 3;
const CDN = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/dist/rapier.mjs';
let rapierPromise = null;

export class BlastViz {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mode = 'off';
    this.t = 0; this.playing = false; this.speed = 0.5;
    this.blocks = []; this.ready = false; this.sim = null; this.engineKind = null;
  }

  get tMax() { return (this.tFireMax ?? 0) + (this.mode === 'phys' ? 7000 : this.mode === 'frag' ? 900 : 600); }

  clear() {
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry?.dispose(); o.material?.dispose?.(); o.dispose?.(); }
    this.sim?.engine.dispose(); this.sim = null; this.engineKind = null;
    this.ready = false; this.blockMesh = this.fragMesh = this.groundMesh = null;
  }

  // ctx: { polygon, floorZ, sampleZ, holes:[{x,y,tFire,mass,volume}], burden, frag:{x50,n}, az|null, fallbackAz, power, blockSize, maxBlocks }
  prepare(ctx) {
    this.clear();
    this.ctx = ctx;
    const holes = ctx.holes;
    if (!ctx.polygon || ctx.polygon.length < 3 || !holes.length) return { ok: false, message: 'Narysuj obrys i wygeneruj siatkę otworów.' };
    let size = ctx.blockSize > 0 ? ctx.blockSize : autoBlockSize(ctx.polygon, ctx.sampleZ, ctx.floorZ, ctx.maxBlocks);
    let blocks = buildBlocks({ polygon: ctx.polygon, sampleZ: ctx.sampleZ, floorZ: ctx.floorZ, size, holes });
    while (blocks.length > 9000) { size *= 1.25; blocks = buildBlocks({ polygon: ctx.polygon, sampleZ: ctx.sampleZ, floorZ: ctx.floorZ, size, holes }); }
    if (!blocks.length) return { ok: false, message: 'Brak bryły nad rzędną docelową w obrysie.' };
    this.blocks = blocks; this.size = size;
    this.az = ctx.az ?? faceAzimuth({ polygon: ctx.polygon, sampleZ: ctx.sampleZ, fallbackAz: ctx.fallbackAz ?? 0 });
    this.tFire = Float32Array.from(blocks, (b) => holes[b.hole].tFire ?? 0);
    this.tFireMax = Math.max(0, ...this.tFire);
    this.tFireMin = Math.min(this.tFireMax, ...this.tFire);
    this.ground = buildGround({ polygon: ctx.polygon, sampleZ: ctx.sampleZ, floorZ: ctx.floorZ });

    // prędkości początkowe (układ sceny): model w physics.js (kierunek ku ścianie, większe przy ścianie i u góry ławy)
    const rng = mulberry32(777), az = (this.az * Math.PI) / 180, B = ctx.burden || 3;
    this.vel = throwVelocities({ blocks, holes, polygon: ctx.polygon, floorZ: ctx.floorZ, az: this.az, burden: B, power: ctx.power ?? 1, rng });
    this.dirWorld = { x: Math.sin(az), z: -Math.cos(az) };

    // rozpad: układ odłamków wg Rosina-Rammlera
    const { x50, n } = ctx.frag ?? { x50: 30, n: 1.2 };
    const F_MAX = 30000, mMax = Math.max(1, Math.min(3, Math.floor(Math.cbrt(F_MAX / blocks.length))));
    const fp = [], fo = [], fd = [], fg = [];
    this.whole = new Uint8Array(blocks.length);
    this.fragStart = new Int32Array(blocks.length + 1);
    const rf = mulberry32(4242);
    blocks.forEach((b, i) => {
      this.fragStart[i] = fp.length;
      const smin = Math.min(b.sx, b.sy, b.sz), x = rrSample(rf(), x50, n) / 100;
      if (x >= smin * 0.9) { this.whole[i] = 1; return; } // nadgabaryt: bloczek zostaje nienaruszony
      const m = Math.min(mMax, Math.max(1, Math.round(smin / x)));
      for (let a = 0; a < m; a++) for (let c = 0; c < m; c++) for (let d = 0; d < m; d++) {
        const r = Math.min(1, Math.max(0.35, (rrSample(rf(), x50, n) / 100) / (smin / m)));
        fp.push(i);
        fo.push(((a + 0.5) / m - 0.5) * b.sx, ((d + 0.5) / m - 0.5) * b.sz, -(((c + 0.5) / m - 0.5) * b.sy)); // przesunięcie w osiach sceny
        fd.push((b.sx / m) * r, (b.sz / m) * r, (b.sy / m) * r);
        fg.push(0.78 + 0.22 * rf());
      }
    });
    this.fragStart[blocks.length] = fp.length;
    this.fragParent = Int32Array.from(fp); this.fragOff = Float32Array.from(fo); this.fragDim = Float32Array.from(fd); this.fragGray = Float32Array.from(fg);
    this.wholeCount = this.whole.reduce((s, v) => s + v, 0);

    // siatki do rysowania
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.blockMesh = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.9 }), blocks.length);
    this.fragMesh = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.95 }), Math.max(1, this.fragParent.length));
    this.fragMesh.count = this.fragParent.length;
    this.blockGray = Float32Array.from(blocks, () => 0.7 + 0.3 * rng());
    const g = this.ground, pos = new Float32Array(g.nx * g.ny * 3), idx = [];
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) { const k = (j * g.nx + i) * 3; pos[k] = g.x0 + i * g.dx; pos[k + 1] = g.h[j * g.nx + i]; pos[k + 2] = -(g.y0 + j * g.dx); }
    for (let j = 0; j < g.ny - 1; j++) for (let i = 0; i < g.nx - 1; i++) { const a = j * g.nx + i, b = a + 1, c = a + g.nx, d = c + 1; idx.push(a, b, c, b, d, c); }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); gg.setIndex(idx); gg.computeVertexNormals();
    this.groundMesh = new THREE.Mesh(gg, new THREE.MeshStandardMaterial({ color: 0x6f7883, roughness: 1, flatShading: true, side: THREE.DoubleSide }));
    this.group.add(this.groundMesh, this.blockMesh, this.fragMesh);
    this.m = new THREE.Matrix4(); this.p = new THREE.Vector3(); this.q = new THREE.Quaternion(); this.s = new THREE.Vector3(); this.c = new THREE.Color(); this.o = new THREE.Vector3();
    this.bState = new Uint8Array(blocks.length).fill(255);
    this.ready = true;
    this.reset();
    return { ok: true, blocks: blocks.length, size, frags: this.fragParent.length, whole: this.wholeCount, az: this.az };
  }

  setMode(mode) {
    this.mode = mode;
    if (this.ready) this.reset();
  }

  // Ustawia stan początkowy (wszystkie bloczki na miejscu); silnik fizyki tworzony jest na żądanie.
  reset() {
    if (!this.ready) return;
    this.t = 0; this.playing = false; this.acc = 0;
    this.sim?.engine.dispose(); this.sim = null;
    this.bState.fill(255);
    this.fragMesh.visible = this.mode === 'frag' || this.mode === 'phys';
    this.render(0, true);
  }

  async ensurePhysics() {
    if (this.mode !== 'phys' || this.sim || !this.ready) return this.engineKind;
    rapierPromise ??= loadRapier([globalThis.__RAPIER_URL__, new URL('./vendor/rapier/rapier.mjs', globalThis.document?.baseURI ?? 'http://localhost/').href, CDN]);
    const R = await rapierPromise;
    const engine = R ? createRapierEngine(R, this.ground, this.blocks) : createBallisticEngine(this.ground, this.blocks);
    this.engineKind = engine.kind;
    this.poses = new Float32Array(this.blocks.length * 7);
    this.sim = new BlastSim(engine, this.blocks.map((_, i) => ({ i, tMs: this.tFire[i], v: this.vel[i].v, w: this.vel[i].w })));
    return this.engineKind;
  }

  tick(dtSec) {
    if (!this.ready || !this.playing) return false;
    if (this.mode === 'phys') {
      if (!this.sim) return false;
      // krok stały 1/60 s; ułamek czasu (zwolnienie) odkłada się w akumulatorze
      const step = 1000 / 60;
      this.acc = (this.acc ?? 0) + dtSec * 1000 * this.speed;
      const n = Math.min(Math.floor(this.acc / step), 6);
      if (n > 0) { this.sim.advanceTo(this.sim.t + n * step); this.acc -= n * step; }
      if (this.acc > 6 * step) this.acc = 0;
      this.t = Math.min(this.sim.t, this.tMax);
      if (this.sim.t >= this.tMax) this.playing = false;
      this.render(this.t);
      return true;
    }
    this.t = Math.min(this.t + dtSec * 1000 * this.speed, this.tMax);
    if (this.t >= this.tMax - 1e-6) this.playing = false;
    this.render(this.t);
    return true;
  }

  seek(t) { // przewijanie: poza fizyką
    if (!this.ready || this.mode === 'phys') return;
    this.t = Math.min(Math.max(t, 0), this.tMax);
    this.render(this.t);
  }

  // Stan bloczka: 0 = nieodpalony, 2 = odpalony i w ruchu/animacji, 1 = odpalony i ustalony.
  // Ustalone i nieodpalone bloczki pomijamy, żeby odtwarzanie było płynne.
  render(t, force = false) {
    const { blocks, m, p, q, s, o, c, mode } = this;
    const phys = mode === 'phys' && this.sim;
    const useFrags = mode !== 'time';
    if (phys) for (const i of this.sim.engine.fired) this.sim.engine.pose(i, this.poses, i * 7);
    let anyFrag = false;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i], tf = this.tFire[i], fired = tf <= t, age = t - tf;
      const state = !fired ? 0 : (phys || age < 450 ? 2 : 1);
      if (!force && state !== 2 && state === this.bState[i]) continue;
      this.bState[i] = state;
      const e = fired ? easeOut(age / 350) : 0;
      let px = b.x, py = b.z, pz = -b.y;
      q.identity();
      if (fired && phys) {
        const j = i * 7; px = this.poses[j]; py = this.poses[j + 1]; pz = this.poses[j + 2];
        q.set(this.poses[j + 3], this.poses[j + 4], this.poses[j + 5], this.poses[j + 6]);
      } else if (fired && mode === 'frag') { // bez fizyki: odłamki lekko rozsuwają się ku wolnej ścianie
        const d = 0.35 * this.vel[i].vH * e;
        px += this.dirWorld.x * d; pz += this.dirWorld.z * d;
      }
      const split = useFrags && fired && !this.whole[i];
      // blok
      if (split) s.set(0, 0, 0); else s.set(b.sx * 0.96, b.sz * 0.96, b.sy * 0.96);
      p.set(px, py, pz); m.compose(p, q, s); this.blockMesh.setMatrixAt(i, m);
      if (mode === 'time') {
        if (!fired) timeColor(this.tFireMax > this.tFireMin ? (tf - this.tFireMin) / (this.tFireMax - this.tFireMin) : 0, c);
        else { const fl = Math.max(0, 1 - age / 220); c.setRGB(0.26 + 0.74 * fl, 0.28 + 0.6 * fl, 0.3 + 0.4 * fl); }
      } else if (fired && this.whole[i]) c.setRGB(0.95, 0.5, 0.15); // nadgabaryt: bloczek nie rozpadł się
      else { const g = 0.45 * this.blockGray[i]; c.setRGB(g, g * 1.03, g * 1.1); }
      this.blockMesh.setColorAt(i, c);
      // odłamki tego bloczka
      if (useFrags) {
        for (let k = this.fragStart[i]; k < this.fragStart[i + 1]; k++) {
          if (!split) { s.set(0, 0, 0); p.set(0, 0, 0); q.identity(); m.compose(p, q, s); this.fragMesh.setMatrixAt(k, m); continue; }
          o.set(this.fragOff[k * 3], this.fragOff[k * 3 + 1], this.fragOff[k * 3 + 2]).multiplyScalar(1 + 0.35 * e).applyQuaternion(q);
          p.set(px + o.x, py + o.y, pz + o.z);
          s.set(this.fragDim[k * 3], this.fragDim[k * 3 + 1], this.fragDim[k * 3 + 2]);
          m.compose(p, q, s); this.fragMesh.setMatrixAt(k, m);
          const g = 0.42 * this.fragGray[k]; c.setRGB(g, g * 1.03, g * 1.08); this.fragMesh.setColorAt(k, c);
        }
        anyFrag = true;
      }
    }
    this.blockMesh.instanceMatrix.needsUpdate = true;
    if (this.blockMesh.instanceColor) this.blockMesh.instanceColor.needsUpdate = true;
    if (anyFrag) {
      this.fragMesh.instanceMatrix.needsUpdate = true;
      if (this.fragMesh.instanceColor) this.fragMesh.instanceColor.needsUpdate = true;
    }
  }
}
