# Co — Framer-inspirerad landningssida

En modern, animerad landningssida byggd med ren HTML, CSS och JavaScript — inget byggsteg, inga beroenden. Inspirerad av estetiken hos verktyg som [Framer](https://framer.com): mörkt tema, levande gradienter, mjuka scroll-animationer och glasmorfism.

## Funktioner

- 🎨 **Animerad gradient-bakgrund** med mjukt flytande "blobs"
- 🧭 **Sticky nav** med blur-backdrop som krymper vid scroll
- ✨ **Scroll-reveal** via `IntersectionObserver` med stagger
- 🪟 **3D-tilt** på hero-fönstret som följer muspekaren
- 💡 **Pekare-följande glöd** på funktionskorten
- 🔢 **Animerade räknare** för statistiken
- 📱 **Fullt responsiv** med mobilmeny
- ♿ **Respekterar `prefers-reduced-motion`**

## Köra lokalt

Öppna bara `index.html` i en webbläsare, eller starta en enkel server:

```bash
python3 -m http.server 8000
# besök http://localhost:8000
```

## Struktur

```
index.html   — markup och innehåll
styles.css   — design, layout och animationer
script.js    — interaktivitet (nav, reveal, tilt, räknare)
```
