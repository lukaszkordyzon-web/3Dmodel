// Przeliczenie współrzędnych płaskich PL-2000 (ETRF2000-PL / CS2000, strefy 5-8) na szerokość/długość geograficzną.
// Odwrotne odwzorowanie Gaussa-Krügera, szereg w n (dokładność rzędu milimetrów).
const A = 6378137, F = 1 / 298.257222101, K0 = 0.999923;

export function pl2000ToLonLat(northing, easting) {
  const zone = Math.floor(easting / 1e6);
  if (zone < 5 || zone > 8) return null; // poza PL-2000
  const lon0 = zone * 3;
  const n = F / (2 - F);
  const Ahat = (A / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
  const xi = northing / (K0 * Ahat);
  const eta = (easting - (zone * 1e6 + 500000)) / (K0 * Ahat);
  const b = [
    n / 2 - (2 / 3) * n ** 2 + (37 / 96) * n ** 3,
    n ** 2 / 48 + n ** 3 / 15,
    (17 / 480) * n ** 3,
  ];
  let xi2 = xi, eta2 = eta;
  b.forEach((bj, i) => {
    const j = i + 1;
    xi2 -= bj * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta2 -= bj * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  });
  const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
  const d = [2 * n - (2 / 3) * n ** 2 - 2 * n ** 3, (7 / 3) * n ** 2 - (8 / 5) * n ** 3, (56 / 15) * n ** 3];
  let phi = chi;
  d.forEach((dj, i) => { phi += dj * Math.sin(2 * (i + 1) * chi); });
  const lam = (lon0 * Math.PI) / 180 + Math.atan2(Math.sinh(eta2), Math.cos(xi2));
  return { lon: (lam * 180) / Math.PI, lat: (phi * 180) / Math.PI };
}
