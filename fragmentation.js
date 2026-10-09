// Szacowanie fragmentacji: model Kuz-Ram (Kuznetsov + Cunningham) z rozkładem Rosina-Rammlera.
// Metoda empiryczna, wymagająca kalibracji na danych z kopalni. Wyniki mają charakter poglądowy.

// Współczynnik skały A wg Lilly (opis masywu, spękania, gęstość, twardość).
export const LILLY = {
  rmd: { powdery: 10, jointed: 20, massive: 50 },          // opis masywu skalnego
  jps: { close: 10, medium: 20, wide: 50 },                // odstęp spękań: <0,1 m, 0,1-1 m, >1 m
  jpa: { out: 20, perpendicular: 30, into: 40 },           // kąt spękań względem ociosu: w stronę ociosu, prostopadle, w głąb
};

export function lillyA({ rmd, jps, jpa, density, youngGpa, ucsMpa }) {
  const rdi = 25 * density - 50;                            // gęstość [t/m3]
  const hf = youngGpa < 50 ? youngGpa / 3 : ucsMpa / 5;     // twardość: E [GPa] albo UCS [MPa]
  return 0.06 * (LILLY.rmd[rmd] + LILLY.jps[jps] + LILLY.jpa[jpa] + rdi + hf);
}

// A: współczynnik skały; Q: ładunek na otwór [kg]; V0: objętość na otwór B*S*H [m3]; rws: względna siła materiału (ANFO = 100)
// B, S: burden i odstęp [m]; D: średnica [mm]; W: odchylenie standardowe dokładności wiercenia [m];
// L: długość ładunku, BCL: ładunek denny, CCL: reszta ładunku [m]; H: wysokość ławy [m].
export function kuzRam({ A, Q, V0, rws = 100, B, S, D, W = 0.2, L, BCL, CCL, H }) {
  const x50 = A * (V0 / Q) ** 0.8 * Q ** (1 / 6) * (115 / rws) ** (19 / 30); // cm
  let n = (2.2 - (14 * B) / D) * Math.sqrt((1 + S / B) / 2) * (1 - W / B) * (Math.abs(BCL - CCL) / L + 0.1) ** 0.1 * (L / H);
  n = Math.min(Math.max(n, 0.3), 3);
  return { x50, n, xc: x50 / Math.LN2 ** (1 / n) };
}

// Rozkład Rosina-Rammlera: udział przechodzący przez sito x [cm].
export const passing = (x, x50, n) => 1 - Math.exp(-Math.LN2 * (x / x50) ** n);
export const retained = (x, x50, n) => Math.exp(-Math.LN2 * (x / x50) ** n);
// Rozmiar [cm], przy którym przechodzi udział p (0..1).
export const sizeAt = (p, x50, n) => x50 * (-Math.log(1 - p) / Math.LN2) ** (1 / n);
// Losowy rozmiar [cm] z rozkładu (u z (0,1)).
export const sample = (u, x50, n) => sizeAt(Math.min(Math.max(u, 1e-9), 1 - 1e-9), x50, n);
