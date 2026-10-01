import assert from 'node:assert/strict';
import * as b from './blast.js';

const sq = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }];
assert.equal(b.polygonArea(sq), 600);
assert.ok(b.pointInPolygon(5, 5, sq) && !b.pointInPolygon(40, 5, sq));

// rzędy wzdłuż wschodu: 30 m / 5 m = 6 otworów w rzędzie, 20 m / 4 m = 5 rzędów
assert.equal(b.generateGrid(sq, { burden: 4, spacing: 5, rowAzimuthDeg: 90, stagger: false }).length, 30);
assert.ok(b.generateGrid(sq, { burden: 4, spacing: 5, rowAzimuthDeg: 90, stagger: true }).length <= 30);

assert.ok(Math.abs(b.linearLoad(0.85, 115) - 8.83) < 0.01);

const h = b.holeGeometry({ x: 0, y: 0, collarZ: 110 }, { floorZ: 100, subdrill: 1, inclDeg: 0 });
assert.equal(h.length, 11);
assert.equal(h.toe.z, 99);

const c = b.chargeCalc(11, { stemming: 3, kgPerM: 8 });
assert.equal(c.chargeLength, 8);
assert.equal(c.mass, 64);
assert.equal(b.chargeCalc(2, { stemming: 3, kgPerM: 8 }).mass, 0); // wybijanie krótsze niż orczyk

console.log('blast.js: OK');
