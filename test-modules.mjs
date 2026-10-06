import assert from 'node:assert/strict';
import * as b from './blast.js';
import { DEFAULT_PRODUCTS } from './products.js';
import { buildIredesXml, crc32 } from './iredes.js';
import { pl2000ToLonLat } from './geo.js';
import { buildProfile } from './profile.js';

// produkty bez spęcznienia (gęstość docelowa = brak), dla testów klasycznych obliczeń; spęcznienie testuje PG niżej
const P = DEFAULT_PRODUCTS.map((p) => (p.id === 'emu-bulk' ? { ...p, densityTarget: undefined } : p));
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


// --- szablon v2: przesypka o ustalonym położeniu, ładunek się doblicza ---
const emu = b.linearLoad(1.2, 95);
r = b.loadHole(10, [
  { kind: 'charge', productId: 'emu-bulk', by: 'rest' },
  { kind: 'deck', by: 'length', length: 0.5, anchor: 'depth', at: 6 },
  { kind: 'charge', productId: 'emu-bulk', by: 'rest' },
], { stemming: 2, diameterMm: 95, products: P });
assert.equal(r.segments.map((s) => s.kind).join(), 'stemming,charge,deck,charge');
near(r.segments[1].from, 2); near(r.segments[1].to, 6); near(r.segments[2].from, 6); near(r.segments[2].to, 6.5); near(r.segments[3].to, 10);
near(r.mass, emu * (4 + 3.5)); assert.equal(r.warnings.length, 0);
// kotwica na rzędnej: kolar 100, otwór pionowy, przesypka na rzędnej 94 -> głębokość 6
r = b.loadHole(10, [{ kind: 'charge', productId: 'anfo', by: 'rest' }, { kind: 'deck', by: 'length', length: 1, anchor: 'elev', at: 94 }, { kind: 'charge', productId: 'anfo', by: 'rest' }],
  { stemming: 2, diameterMm: 95, products: P, depthAtElevation: (e) => 100 - e });
near(r.segments.find((s) => s.kind === 'deck').from, 6);
// ten sam szablon na otworze o innej wysokości kolaru (105): przesypka na tej samej rzędnej, czyli 11 m od wlotu
r = b.loadHole(16, [{ kind: 'charge', productId: 'anfo', by: 'rest' }, { kind: 'deck', by: 'length', length: 1, anchor: 'elev', at: 94 }, { kind: 'charge', productId: 'anfo', by: 'rest' }],
  { stemming: 2, diameterMm: 95, products: P, depthAtElevation: (e) => 105 - e });
near(r.segments.find((s) => s.kind === 'deck').from, 11);

// --- szablon v2: zadana masa MW, przesypka się dopasowuje ---
r = b.loadHole(12, [
  { kind: 'charge', productId: 'emu-bulk', by: 'mass', mass: 20 },
  { kind: 'deck', by: 'rest' },
  { kind: 'charge', productId: 'emu-bulk', by: 'mass', mass: 15 },
], { stemming: 2, diameterMm: 95, products: P });
near(r.mass, 35, 1e-9);
const deck = r.segments.find((s) => s.kind === 'deck'); near(deck.to - deck.from, 10 - 35 / emu, 1e-9);
// masa w nabojach: 10 kg po 3 kg -> 3 naboje = 9 kg
r = b.loadHole(12, [{ kind: 'charge', productId: 'nab-80', by: 'mass', mass: 10 }, { kind: 'deck', by: 'rest' }], { stemming: 2, diameterMm: 95, products: P });
assert.equal(r.segments[1].count, 3); near(r.mass, 9); near(r.segments[1].to - r.segments[1].from, 1.5);
// zbyt duża masa: ostrzeżenie o obcięciu
r = b.loadHole(5, [{ kind: 'charge', productId: 'emu-bulk', by: 'mass', mass: 100 }], { stemming: 2, diameterMm: 95, products: P });
assert.ok(r.warnings.length > 0); near(r.chargeLength, 3);
// niewypełniony koniec otworu daje ostrzeżenie
r = b.loadHole(10, [{ kind: 'charge', productId: 'anfo', by: 'length', length: 3 }], { stemming: 2, diameterMm: 95, products: P });
assert.ok(r.warnings.some((w) => /Niewypełniony/.test(w))); near(r.segments.at(-1).to - r.segments.at(-1).from, 5);

// --- air deck i wkładka otworowa ---
r = b.loadHole(12, [
  { kind: 'charge', productId: 'emu-bulk', by: 'length', length: 3 },
  { kind: 'deck', material: 'air', plug: true, plugLen: 0.3, by: 'rest' },
  { kind: 'charge', productId: 'emu-bulk', by: 'mass', mass: 17.01 },
], { stemming: 2, diameterMm: 95, products: P });
assert.equal(r.segments.map((s) => s.kind).join(), 'stemming,charge,plug,air,charge');
assert.equal(r.plugs, 1); near(r.segments[2].to - r.segments[2].from, 0.3);
near(r.airLength, 10 - 3 - 17.01 / emu - 0.3, 1e-6);
near(r.mass, emu * 3 + 17.01, 1e-6);                      // air deck i wkładka nie dodają masy MW
// air deck zakotwiczony na rzędnej, bez wkładki
r = b.loadHole(10, [{ kind: 'charge', productId: 'anfo', by: 'rest' }, { kind: 'deck', material: 'air', by: 'length', length: 1.5, anchor: 'depth', at: 5 }, { kind: 'charge', productId: 'anfo', by: 'rest' }],
  { stemming: 2, diameterMm: 95, products: P });
assert.equal(r.plugs, 0); near(r.airLength, 1.5); assert.equal(r.segments.map((s) => s.kind).join(), 'stemming,charge,air,charge');
// wkładka dłuższa niż odcinek: cały odcinek to wkładka
r = b.loadHole(8, [{ kind: 'charge', productId: 'anfo', by: 'length', length: 2 }, { kind: 'deck', material: 'air', plug: true, plugLen: 1, by: 'length', length: 0.4 }, { kind: 'charge', productId: 'anfo', by: 'rest' }], { stemming: 2, diameterMm: 95, products: P });
assert.equal(r.plugs, 1); assert.equal(r.airLength, 0);
// przesypka (materiał obojętny) nie zlicza wkładek
r = b.loadHole(8, [{ kind: 'charge', productId: 'anfo', by: 'rest' }, { kind: 'deck', plug: true, by: 'length', length: 1 }], { stemming: 2, diameterMm: 95, products: P });
assert.equal(r.plugs, 0); assert.ok(r.segments.some((s) => s.kind === 'deck'));

// --- emulsja: gęstość początkowa i docelowa ---
const PG = [{ id: 'emu-g', name: 'Emulsja', kind: 'bulk', density: 1.2, densityTarget: 1.0, gassMin: 15 }, ...P];
const lin10 = b.linearLoad(1.0, 95), lin12 = b.linearLoad(1.2, 95);
// z czasem na spęcznienie: masa wg gęstości docelowej na długość końcową, po załadowaniu kolumna krótsza (5 z 6 m)
r = b.loadHole(10, [{ kind: 'charge', productId: 'emu-g', by: 'rest' }], { stemming: 4, diameterMm: 95, products: PG });
near(r.mass, lin10 * 6); near(r.segments[1].loadLen, 5); near(r.segments[1].rise, 1); near(r.maxRise, 1); assert.equal(r.segments[1].gassMin, 15);
// bez czekania (przybitka od razu): masa wg gęstości początkowej, brak podniesienia
r = b.loadHole(10, [{ kind: 'charge', productId: 'emu-g', by: 'rest' }], { stemming: 4, diameterMm: 95, products: PG, gassWait: false });
near(r.mass, lin12 * 6); assert.equal(r.segments[1].rise, undefined); assert.equal(r.maxRise, 0);
// ta sama masa 20 kg: końcowa długość kolumny zależy od gęstości docelowej
r = b.loadHole(12, [{ kind: 'charge', productId: 'emu-g', by: 'mass', mass: 20 }, { kind: 'deck', by: 'rest' }], { stemming: 2, diameterMm: 95, products: PG });
near(r.segments[1].to - r.segments[1].from, 20 / lin10); near(r.mass, 20);
r = b.loadHole(12, [{ kind: 'charge', productId: 'emu-g', by: 'mass', mass: 20 }, { kind: 'deck', by: 'rest' }], { stemming: 2, diameterMm: 95, products: PG, gassWait: false });
near(r.segments[1].to - r.segments[1].from, 20 / lin12);
// korek: air deck pod korkiem liczony po spęcznieniu; w chwili zakładania korka dłuższy o podniesienie kolumny pod nim
r = b.loadHole(12, [
  { kind: 'charge', productId: 'anfo', by: 'length', length: 2 },
  { kind: 'deck', material: 'air', plug: true, plugLen: 0.3, by: 'length', length: 1.5, anchor: 'depth', at: 5 },
  { kind: 'charge', productId: 'emu-g', by: 'rest' },
], { stemming: 2, diameterMm: 95, products: PG });
const air = r.segments.find((s) => s.kind === 'air'), emuSeg = r.segments.find((s) => s.productId === 'emu-g');
near(air.to - air.from, 1.2); near(air.airAtLoad, 1.2 + emuSeg.rise); assert.ok(emuSeg.rise > 0);
// produkt bez gęstości docelowej zachowuje się jak dotąd
r = b.loadHole(10, [{ kind: 'charge', productId: 'anfo', by: 'rest' }], { stemming: 2, diameterMm: 95, products: P });
assert.equal(r.maxRise, 0); near(r.mass, b.linearLoad(0.85, 95) * 8);

// --- długość otworu: do rzędnej dna albo stała ---
const g1 = b.holeGeometry({ x: 0, y: 0, collarZ: 110 }, { floorZ: 100, subdrill: 1 });
const g2 = b.holeGeometry({ x: 0, y: 0, collarZ: 105 }, { floorZ: 100, subdrill: 1 });
near(g1.toe.z, 99); near(g2.toe.z, 99); near(g2.length, 6); // dno na stałej rzędnej
const g3 = b.holeGeometry({ x: 0, y: 0, collarZ: 105 }, { floorZ: 100, subdrill: 1, fixedLength: 8 });
near(g3.length, 8); near(g3.toe.z, 97);

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
