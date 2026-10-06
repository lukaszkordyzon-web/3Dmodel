from pathlib import Path

import streamlit as st

st.set_page_config(page_title="Projekt wierceń strzałowych", layout="wide")

# Aplikacja 3D to gotowa strona (JS) zbudowana do embed/index.html:
#   node tools/build-artifact.mjs embed/index.html --standalone --inline-sample
PAGE = Path(__file__).parent / "embed" / "index.html"

# Mniej pustego miejsca wokół osadzonej aplikacji
# Ramka wypełnia całą wysokość okna (bez czarnego pasa pod aplikacją)
st.markdown(
    """<style>
    header, [data-testid="stHeader"], [data-testid="stToolbar"], [data-testid="stDecoration"]{display:none !important}
    .stApp, [data-testid="stAppViewContainer"], [data-testid="stMain"]{background:#14171c !important}
    [data-testid="stMainBlockContainer"], .block-container{padding:0 !important; max-width:100% !important}
    [data-testid="stVerticalBlock"]{gap:0 !important}
    [data-testid="stElementContainer"]:has(iframe){
        flex: 0 0 auto !important; height: 100vh !important; height: 100dvh !important; min-height: 420px;
    }
    [data-testid="stElementContainer"] iframe{ height: 100% !important; }
    </style>""",
    unsafe_allow_html=True,
)

if hasattr(st, "iframe"):  # nowsze wersje Streamlita
    st.iframe(PAGE, height=900)
else:  # starsze wersje
    import streamlit.components.v1 as components

    components.html(PAGE.read_text(encoding="utf-8"), height=900, scrolling=False)
