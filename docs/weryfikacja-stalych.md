# Weryfikacja stałych modelu symulacji odstrzału

Stan: 10.10.2026. Źródła sprawdzane przez wyszukiwarkę; pełne teksty PDF były z tego środowiska niedostępne (blokada sieci),
więc wzory oznaczone „do potwierdzenia w oryginale” trzeba sprawdzić w źródle przed użyciem produkcyjnym.

Oznaczenia: **[R]** równanie/model zweryfikowany w literaturze, **[P]** zakres z pomiarów terenowych, **[Z]** założenie bez źródła.

## 1. Prędkość rzutu (V_REF = 5 m/s przy pf 0,5) — [Z], są modele i pomiary do kalibracji

| Źródło | Co daje | Status |
|---|---|---|
| Richards & Moore (2004), „Flyrock control — by chance or design”, ISEE | v = k·(√m / B)^1,3, zasięg L = (k²/g)·(√m/B)^2,6 (face burst); m – ładunek [kg/m], B – zabiór [m], k = 13,5 (skała miękka) … 27 (twarda), kalibrowane (np. k = 21 w jednym studium) | [R] forma potwierdzona w kilku raportach (Terrock), dokładne położenie √m do potwierdzenia w oryginale; to **górna obwiednia** (flyrock), nie średnia prędkość masy |
| Zhang, Chi, Yi (2021), JRMGE 13(4):767–773 | analityczna zależność prędkości zabioru od B/d (maleje ze wzrostem B/d), z energii MW, gęstości skały i MW, kąta odłamu; zgodna z 37 strzałami terenowymi (Ø 64–310 mm) | [R] — dokładny wzór (r. 6) do pobrania z oryginału (open access, repozytorium Oulu) |
| Pomiary szybką kamerą | 6,5–23,8 m/s (5 strzałów, B 2,3–6,6 m); 9,3 m/s wierzch ławy; ~6 m/s optimum rozdrobnienia (Jharia); 15–30 m/s (OSMRE, szkolenie) | [P] |

Wniosek: 5 m/s przy ścianie jest na **dolnej granicy** pomiarów. Dla demo (m ≈ 9 kg/m, B = 4 m): R&M daje 9–19 m/s (k = 13,5–27) jako maksimum.
Rekomendacja: zastąpić stałą V_REF wzorem R&M z k do kalibracji (k_masy < k_flyrock), krzywa pf (z doświadczenia użytkownika) zostaje jako korekta.

## 2. Spęcznienie / podrzut (HEAVE = 6 m/s, profil 40–100 %) — [Z]

- Nie znalazłem równania na pionową prędkość wierzchu ławy. Jedyny pomiar: 9,3 m/s dla tarczy na wierzchu ławy (kamieniołomy Hiszpania/Austria) — [P], pojedynczy.
- Współczynnik spulchnienia urobku: 1,3–1,8 (tabele, skała twarda 1,5–1,8) — [P], dotyczy objętości końcowej, nie prędkości.
- Favreau (1993, CIM) — model komputerowy spulchnienia (SABREX/Blo-Up) — [R], niedostępny w treści.
Rekomendacja: zostawić jako parametr kalibracyjny; sprawdzić podrzut z filmu z drona (wysokość h → v = √(2gh)).

## 3. Kratering / krótka przybitka

| Element | Status |
|---|---|
| SDoB = (przybitka + ½·10 średnic) / ∛(masa 10 średnic) — Chiappetta i in. (1983) | [R] potwierdzone |
| Progi: 0,92–1,4 to zakres **projektowy dla fragmentacji** (nie próg „brak wyrzutu”); > 1,3 – brak/minimalny kratering (raport EPA WA); 0,4–1,2 dopuszczalne, < 0,4 – silny flyrock i podmuch | [P]/[R] — **mój próg 1,4 = „brak wyrzutu” trzeba poprawić na ok. 1,3; „pełny kratering” bliżej 0,4 niż 0,6** |
| McKenzie (2009): zasięg max = FOS·11·SDoB^(−2,167)·(D/Fs)^0,667 (D w mm); prędkość V0 = Kv·(…); Kv = 10 (kratering), 0,65 (strzał ławowy), 0,11 (przybitka 40 średnic) | [R] wg ISEE Blasters' Handbook; wykładnik −2,167 potwierdzony, wzór na V0 do potwierdzenia w oryginale; krytyka: kalibrowany na danych Lundborga (SAIMM 2022) |
| NIOSH (kamieniołomy wapienia): przybitka ≥ 26 średnic zapobiega przedwczesnemu wyrzutowi przybitki; 16 średnic – skuteczna, ale wczesne ujście gazów | [P] |
| V_CRATER = 22 m/s, 45 % na boki, rozmiar stożka, przedłużenie do 1,5× | [Z] — rekomendacja: zastąpić prędkością z R&M (cratering: √m / przybitka) albo z McKenzie (Kv·SDoB) |

## 4. Opóźnienia (Kuz-Ram rozszerzony, Cunningham 2005)

- T_max = 15,6·B / c_p [ms] — [R] potwierdzone; 15,6 = 3 ms/m × 5,2 km/s (granit referencyjny).
- Czynnik czasu A_T mnożący X50 — [R] istnieje w Cunningham (2005), EFEE Brighton, s. 201–210; **dokładnego wzoru nie udało się potwierdzić** — moja krzywa (2,1 → 0,9 przy T_max → wzrost 0,1 na jednostkę) jest przybliżeniem.
- Współczynniki C(A), C(n) wymagają kalibracji lokalnej (studium kamieniołomu bazaltu) — [P].
- c_p = √(E/ρ) — [R] prędkość w pręcie; dla fali P w masywie: c_p = √(E(1−ν) / (ρ(1+ν)(1−2ν))) — przy ν = 0,25 o ok. 10 % więcej. Rekomendacja: dodać ν (domyślnie 0,25).

## 5. Rozrzut zapalników (2 %)

- Zapalniki nieelektryczne (shock tube) 25–500 ms: dokładność ±1,5–2,5 % — [P]; pyrotechniczne 700 ms: σ = 37,9 ms (≈ 5,4 %); elektroniczne: σ = 0,34 ms (≈ 0,05 %), ±0,1 ms — [P].
- Wniosek: 2 % jako σ dla nonel jest rozsądne (górna część zakresu); dodać wybór typu: nonel ≈ 1–2 %, pyrotechniczny ≈ 5 %, elektroniczny ≈ 0,05 %.

## 6. Kuz-Ram i Lilly

- X50 = A·(V0/Q)^0,8·Q^(1/6)·(115/RWS)^(19/30) — [R] (Kuznetsov/Cunningham), znany wzór.
- n wg Cunninghama (1987) — [R] forma potwierdzona pośrednio; stałe 2,2 / 14 / 0,1 do potwierdzenia w oryginale.
- Lilly: A = 0,06·(RMD + JPS + JPO + RDI + HF), RDI = 25·ρ − 50 — [R] potwierdzone. HF = E/3 (E < 50 GPa) lub UCS/5 — UCS/5 potwierdzone, wariant E/3 nie znaleziony w wynikach (występuje w Cunningham 2005, do potwierdzenia).

## 7. Parametry fizyki (Rapier)

| Parametr | Obecnie | Literatura | Status |
|---|---|---|---|
| Restytucja (odbicie) | 0,05 | wapień: normalna 0,315 ± 0,064, styczna 0,71 ± 0,12 (stoki z urobkiem, studium kamieniołomu); lab.: Rn 0,3–0,7, Rt 0,6–0,95 | [P] — **moja wartość za niska** |
| Tarcie | 0,3 | tarcie dynamiczne wapień 0,576 ± 0,13; opór toczenia 0,40 | [P] — **moja wartość za niska** |
| Gęstość | 2600 kg/m³ | typowo 2600–2700 (powinna brać `rockRho` z formularza) | [P] |
| Tłumienie, zmniejszenie brył 90 % | 0,1 / 3 / 0,9 | brak — parametry numeryczne | [Z] |

Uwaga: zmiana tarcia i restytucji na wartości z literatury zmieni wygląd usypu (więcej odbić, krótsze zsuwanie) — wymaga ponownego dostrojenia prędkości.

## 8. Bez weryfikowalnego źródła (zostają parametrami kalibracyjnymi)

Waga kierunku otwarcia (0,8), próg ruchu sąsiada (3 cm), promień sąsiedztwa (1,8 bloczka), waga „powietrza” (3 m),
profil wpływu ściany 0,45 + 0,55·e^(−d/3B), rozrzut losowy ±20 % / ±10°. Kierunek ruchu prostopadły do izochron
(w stronę wcześniej odpalonych otworów) jest **jakościowo** opisany w literaturze, ale bez wzoru liczbowego.

## Źródła

- Richards A.B., Moore A.J. (2004) Flyrock control — by chance or design. ISEE 30th Conf., 335–348 (wzory reprodukowane w raportach Terrock).
- Zhang Z.X., Chi L.Y., Yi C. (2021) An empirical approach for predicting burden velocities in rock blasting. JRMGE 13(4):767–773. https://doi.org/10.1016/j.jrmge.2021.04.004
- McKenzie C. (2009) Flyrock range and fragment size prediction. ISEE; ISEE Blasters' Handbook (2011).
- Chiappetta R.F. i in. (1983) Use of high-speed motion picture photography in blast evaluation and design.
- Cunningham C.V.B. (2005) The Kuz-Ram fragmentation model – 20 years on. EFEE Brighton, 201–210.
- Lilly P.A. (1986) An empirical method of assessing rock mass blastability.
- Flyrock in surface mining (SAIMM 2022/2023) – krytyka modeli McKenzie/Lundborg.
- Studium kamieniołomu wapienia (MDPI Applied Sciences 2025, 15(17):9734) – restytucja i tarcie.
- OSMRE (2009) – dokładność zapalników; NIOSH/CDC – przybitka i wyrzut.
