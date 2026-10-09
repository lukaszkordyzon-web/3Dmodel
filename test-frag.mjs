import assert from 'node:assert/strict';
import { lillyA, kuzRam, passing, retained, sizeAt, sample } from './fragmentation.js';
import { buildBlocks, autoBlockSize, faceAzimuth, distanceToEdge } from './blocks.js';
import { polygonArea } from './blast.js';
const near = (a, c, e = 1e-9) => assert.ok(Math.abs(a - c) < e, `${a} != ${c}`);

// Lilly: masywna, rzadkie spękania wpadające w głąb, ρ=2,7, UCS 150 MPa (E>=50) -> 0,06 (50+90+17,5+30) = 11,25
near(lillyA({ rmd: 'massive', jps: 'wide', jpa: 'into', density: 2.7, youngGpa: 60, ucsMpa: 150 }), 11.25);
// E<50: twardość E/3
near(lillyA({ rmd: 'jointed', jps: 'medium', jpa: 'perpendicular', density: 2.6, youngGpa: 30, ucsMpa: 80 }), 0.06 * (20 + 20 + 30 + 15 + 10));

// Kuz-Ram: obliczenie ręczne X50 = A (V/Q)^0,8 Q^(1/6) (115/E)^(19/30)
const base = { A: 10, Q: 80, V0: 140, rws: 100, B: 3.5, S: 4, D: 95, W: 0.2, L: 7, BCL: 7, CCL: 0, H: 10 };
let r = kuzRam(base);
near(r.x50, 10 * 1.75 ** 0.8 * 80 ** (1 / 6) * 1.15 ** (19 / 30), 1e-9); assert.ok(r.x50 > 30 && r.x50 < 40);
assert.ok(r.n > 0.3 && r.n < 3);
// więcej MW (przy tej samej objętości) -> drobniej; mocniejszy MW -> drobniej; twardsza skała -> grubiej
assert.ok(kuzRam({ ...base, Q: 120 }).x50 < r.x50);
assert.ok(kuzRam({ ...base, rws: 120 }).x50 < r.x50);
assert.ok(kuzRam({ ...base, A: 13 }).x50 > r.x50);
// większy B/D pogarsza jednorodność (n maleje)
assert.ok(kuzRam({ ...base, B: 4.5, S: 5, V0: 4.5 * 5 * 10 }).n < kuzRam({ ...base, B: 3, S: 3.5, V0: 3 * 3.5 * 10 }).n);

// Rosin-Rammler
near(passing(r.x50, r.x50, r.n), 0.5); near(retained(r.x50, r.x50, r.n), 0.5);
near(sizeAt(0.5, r.x50, r.n), r.x50, 1e-9); near(passing(sizeAt(0.8, 30, 1.4), 30, 1.4), 0.8);
assert.ok(sizeAt(0.8, 30, 1.4) > 30 && sizeAt(0.2, 30, 1.4) < 30);
near(sample(0.5, 30, 1.4), 30, 1e-9);

// bloczki: płaski teren 105, spąg 100, obrys 20x10 -> objętość = 20*10*5
const poly = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }];
const flat = () => 105;
const blocks = buildBlocks({ polygon: poly, sampleZ: flat, floorZ: 100, size: 1, holes: [{ x: 5, y: 5 }, { x: 15, y: 5 }] });
near(blocks.reduce((s, b) => s + b.sx * b.sy * b.sz, 0), 20 * 10 * 5, 1e-6); assert.equal(blocks.length, 20 * 10 * 5);
assert.ok(blocks.every((b) => b.z - b.sz / 2 >= 100 - 1e-9 && b.z + b.sz / 2 <= 105 + 1e-9));
assert.ok(blocks.filter((b) => b.x < 10).every((b) => b.hole === 0) && blocks.filter((b) => b.x > 10).every((b) => b.hole === 1));
// teren niższy pod ścianą: bloczki dopasowują się do terenu, brak bloczków poniżej spągu
const slope = (x) => 100 + Math.max(0, 5 - x * 0.25);
const sb = buildBlocks({ polygon: poly, sampleZ: slope, floorZ: 100, size: 1, holes: [{ x: 5, y: 5 }] });
assert.ok(sb.every((b) => b.z - b.sz / 2 >= 100 - 1e-9));
assert.ok(autoBlockSize(poly, flat, 100, 100) > autoBlockSize(poly, flat, 100, 5000));
assert.ok(autoBlockSize(poly, flat, 100, 100) <= 5);
// kierunek do wolnej ściany: teren spada ku +X (azymut 90)
const down = (x) => (x > 20 ? 95 : 105);
const az = faceAzimuth({ polygon: poly, sampleZ: down });
near(az, 90, 1e-6);
// ściana od północy (teren spada ku +Y) i od południowego zachodu
near(faceAzimuth({ polygon: poly, sampleZ: (x, y) => (y > 10 ? 95 : 105) }), 0, 1e-6);
near(faceAzimuth({ polygon: poly, sampleZ: (x, y) => (y < 0 ? 95 : 105) }), 180, 1e-6);
assert.equal(faceAzimuth({ polygon: poly, sampleZ: () => 105, fallbackAz: 33 }), 33); // płasko: bez ściany
// brak danych terenu poza modelem nie jest „wolną ścianą”: model tylko po stronie zachodniej (x<=20), teren spada ku wschodowi
const partial = (x) => (x > 40 ? null : x > 20 ? 95 : 105);
const az2 = faceAzimuth({ polygon: poly, sampleZ: partial, fallbackAz: 17 });
assert.ok(az2 > 30 && az2 < 150, `az2 ${az2}`);
assert.equal(faceAzimuth({ polygon: poly, sampleZ: () => null, fallbackAz: 17 }), 17);
// odległość do krawędzi w kierunku +X z punktu (15,5) w obrysie 20x10: 5 m
near(distanceToEdge(poly, 15, 5, 90), 5, 1e-9); near(distanceToEdge(poly, 15, 5, 0), 5, 1e-9);
console.log('fragmentation.js, blocks.js: OK');
