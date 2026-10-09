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
4. **Długość otworu**: do rzędnej dna (rzędna docelowa − przewiert, dno zawsze na tej samej rzędnej) albo stała długość.
   **Szablon ładunku** dla typu (przybitka stała od wlotu, potem lista od góry do dołu):
   - ładunek: „reszta” (wypełnia wolne miejsce, masa MW się dolicza), zadana długość albo zadana masa (kg);
   - przesypka (materiał obojętny) albo **air deck** (pusty odcinek, opcjonalnie z wkładką otworową na górze odcinka,
     wkładki są zliczane): zadana długość i położenie (po kolei, na głębokości od wlotu albo na rzędnej), ewentualnie „reszta”,
     która dopasowuje się do zadanej masy MW. Ładunek tuż nad przesypką o ustalonym położeniu liczy się sam.
   **Emulsja spęczniająca:** produkt sypki ma gęstość początkową (przy załadunku) i docelową (po spęcznieniu). Geometria szablonu to stan
   końcowy. Przy „odczekaj na spęcznienie" masa liczy się z gęstości docelowej, a w chwili załadunku kolumna jest krótsza
   (program pokazuje wysokość załadunku i podniesienie). Bez czekania (przybitka/korek od razu) masa wynika z gęstości początkowej.
   Pod korkiem air deck ma w chwili zakładania korka długość końcową plus podniesienie kolumny pod nim.
   Szablon stosuje się do wszystkich otworów danego typu. Produkty z bazy MW (sypkie i nabojowane).
5. **Profil**: tryb „Profil” → klik w otwór (przekrój przez ten otwór, w kierunku jego nachylenia) albo dwa punkty na terenie.
   Pokazuje teren, rzędne docelowe, otwory z ładunkiem i zabiór (pole przekroju nad rzędną docelową).
6. **Sieć i opóźnienia (nieelektryczna).** Tryb „Sieć”: klikaj kolejno otwory, aby je łączyć łącznikiem powierzchniowym (ms),
   tryb „Punkt inicjacji” oznacza start. Czas odpalenia otworu = suma łączników od inicjacji + opóźnienie w otworze (parametr typu).
   Jest też sieć automatyczna („rząd po rzędzie” albo „V” od środka). Program liczy czas każdego otworu, liczbę różnych opóźnień
   i maksymalny ładunek w oknie (domyślnie 8 ms), rysuje wykres kg na opóźnienie i koloruje otwory wg czasu z odtwarzaniem.
   Katalog łączników i opóźnień jest przykładowy, wpisz własny.
7. **Fragmentacja (Kuz-Ram)** z współczynnikiem skały A wg Lilly (albo wpisanym) i rozkładem Rosina-Rammlera: X50, X80, wskaźnik
   jednorodności, procent nadgabarytu. Wartości mają charakter szacunkowy i wymagają kalibracji.
8. **Symulacja odstrzału (ilustracja):** bryła nad rzędną docelową w obrysie jako bloczki. Tryby: kolory wg czasu odpalenia,
   rozpad bloczków na odłamki wg Kuz-Ram (bloczki większe niż rozmiar z rozkładu zostają jako nadgabaryt) i fizyka ruchu
   (silnik Rapier, a gdy WebAssembly jest niedostępny, uproszczona balistyka). Pasek czasu na widoku 3D. Nie służy do wyznaczania
   stref bezpieczeństwa, zasięgu odłamków ani drgań.
9. **Zapis projektu** (JSON) i **eksport planu wierceń** w formacie IREDES XML (kolejność osi N, E, H, układ PL-2000).
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

## Silnik fizyki
`vendor/rapier/rapier.mjs` (Rapier, Apache-2.0, ok. 4 MB z WebAssembly) ładuje się dopiero przy trybie „fizyka ruchu”. Kolejność prób:
plik obok strony, potem CDN (jsDelivr), a gdy się nie uda, włącza się uproszczona balistyka bez zderzeń bloczków.

## Uwagi
- Zakładamy układ Z w górę, metry (domyślny eksport Pix4D). Duże współrzędne bezwzględne (np. UTM) trzeba wyeksportować
  z offsetem i wpisać go w „Przesunięcie współrzędnych”, bo OBJ jest wczytywany w float32.
- Wartości „orientacyjne wg średnicy” to reguły kciuka; projekt musi zatwierdzić uprawniona osoba.

## Testy
    node test-blast.mjs && node test-modules.mjs && node test-network.mjs && node test-frag.mjs && node test-physics.mjs
