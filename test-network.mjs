import assert from 'node:assert/strict';
import { computeTiming, maxChargeInWindow, groupByTime, autoNetwork } from './network.js';
const near = (a, c, e = 1e-9) => assert.ok(Math.abs(a - c) < e, `${a} != ${c}`);

// siatka 3 rzędy × 5 otworów, u rośnie wzdłuż rzędu
const holes = []; let id = 100;
for (let r = 0; r < 3; r++) for (let k = 0; k < 5; k++) holes.push({ id: id++, row: r, u: 2.5 + k * 4 + (r % 2) * 2, k, r });
const ids = holes.map((h) => h.id);

let net = autoNetwork(holes, { pattern: 'rows', alongMs: 17, betweenMs: 42 });
assert.equal(net.starts.length, 1); assert.equal(net.links.length, 3 * 4 + 2);
let t = computeTiming(ids, net.links, net.starts, 500);
for (const h of holes) near(t.time.get(h.id), 500 + h.r * 42 + h.k * 17);
assert.equal(t.unreachable.length, 0); near(t.totalMs, 500 + 2 * 42 + 4 * 17);

net = autoNetwork(holes, { pattern: 'V', alongMs: 17, betweenMs: 42 });
t = computeTiming(ids, net.links, net.starts, 500);
const k0 = 2;
for (const h of holes.filter((x) => x.r === 0)) near(t.time.get(h.id), 500 + Math.abs(h.k - k0) * 17);
assert.equal(t.unreachable.length, 0);
// każdy otwór ma jedno połączenie wchodzące
const incoming = new Map(); for (const l of net.links) incoming.set(l.to, (incoming.get(l.to) ?? 0) + 1);
assert.ok([...incoming.values()].every((n) => n === 1));

// otwór bez inicjacji i cykl bez punktu startowego
t = computeTiming([1, 2, 3, 4], [{ from: 1, to: 2, ms: 25 }, { from: 3, to: 4, ms: 25 }, { from: 4, to: 3, ms: 25 }], [1], 500);
assert.deepEqual(t.unreachable.sort(), [3, 4]); near(t.time.get(2), 525);
// opóźnienie w otworze zależne od otworu
t = computeTiming([1, 2], [{ from: 1, to: 2, ms: 10 }], [1], (i) => (i === 1 ? 400 : 600));
near(t.time.get(1), 400); near(t.time.get(2), 610);
// dwa punkty inicjacji
t = computeTiming([1, 2, 3], [{ from: 1, to: 2, ms: 10 }], [1, 3], 500);
near(t.time.get(3), 500);

// ładunek na opóźnienie
const items = [{ t: 500, mass: 50 }, { t: 505, mass: 40 }, { t: 520, mass: 60 }, { t: 521, mass: 30 }, { t: 700, mass: 80 }];
let m = maxChargeInWindow(items, 8); near(m.mass, 90); near(m.at, 500 + 0); // 50+40
m = maxChargeInWindow(items, 2); near(m.mass, 90); // 60+30 w oknie 520-521 albo 80 — max 90
m = maxChargeInWindow(items, 0); near(m.mass, 80);
const g = groupByTime([{ t: 500, mass: 10 }, { t: 500.2, mass: 5 }, { t: 542, mass: 7 }]);
assert.equal(g.length, 2); near(g[0].mass, 15); assert.equal(g[0].count, 2);
console.log('network.js: OK');
