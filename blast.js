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

function distToEdge(x, y, poly) {
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
export function holeGeometry({ x, y, collarZ }, { floorZ, subdrill, inclDeg = 0, azimuthDeg = 0 }) {
  const inc = (inclDeg * Math.PI) / 180, az = (azimuthDeg * Math.PI) / 180;
  const vertical = Math.max(0, collarZ - floorZ + subdrill);
  const length = vertical / Math.cos(inc);
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
