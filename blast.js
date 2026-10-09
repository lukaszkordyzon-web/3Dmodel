// Obliczenia projektu strzałowego. Współrzędne lokalne: X, Y poziomo, Z w górę (metry).

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return Math.abs(a) / 2;
}

// Siatka otworów w obrysie. burden = odległość między rzędami, spacing = odstęp w rzędzie.
// rowAzimuthDeg: kierunek rzędów (0 = północ/+Y, zgodnie z ruchem wskazówek zegara).
// stagger: szachownica (co drugi rząd przesunięty o pół odstępu).
export function generateGrid(poly, { burden, spacing, rowAzimuthDeg = 0, stagger = true, edgeOffset = 0 }) {
  if (poly.length < 3 || burden <= 0 || spacing <= 0) return [];
  const az = (rowAzimuthDeg * Math.PI) / 180;
  const ux = Math.sin(az), uy = Math.cos(az); // wzdłuż rzędu
  const vx = Math.cos(az), vy = -Math.sin(az); // prostopadle do rzędu (kierunek odspajania)
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of poly) {
    const u = p.x * ux + p.y * uy, v = p.x * vx + p.y * vy;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const pts = [];
  let row = 0;
  for (let v = minV + burden / 2; v <= maxV; v += burden, row++) {
    const shift = stagger && row % 2 ? spacing / 2 : 0;
    for (let u = minU + spacing / 2 + shift; u <= maxU; u += spacing) {
      const x = u * ux + v * vx, y = u * uy + v * vy;
      if (pointInPolygon(x, y, poly) && distToEdge(x, y, poly) >= edgeOffset) pts.push({ x, y, row, u, v });
    }
  }
  return pts;
}

export function distToEdge(x, y, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x, ay = poly[j].y, bx = poly[i].x, by = poly[i].y;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

// kg na metr bieżący otworu: gęstość [g/cm3], średnica [mm].
export function linearLoad(densityGcc, diameterMm) {
  return (densityGcc * Math.PI * diameterMm * diameterMm) / 4000;
}

// Geometria jednego otworu. inclDeg = odchylenie od pionu, azimuthDeg = kierunek pochylenia.
// subdrill liczony w pionie poniżej poziomu spągu.
export function holeGeometry({ x, y, collarZ }, { floorZ, subdrill, inclDeg = 0, azimuthDeg = 0, fixedLength = null }) {
  const inc = (inclDeg * Math.PI) / 180, az = (azimuthDeg * Math.PI) / 180;
  const vertical = Math.max(0, collarZ - floorZ + subdrill);
  const length = fixedLength != null ? fixedLength : vertical / Math.cos(inc); // stała długość albo do rzędnej dna
  const dir = { x: Math.sin(inc) * Math.sin(az), y: Math.sin(inc) * Math.cos(az), z: -Math.cos(inc) };
  const toe = { x: x + dir.x * length, y: y + dir.y * length, z: collarZ + dir.z * length };
  return { length, dir, toe, benchHeight: Math.max(0, collarZ - floorZ) };
}

export function chargeCalc(length, { stemming, kgPerM, decking = 0 }) {
  const stem = Math.min(stemming, length);
  const chargeLen = Math.max(0, length - stem - decking);
  return { stemming: stem, chargeLength: chargeLen, mass: chargeLen * kgPerM };
}

// Wartości orientacyjne (reguły kciuka) dla średnicy otworu [mm]; do weryfikacji przez uprawnioną osobę.
export function suggestParameters(diameterMm) {
  const d = diameterMm / 1000;
  const burden = Math.round(30 * d * 10) / 10;
  return {
    burden,
    spacing: Math.round(burden * 1.15 * 10) / 10,
    subdrill: Math.round(0.3 * burden * 10) / 10,
    stemming: Math.round(0.7 * burden * 10) / 10,
  };
}

export function summarize(holes, areaM2) {
  let totalLen = 0, totalMass = 0, volume = 0;
  for (const h of holes) {
    totalLen += h.length; totalMass += h.mass; volume += h.volume ?? 0;
  }
  return {
    count: holes.length, totalLength: totalLen, totalMass, volume,
    powderFactor: volume > 0 ? totalMass / volume : 0,
    specificDrilling: volume > 0 ? totalLen / volume : 0,
    areaM2,
  };
}

// Ładowanie otworu wg szablonu. Przybitka (od wlotu) jest stała. Szablon to lista od góry do dołu:
//   ładunek: { kind: 'charge', productId, by: 'rest' | 'length' | 'mass', length (m), mass (kg) }
//   przesypka: { kind: 'deck', by: 'length' | 'rest', length (m), anchor?: 'depth' | 'elev', at? (m od wlotu lub m n.p.m.),
//                material?: 'filler' (przesypka) | 'air' (air deck), plug?: bool, plugLen? (m, wkładka otworowa na górze odcinka powietrznego) }
// Przesypka z anchor ma ustalone położenie. Ładunek tuż nad nią liczy się sam, żeby do niej sięgnąć.
// „reszta” wypełnia pozostałe miejsce w sekcji: ładunek (masa MW się doblicza) albo przesypka (dopasowuje się do zadanej masy MW).
// Dawny zapis (flex, length) jest nadal obsługiwany. depthAtElevation(m n.p.m.) -> głębokość wzdłuż otworu.
// Geometria szablonu to stan KOŃCOWY (po spęcznieniu emulsji). Produkt sypki ma density (początkowa, przy załadunku)
// i opcjonalnie densityTarget (docelowa, po spęcznieniu). gassWait = true: odczekujemy na spęcznienie przed przybitką i korkiem,
// więc masa wynika z gęstości docelowej na długość końcową, a w chwili załadunku kolumna jest krótsza (loadLen, rise).
// gassWait = false: przybitka/korek od razu, kolumna nie ma gdzie rosnąć, masa wg gęstości początkowej.
export function loadHole(length, template, { stemming, diameterMm, products, depthAtElevation, gassWait = true }) {
  const warnings = [];
  const stem = Math.min(stemming, length);
  const prod = (id) => products.find((p) => p.id === id);
  const gassing = (p) => gassWait && p.kind !== 'cartridge' && p.densityTarget > 0 && p.densityTarget < p.density;
  const rho = (p) => (gassWait && p.kind !== 'cartridge' && p.densityTarget > 0 ? p.densityTarget : p.density);
  const lin = (p) => linearLoad(rho(p), diameterMm);

  const els = template.map((t) => {
    const e = { kind: t.kind, productId: t.productId, by: t.by ?? (t.flex ? 'rest' : 'length'), len: null, anchorDepth: null };
    if (t.kind === 'deck') {
      if (e.by === 'mass') e.by = 'length';
      e.material = t.material === 'air' ? 'air' : 'filler';
      e.plug = e.material === 'air' && !!t.plug;
      e.plugLen = Math.max(0, t.plugLen ?? 0.3);
      if (t.anchor === 'depth') e.anchorDepth = t.at;
      else if (t.anchor === 'elev' && depthAtElevation) e.anchorDepth = depthAtElevation(t.at);
      if (e.anchorDepth != null && !Number.isFinite(e.anchorDepth)) e.anchorDepth = null;
      if (e.anchorDepth != null) e.by = 'length'; // przesypka zakotwiczona ma zadaną długość
      if (e.by === 'length') e.len = Math.max(0, t.length || 0);
      return e;
    }
    const p = prod(t.productId);
    if (e.by === 'length') e.len = Math.max(0, t.length || 0);
    else if (e.by === 'mass') {
      if (!p) { e.len = 0; warnings.push('Brak produktu w bazie MW.'); }
      else if (p.kind === 'cartridge') e.len = (Math.max(0, Math.round((t.mass || 0) / p.cartMass)) * p.cartLen) / 1000;
      else e.len = lin(p) > 0 ? Math.max(0, (t.mass || 0) / lin(p)) : 0;
    }
    return e;
  });

  // sekcje rozdzielone przesypkami o ustalonym położeniu
  const parts = [];
  let a = stem, cur = [];
  const close = (to) => { parts.push({ type: 'section', els: cur, a, b: to }); cur = []; };
  for (const e of els) {
    if (e.kind === 'deck' && e.anchorDepth != null) {
      if (e.anchorDepth < a - 1e-9) warnings.push('Przesypka o ustalonym położeniu leży wyżej niż koniec poprzedniego elementu, przesunięto ją w dół.');
      if (e.anchorDepth > length + 1e-9) warnings.push('Przesypka o ustalonym położeniu leży poniżej dna otworu.');
      const from = Math.min(Math.max(e.anchorDepth, a), length), to = Math.min(from + e.len, length);
      close(from);
      parts.push({ type: 'deck', from, to, el: e });
      a = to;
    } else cur.push(e);
  }
  close(length);

  const segments = [{ kind: 'stemming', from: 0, to: stem }];
  const byProduct = {};
  let mass = 0, chargeLength = 0, plugs = 0, airLength = 0, maxRise = 0;
  // przesypka (materiał obojętny) albo air deck; wkładka otworowa podtrzymuje to, co leży nad odcinkiem powietrznym
  const pushDeck = (e, from, to) => {
    if (to - from <= 1e-9) return;
    if (e.material !== 'air') { segments.push({ kind: 'deck', from, to }); return; }
    let start = from;
    if (e.plug) {
      const pl = Math.min(e.plugLen, to - from);
      if (pl > 1e-9) { segments.push({ kind: 'plug', from, to: from + pl }); plugs++; start = from + pl; }
    }
    if (to - start > 1e-9) { segments.push({ kind: 'air', from: start, to }); airLength += to - start; }
  };
  const empty = (from, to, why) => { if (to - from > 1e-6) { segments.push({ kind: 'empty', from, to }); if (why) warnings.push(why); } };
  const placeCharge = (e, from, len) => {
    const p = prod(e.productId);
    if (!p) { warnings.push('Brak produktu w bazie MW.'); empty(from, from + len); return; }
    let eff = len, m;
    if (p.kind === 'cartridge') {
      const cl = p.cartLen / 1000, n = Math.floor(len / cl + 1e-9);
      eff = n * cl; m = n * p.cartMass;
      if (p.cartDia > diameterMm) warnings.push(`Nabój ${p.name} (Ø${p.cartDia}) jest szerszy niż otwór (Ø${diameterMm}).`);
      if (n === 0) warnings.push(`Odcinek ${len.toFixed(2)} m jest krótszy niż jeden nabój ${p.name}.`);
      else segments.push({ kind: 'charge', productId: p.id, from, to: from + eff, mass: m, count: n });
      empty(from + eff, from + len);
    } else {
      m = lin(p) * len;
      const seg = { kind: 'charge', productId: p.id, from, to: from + len, mass: m };
      if (gassing(p)) { // po załadowaniu kolumna jest krótsza i dopiero po spęcznieniu sięga do projektowanej góry
        seg.loadLen = (len * p.densityTarget) / p.density;
        seg.rise = len - seg.loadLen;
        seg.gassMin = p.gassMin || 0;
        maxRise = Math.max(maxRise, seg.rise);
      }
      segments.push(seg);
    }
    mass += m; chargeLength += eff;
    byProduct[p.id] = (byProduct[p.id] ?? 0) + m;
  };

  parts.forEach((part, pi) => {
    if (part.type === 'deck') { pushDeck(part.el, part.from, part.to); return; }
    const W = Math.max(0, part.b - part.a), last = pi === parts.length - 1;
    const rest = part.els.filter((e) => e.by === 'rest');
    if (rest.length > 1) warnings.push('Więcej niż jeden element „reszta” w jednym odcinku, użyto pierwszego.');
    let absorber = rest[0];
    if (!absorber && !last) absorber = [...part.els].reverse().find((e) => e.kind === 'charge'); // sięga do przesypki o ustalonym położeniu
    for (const e of rest.slice(1)) e.len = 0;
    const fixedSum = part.els.reduce((s, e) => s + (e === absorber || e.len == null ? 0 : e.len), 0);
    if (absorber) absorber.len = Math.max(0, W - fixedSum);
    if (fixedSum > W + 1e-9) warnings.push('Elementy nie mieszczą się w otworze, dolne obcięto.');
    let pos = part.a;
    for (const e of part.els) {
      const len = Math.min(e.len ?? 0, part.b - pos);
      if (len <= 1e-9) continue;
      if (e.kind === 'deck') pushDeck(e, pos, pos + len);
      else placeCharge(e, pos, len);
      pos += len;
    }
    empty(pos, part.b, last ? `Niewypełniony odcinek ${(part.b - pos).toFixed(2)} m przy dnie otworu.` : 'Odcinek bez ładunku nad przesypką.');
  });
  // Odcinek powietrzny nad kolumną, która jeszcze się podniesie: w chwili zakładania korka jest dłuższy o to podniesienie.
  segments.forEach((s, i) => {
    const below = segments[i + 1];
    if (s.kind === 'air' && below?.kind === 'charge' && below.rise > 0) s.airAtLoad = s.to - s.from + below.rise;
  });
  return { segments, mass, chargeLength, stemming: stem, byProduct, plugs, airLength, maxRise, warnings: [...new Set(warnings)] };
}
