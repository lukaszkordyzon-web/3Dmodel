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
1. Wskaż razem `.obj`, `.mtl` i tekstury z eksportu Pix4D (lub przeciągnij na widok).
2. Tryb „Rysuj obrys” → klikaj wierzchołki na modelu → „Zamknij obrys”.
3. Ustaw średnicę, B/S, poziom spągu, podwiert, przybitkę, nachylenie. Siatka przelicza się na bieżąco.
4. Tryby „Dodaj/Usuń otwór” do ręcznych poprawek. „Eksport CSV” zapisuje kolar, spąg otworu, długość i ładunek.

Liczone: długość otworu (z podwiertem i nachyleniem), przybitka, długość i masa ładunku (z gęstości MW i średnicy),
metraż, objętość urabiana (B×S×H), jednostkowe zużycie MW i wiercenie jednostkowe.

## Uwagi
- Zakładamy układ Z w górę, metry (domyślny eksport Pix4D). Duże współrzędne bezwzględne (np. UTM) trzeba wyeksportować
  z offsetem i wpisać go w „Przesunięcie współrzędnych”, bo OBJ jest wczytywany w float32.
- Wartości „orientacyjne wg średnicy” to reguły kciuka; projekt musi zatwierdzić uprawniona osoba.

## Testy
    node test-blast.mjs
