import assert from 'node:assert/strict';
import * as b from './blast.js';
import { DEFAULT_PRODUCTS } from './products.js';
import { buildIredesXml, crc32 } from './iredes.js';
import { pl2000ToLonLat } from './geo.js';
import { buildProfile } from './profile.js';

const P = DEFAULT_PRODUCTS;
const near = (a, c, e = 1e-6) => assert.ok(Math.abs(a - c) < e, `${a} != ${c}`);

// --- ładowanie otworu ---
// emulsja pompowana, Ø95: 1,2 g/cm3 -> 8,505 kg/m
let r = b.loadHole(8, [{ kind: 'charge', productId: 'emu-bulk', flex: true }], { stemming: 2.4, diameterMm: 95, products: P });
near(r.stemming, 2.4); near(r.chargeLength, 5.6); near(r.mass, b.linearLoad(1.2, 95) * 5.6);
// dwa ładunki rozdzielone przekładką, górny rozciągliwy
r = b.loadHole(10, [
  { kind: 'charge', productId: 'anfo', flex: true },
  { kind: 'deck', length: 0.5 },
  { kind: 'charge', productId: 'emu-bulk', length: 3 },
], { stemming: 2, diameterMm: 95, products: P });
near(r.segments.find((s) => s.productId === 'anfo').to - r.segments.find((s) => s.productId === 'anfo').from, 4.5);
near(r.chargeLength, 7.5); assert.equal(r.warnings.length, 0);
assert.equal(r.segments.map((s) => s.kind).join(), 'stemming,charge,deck,charge');
// ta sama reguła na krótszym otworze: przybitka i dolny ładunek bez zmian, rozciągliwy się skraca
const r2 = b.loadHole(7, [
  { kind: 'charge', productId: 'anfo', flex: true }, { kind: 'deck', length: 0.5 }, { kind: 'charge', productId: 'emu-bulk', length: 3 },
], { stemming: 2, diameterMm: 95, products: P });
near(r2.segments[0].to, 2); near(r2.byProduct['emu-bulk'], b.linearLoad(1.2, 95) * 3); near(r2.chargeLength, 4.5);
// nabój: 5,6 m / 0,5 m = 11 sztuk po 3 kg
r = b.loadHole(8, [{ kind: 'charge', productId: 'nab-80', flex: true }], { stemming: 2.4, diameterMm: 95, products: P });
assert.equal(r.segments[1].count, 11); near(r.mass, 33); near(r.chargeLength, 5.5);
// otwór płytszy niż przybitka + ładunek -> ostrzeżenie
r = b.loadHole(4, [{ kind: 'charge', productId: 'anfo', length: 5 }], { stemming: 2, diameterMm: 95, products: P });
assert.ok(r.warnings.length > 0); near(r.chargeLength, 2);

// --- IREDES ---
const xml = buildIredesXml({
  planName: 'Test', project: 'P', coordSystem: 'ETRF2000-PL / CS2000/21', createDate: '2026-01-01T00:00:00', bearing: -10,
  workOrder: { lon: 20.5, lat: 50.7, alt: 260.1 },
  holes: [{ id: 1, name: '1.1', start: { n: 5628034.4263, e: 7470221.96, z: 260.252 }, end: { n: 5628033.627, e: 7470220.498, z: 254.034 }, type: 'Undefined', dia: 95 }],
});
for (const re of [/<NumberOfHoles>1</, /<IR:PointX>5628034\.426</, /<IR:PointY>7470221\.960</, /<DrillBitDia>95</, /<IR:WorkOrder>\(20\.50000000,50\.70000000,260\.10000000\)</, /\(NEH order\)/, /<\/DRPPlan>$/]) assert.match(xml, re);
const chk = Number(xml.match(/<IR:ChkSum>(\d+)</)[1]);
assert.equal(chk, crc32(xml.slice(0, xml.indexOf('    <IR:GenTrailer>'))));
assert.equal(crc32('123456789'), 0xcbf43926); // wektor testowy CRC32

// --- PL-2000 -> lon/lat ---
const c = pl2000ToLonLat(5500000, 7500000); near(c.lon, 21, 1e-9); // południk osiowy strefy 7
const q = pl2000ToLonLat(5628000, 7470000); // wartości z walidacji względem planu Strayos (zgodność < 1e-7°)
near(q.lon, 20.57455026, 1e-7); near(q.lat, 50.78661174, 1e-7);
assert.equal(pl2000ToLonLat(5628000, 3470000), null);

// --- profil ---
const flat = () => 100;
const hole = { id: 1, name: '1.1', type: 'profile', x: 0, y: 0, z: 100, length: 8, dir: { x: 0, y: 1 * Math.sin(0.3), z: -Math.cos(0.3) }, segments: [{ kind: 'stemming', from: 0, to: 2 }, { kind: 'charge', productId: 'anfo', from: 2, to: 8 }] };
const pr = buildProfile({ origin: { x: 0, y: 0 }, azimuthDeg: 0, half: 10, band: 1, holes: [hole, { ...hole, id: 2, x: 5 }], sampleZ: flat, targets: { normal: 92, profile: 92 } });
assert.equal(pr.holes.length, 1); // drugi otwór poza pasmem
near(pr.holes[0].toe.s, 8 * Math.sin(0.3), 1e-9);
assert.ok(pr.zMin <= 92 && pr.zMax >= 100);
console.log('moduły: OK');
