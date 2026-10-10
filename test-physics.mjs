import assert from 'node:assert/strict';
import RAPIER from './vendor/rapier/rapier.mjs';
import { buildGround, groundHeight, buildBlocks } from './blocks.js';
import { createRapierEngine, createBallisticEngine, BlastSim, loadRapier, toWorld } from './physics.js';

// teren: płaski 100 poza obrysem; obrys 10x6 ze spągiem 100 (wszystko płaskie, dla prostoty)
const poly = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }];
const terrain = (x) => (x > 10 ? 100 : 103);          // przed obrysem (x>10) teren niżej: wolna ściana
const ground = buildGround({ polygon: poly, sampleZ: terrain, floorZ: 100, margin: 20, maxCells: 100 });
assert.ok(Math.abs(groundHeight(ground, 5, 3) - 100) < 1e-6);   // w obrysie: rzędna docelowa
assert.ok(Math.abs(groundHeight(ground, -10, 3) - 103) < 0.6);  // za obrysem: teren
const blocks = buildBlocks({ polygon: poly, sampleZ: terrain, floorZ: 100, size: 1, holes: [{ x: 5, y: 3 }] });
assert.equal(blocks.length, 10 * 6 * 3);

const R = await loadRapier(['./vendor/rapier/rapier.mjs'].map((u) => new URL(u, import.meta.url).href));
assert.ok(R, 'Rapier powinien się załadować');

for (const mk of [() => createRapierEngine(R, ground, blocks), () => createBallisticEngine(ground, blocks)]) {
  const engine = mk();
  // odpal dolną warstwę wzdłuż przodu (x ≈ 9,5) w stronę +X (ku wolnej ścianie), z lekkim unoszeniem
  const front = blocks.map((b, i) => [b, i]).filter(([b]) => b.x > 9);
  const fires = front.map(([, i]) => ({ i, tMs: 100, v: { x: 5, y: 1.5, z: 0 }, w: { x: 0, y: 0, z: 0.5 } })); // cały słupek bloczków odpala się w tej samej chwili
  const sim = new BlastSim(engine, fires);
  sim.advanceTo(50);
  const out = new Float32Array(7);
  const start = (i) => toWorld(blocks[i].x, blocks[i].y, blocks[i].z);
  // przed odpaleniem nic się nie rusza
  for (const [, i] of front) { engine.pose(i, out, 0); assert.ok(Math.abs(out[0] - start(i).x) < 1e-6, 'przed odpaleniem'); }
  sim.advanceTo(4100);
  let moved = 0, ok = true, sumDx = 0;
  for (const [b, i] of front) {
    engine.pose(i, out, 0);
    if (![...out].every(Number.isFinite)) ok = false;
    sumDx += out[0] - start(i).x;
    if (out[0] > start(i).x + 0.5) moved++;
    const gh = groundHeight(ground, out[0], -out[2]);
    if (out[1] < gh - 0.6) ok = false;                  // nie wpadł pod teren
  }
  console.log(engine.kind, ': przesunięte', moved, 'z', front.length, '| średnie przesunięcie', (sumDx / front.length).toFixed(2), 'm');
  assert.ok(sumDx / front.length > 0.8, `${engine.kind}: średnie przesunięcie ku ścianie`);
  assert.ok(ok, `${engine.kind}: współrzędne skończone i nad terenem`);
  assert.ok(moved >= front.length * 0.6, `${engine.kind}: bloczki powinny polecieć ku ścianie`);
  // nieodpalone bloczki z tyłu stoją w miejscu
  const back = blocks.findIndex((b) => b.x < 3);
  engine.pose(back, out, 0); assert.ok(Math.abs(out[0] - start(back).x) < 1e-6 && Math.abs(out[1] - start(back).y) < 1e-6);
  engine.dispose();
}

// ruchome otoczenie: śpiące bloczki za frontem (x>10) stoją, a odpalone bloczki z serii je popychają
{
  const rock = [];
  for (let ix = 0; ix < 4; ix++) for (let iy = 0; iy < 6; iy++) rock.push({ x: 10.5 + ix, y: iy + 0.5, z: 101.5, sx: 1, sy: 1, sz: 3 });
  const g2 = buildGround({ polygon: poly, sampleZ: (x) => (x > 10 ? 103 : 103), floorZ: 100, margin: 20, maxCells: 100, cutDist: 6 });
  const eng = createRapierEngine(R, g2, [...blocks, ...rock], { movableFrom: blocks.length });
  const o = new Float32Array(7), p0 = (b) => toWorld(b.x, b.y, b.z);
  const k0 = blocks.length;
  const sim0 = new BlastSim(eng, []);
  sim0.advanceTo(2000);
  for (let j = 0; j < rock.length; j++) { eng.pose(k0 + j, o, 0); assert.ok(Math.hypot(o[0] - p0(rock[j]).x, o[1] - p0(rock[j]).y) < 0.01, 'nietknięte otoczenie stoi'); }
  const fr = blocks.map((b, i) => [b, i]).filter(([b]) => b.x > 9);
  const sim = new BlastSim(eng, fr.map(([, i]) => ({ i, tMs: 100, v: { x: 6, y: 1.5, z: 0 }, w: { x: 0, y: 0, z: 0.3 } })));
  sim.advanceTo(4000);
  assert.ok(fr.every(([, i]) => i < k0), 'odpalane tylko bloczki serii');
  let pushed = 0;
  for (let j = 0; j < rock.length; j++) {
    eng.pose(k0 + j, o, 0);
    assert.ok([...o].every(Number.isFinite));
    if (o[0] > p0(rock[j]).x + 0.3) pushed++;
  }
  console.log('otoczenie popchnięte:', pushed, 'z', rock.length);
  assert.ok(pushed >= 3, 'otoczenie powinno być popchnięte przez seria');
  eng.dispose();
}

// model prędkości: kierunek ku ścianie, większe przy ścianie i u góry, skaluje się z power
import { throwVelocities } from './physics.js';
let seed = 3; const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const holes = [{ x: 5, y: 3, mass: 70, volume: 3.5 * 4 * 3, tFire: 0 }];
const vel = throwVelocities({ blocks, holes, polygon: poly, floorZ: 100, az: 90, burden: 3.5, power: 1, rng });
const meanVx = (arr) => arr.reduce((s, v) => s + v.v.x, 0) / arr.length;
assert.ok(meanVx(vel) > 2, 'średnio w stronę +X (azymut 90°)');
const nearFace = vel.filter((_, i) => blocks[i].x > 8), farFace = vel.filter((_, i) => blocks[i].x < 2);
assert.ok(meanVx(nearFace) > meanVx(farFace), 'bliżej ściany szybciej');
const topB = vel.filter((_, i) => blocks[i].z > 102), botB = vel.filter((_, i) => blocks[i].z < 101);
assert.ok(meanVx(topB) > meanVx(botB), 'wyżej szybciej');
seed = 3; const vel2 = throwVelocities({ blocks, holes, polygon: poly, floorZ: 100, az: 90, burden: 3.5, power: 2, rng });
assert.ok(meanVx(vel2) > meanVx(vel) * 1.8, 'power skaluje prędkość');
assert.ok(vel.every((v) => Number.isFinite(v.v.x + v.v.y + v.v.z + v.w.x) && v.v.y > 0), 'skończone, z unoszeniem');
import { throwFactor } from './physics.js';
assert.equal(throwFactor(0.1), 0); assert.equal(throwFactor(0.05), 0);
assert.ok(Math.abs(throwFactor(0.5) - 1) < 1e-9);
assert.ok(throwFactor(0.7) > 1.6 && throwFactor(0.7) < 2.1 && throwFactor(0.3) < 0.5 && throwFactor(5) <= 3);
// kierunek wyrzutu: azymut nachylenia otworu, wektor prostopadły do osi (wylot pod kątem nachylenia nad poziomem)
{
  seed = 9; const vi = throwVelocities({ blocks, holes: [{ x: 5, y: 3, mass: 70, volume: 42, incl: 20, inclAz: 0 }], polygon: poly, floorZ: 100, az: 90, burden: 3.5, rng });
  const mx = vi.reduce((s, x) => s + x.v.x, 0), my = vi.reduce((s, x) => s - x.v.z, 0);
  assert.ok(my > 5 * Math.abs(mx), 'kierunek wg azymutu otworu (0° = +Y), nie wg ściany (90°)');
  const elev = Math.atan2(vi[0].v.y - 0.5 * Math.min(1, vi[0].vH), Math.hypot(vi[0].v.x, vi[0].v.z)) * 180 / Math.PI;
  assert.ok(Math.abs(elev - 20) < 0.5, `kąt wylotu = nachylenie otworu (${elev})`);
}
// otwarcie serii: urobek przesuwa się w stronę wcześniej odpalonych sąsiadów
import { reliefDirs } from './physics.js';
{
  const row = [{ x: 1, y: 3, tFire: 0 }, { x: 5, y: 3, tFire: 25 }, { x: 9, y: 3, tFire: 50 }];
  const r = reliefDirs(row, 6);
  assert.equal(r[0], null); assert.ok(r[1].x < -0.99 && r[2].x < -0.99, 'odciążenie w stronę początku rzędu (-X)');
  const hs = row.map((h) => ({ ...h, mass: 70, volume: 42 }));
  const bl = buildBlocks({ polygon: poly, sampleZ: terrain, floorZ: 100, size: 1, holes: hs });
  seed = 4; const v0 = throwVelocities({ blocks: bl, holes: hs, polygon: poly, floorZ: 100, az: 0, burden: 4, relief: 0, rng });
  seed = 4; const v1 = throwVelocities({ blocks: bl, holes: hs, polygon: poly, floorZ: 100, az: 0, burden: 4, rng });
  const mx = (v) => v.filter((_, i) => bl[i].hole > 0).reduce((s, x) => s + x.v.x, 0);
  assert.ok(mx(v1) < mx(v0) - 50, 'bloczki późniejszych otworów zbaczają ku otwarciu serii');
}
// krótka przybitka: SDoB i wyrzut w górę bloczków nad ładunkiem
import { sdob, craterFactor } from './physics.js';
{
  const s05 = sdob({ stemTop: 0.5, kgPerM: 9, diameterMm: 102 }), s24 = sdob({ stemTop: 2.4, kgPerM: 9, diameterMm: 102 }), s4 = sdob({ stemTop: 4, kgPerM: 9, diameterMm: 102 });
  assert.ok(s05 < 0.6 && s24 > 1.3 && s4 > 1.4, `SDoB ${s05} ${s24} ${s4}`);
  assert.equal(craterFactor(s4), 0); assert.equal(craterFactor(s05), 1);
  const h0 = { x: 5, y: 3, z: 103, mass: 70, volume: 42, diameterMm: 102, kgPerM: 9 };
  const vy = (stemTop) => { seed = 5; const v = throwVelocities({ blocks, holes: [{ ...h0, stemTop }], polygon: poly, floorZ: 100, az: 90, burden: 3.5, rng }); return Math.max(...v.map((x) => x.v.y)); };
  assert.ok(vy(0.5) > vy(4) + 8, 'krótka przybitka: bloczek nad otworem wylatuje w górę');
  seed = 5; const vNo = throwVelocities({ blocks, holes: [{ ...h0, stemTop: 4 }], polygon: poly, floorZ: 100, az: 90, burden: 3.5, rng });
  seed = 5; const vOld = throwVelocities({ blocks, holes: [{ x: 5, y: 3, mass: 70, volume: 42 }], polygon: poly, floorZ: 100, az: 90, burden: 3.5, rng });
  assert.deepEqual(vNo.map((x) => x.v), vOld.map((x) => x.v), 'długa przybitka nie zmienia prędkości');
}
console.log('physics.js: OK');
