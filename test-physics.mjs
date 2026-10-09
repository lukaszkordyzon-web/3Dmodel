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
console.log('physics.js: OK');
