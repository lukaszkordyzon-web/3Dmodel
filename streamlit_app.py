from pathlib import Path

import streamlit as st

st.set_page_config(page_title="Projekt wierceń strzałowych", layout="wide")

# Aplikacja 3D to gotowa strona (JS) zbudowana do embed/index.html:
#   node tools/build-artifact.mjs embed/index.html --standalone --inline-sample
PAGE = Path(__file__).parent / "embed" / "index.html"

# Mniej pustego miejsca wokół osadzonej aplikacji
st.markdown(
    "<style>.block-container{padding:0.5rem 0.5rem 0}header{display:none}</style>",
    unsafe_allow_html=True,
)

if hasattr(st, "iframe"):  # nowsze wersje Streamlita
    st.iframe(PAGE, height=900)
else:  # starsze wersje
    import streamlit.components.v1 as components

    components.html(PAGE.read_text(encoding="utf-8"), height=900, scrolling=False)
