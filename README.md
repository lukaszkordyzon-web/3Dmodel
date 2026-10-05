# Projekt wierceń strzałowych (3Dmodel)

Webowe narzędzie do projektowania siatki otworów strzałowych na modelu 3D terenu z Pix4D (OBJ).

## Uruchomienie
Aplikacja jest statyczna (bez budowania, Three.js w `vendor/`, działa offline):

    python3 -m http.server 8000     # potem http://localhost:8000

Do próby: `samples/lawa-testowa.obj` (syntetyczna ława, `node gen-sample.mjs`).

## Streamlit
Repozytorium jest gotowe do wdrożenia w Streamlit Community Cloud (`streamlit_app.py`, `requirements.txt`).
Aplikacja 3D to gotowy plik `embed/index.html` osadzany w Streamlicie. Lokalnie: `pip install -r requirements.txt && streamlit run streamlit_app.py`.
Po zmianach w `app.js`, `index.html` lub `style.css` przebuduj osadzany plik:

    npm i esbuild && node tools/build-artifact.mjs embed/index.html --standalone --inline-sample

## Użycie
1. Wskaż razem `.obj`, `.mtl`, tekstury i `*_offset.xyz` z Pix4D (lub przeciągnij na widok).
2. „Rysuj obrys” → klikaj wierzchołki na modelu → „Zamknij obrys”. Siatka generuje się sama.
3. **Typy otworów** (zwykłe / profilowe): każdy ma średnicę, rzędną docelową wyrobiska (m n.p.m.), przewiert poniżej niej,
   stałą przybitkę i nachylenie. Typ otworu zmienia tryb „Zmień typ otworu” (klik w otwór).
4. **Szablon ładunku** dla typu: lista od góry do dołu (ładunek / przekładka), jeden element „reszta” rozciąga się na
   głębokość otworu. Szablon stosuje się do wszystkich otworów danego typu. Produkty z bazy MW (sypkie i nabojowane).
5. **Profil**: tryb „Profil” → klik w otwór (przekrój przez ten otwór, w kierunku jego nachylenia) albo dwa punkty na terenie.
   Pokazuje teren, rzędne docelowe, otwory z ładunkiem i zabiór (pole przekroju nad rzędną docelową).
6. **Zapis projektu** (JSON) i **eksport planu wierceń** w formacie IREDES XML (kolejność osi N, E, H, układ PL-2000).
   CSV z opisem ładunku.

W trybie „Sprawdź punkt” można odczytać X, Y, Z z modelu i porównać z punktem kontrolnym.

## Format planu wierceń (IREDES)
`iredes.js` odtwarza strukturę planu generowanego przez Strayos: nagłówki, `DrillPosPlan`, `Hole` (`StartPoint`, `EndPoint`,
`TypeOfHole`, `DrillBitDia`). Pole `WorkOrder` to środek ciężkości wlotów w długości i szerokości geograficznej
(przeliczenie PL-2000 w `geo.js`, zweryfikowane na planie ze Strayos). Algorytmu `ChkSum` nie znamy: liczymy CRC32, więc
sprawdź, czy odbiorca akceptuje plik.

## Baza danych (szkic)
`db/schema.sql` to szkic schematu PostgreSQL. Kluczem jest ID planu z pliku IREDES (`IR:PlanId`) i numer otworu (`IR:HoleId`):
do nich przypisane są wiercenie, MWD, ładowanie, sieć strzałowa i wyniki (drgania, fragmentacja). W aplikacji `PlanId` jest
stały dla projektu (zapisuje się w pliku projektu), a `HoleId` jest nadawany raz i nie jest przenumerowywany po usunięciu
otworu; `HoleName` (np. `2.11`) to osobna, kolejna numeracja.

## Uwagi
- Zakładamy układ Z w górę, metry (domyślny eksport Pix4D). Duże współrzędne bezwzględne (np. UTM) trzeba wyeksportować
  z offsetem i wpisać go w „Przesunięcie współrzędnych”, bo OBJ jest wczytywany w float32.
- Wartości „orientacyjne wg średnicy” to reguły kciuka; projekt musi zatwierdzić uprawniona osoba.

## Testy
    node test-blast.mjs && node test-modules.mjs
