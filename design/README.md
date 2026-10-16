# Hallyu — Design Workspace

> **Where Fandoms Meet.**
> This folder is the complete, self-contained **design package** for the next
> generation of Hallyu. It is a *design phase artifact* — a coded visual source
> of truth — and it deliberately does **not** touch the production app.

---

## What this is

Hallyu is a social entertainment platform built around the core loop:

**Discover → Experience → React → Discuss → Follow → Create → Rediscover**

This workspace turns that product vision into a concrete, inspectable design
system and a full set of high-fidelity mobile screens. Everything here is
**coded** (HTML + CSS driven by shared Python component helpers), so the PNG
references you review are generated *from the same source* that would later be
ported to the Expo/React Native app. There are no disconnected mockups: the
component library page and every screen are rendered by the exact same
functions.

The initial entertainment ecosystem covers four worlds — **K-Dramas,
C-Dramas, Anime, and Hollywood (movies + TV)** — and is architected so more
categories can be added later without a redesign. A world is just a token
(`--world-*`) plus a data row; the layout never assumes a fixed set.

---

## Folder map

```
design/
├── README.md                 ← you are here
├── todo.md                   ← build plan / progress ledger
├── docs/                     ← written specifications
│   ├── design-system.md      ← color, type, space, radius, elevation, motion
│   ├── screens.md            ← per-screen spec + states + interactions
│   ├── navigation.md         ← information architecture + navigation map
│   ├── motion.md             ← motion system + interaction states
│   ├── assets.md             ← asset manifest + usage rules
│   └── mock-data.md          ← the shared mock dataset
├── src/
│   ├── css/
│   │   ├── tokens.css        ← SINGLE SOURCE OF TRUTH (design tokens)
│   │   ├── base.css          ← reset, typography, layout primitives
│   │   ├── components.css    ← component library styles
│   │   └── screens.css       ← screen-composition styles
│   ├── icons.py              ← 90+ stroke-based SVG icons
│   ├── mock.py               ← shared mock data (worlds, titles, users…)
│   ├── ui.py                 ← component helpers that emit HTML
│   ├── build.py              ← generates screens/*.html + pages/*.html
│   ├── render.py             ← HTML → PNG (Playwright / Chromium)
│   └── contact_sheet.py      ← composes PNG contact sheets
├── screens/                  ← generated coded screens (62 files)
├── pages/                    ← generated doc pages (icons, design-system,
│                                components, navigation)
├── assets/
│   ├── brand/                ← app icon, wordmark, splash, world marks
│   └── img/                  ← posters, backdrops, avatars, hero
└── renders/
    ├── screens/              ← 62 high-fidelity PNG references (780×1688)
    ├── pages/                ← 4 documentation PNGs
    ├── contact-sheets/       ← one sheet per product area
    └── contact-sheet-all-*.png
```

---

## How to rebuild everything

Everything is reproducible from source. From inside `design/`:

```bash
# 1. Regenerate the coded HTML (screens + doc pages)
python3 src/build.py

# 2. Render the HTML to high-fidelity PNG references
python3 src/render.py            # all
python3 src/render.py screens    # screens only
python3 src/render.py pages      # doc pages only

# 3. Compose contact sheets
python3 src/contact_sheet.py
```

Requirements: Python 3.11, `playwright` (Chromium), `Pillow`. The CSS is plain
CSS custom properties — no build step, no framework.

---

## Design principles

1. **Cinematic, not neon.** Depth comes from a tinted "midnight ink" surface
   ramp and honest borders — not from glow, glass, or gradient soup.
2. **One signal color.** The brand is a single confident blue-violet
   (**Hallyu Iris, `#7B61FF`**). Everything else is a supporting actor.
3. **Worlds are signals, not themes.** Each fandom world gets exactly one hue,
   used only as a dot, tag, or thin accent — never as a page background.
4. **Entertainment-native, not social-generic.** Reactions, spoiler veils,
   watchlists, episode progress and "now airing" are first-class primitives,
   not bolt-ons.
5. **Global by default.** The type stack leads with Inter and falls back
   gracefully through Pretendard and Noto Sans KR; layouts survive long
   Korean/Japanese titles and RTL mirroring.
6. **Accessible.** Every text/background pairing is designed to clear WCAG AA;
   focus, disabled, and error states are specified, not afterthoughts.
7. **Motion with intent.** Short, decisive, physical. Reduce-motion is honored.

---

## Status

**Design review stage.** This package is ready for visual review. Per the brief,
**no production code has been modified** — implementation begins only after the
design is reviewed and explicitly approved.

See `todo.md` for the live build ledger.
