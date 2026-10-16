# Hallyu Design System — Specification v1.0

> Source of truth: `src/css/tokens.css`. Every value below is taken verbatim
> from that file. Dark is the primary theme; light is a fully supported,
> first-class theme.

---

## 1. Brand foundation

Hallyu's brand idea is **convergence** — many fandoms, one place. The name
means "the Korean wave," but the product is deliberately global: four worlds
today, more tomorrow. The visual identity had to feel *cinematic and premium*
without borrowing from the obvious references (Netflix red, Spotify green,
Twitch purple, the neon-glass aesthetic of generic "AI apps"), and without
falling into childish fandom clichés (sticker packs, confetti, mascots).

The result is a restrained, editorial, slightly nocturnal system:

- **The mark** is a *convergence bloom*: four arcs meeting at a bright signal
  point at the center. The four arcs read as four worlds converging; the
  center is the fandom community that forms where they meet.
- **The wordmark** sets "Hallyu" in a tight, confident sans with the mark as
  the counter of the first letter's negative space.
- **The voice** is warm but composed — a knowledgeable friend, not a hype
  machine.

The brand's single most important decision is its **signal color**: Hallyu Iris.

---

## 2. Color system

### 2.1 The ink ramp (dark surfaces & text)

The canvas is **not pure black**. It carries a faint blue-violet tint
(`#0A0A12`) so that warm artwork and skin tones read richly against it, and so
the brand violet feels native rather than pasted on.

| Token | HEX | Role |
|---|---|---|
| `--ink-1000` | `#05050A` | inset / deepest wells |
| `--ink-950` | `#0A0A12` | **canvas** (app background) |
| `--ink-900` | `#101019` | elevated canvas |
| `--ink-850` | `#14141F` | **surface-1** (cards) |
| `--ink-800` | `#1B1B28` | **surface-2** (sheets, chips) |
| `--ink-750` | `#232333` | surface-3 / borders-subtle |
| `--ink-700` | `#2A2A3D` | border-default |
| `--ink-600` | `#38384F` | border-strong / focus |
| `--ink-500` | `#4A4A5E` | text-disabled |
| `--ink-400` | `#74748C` | text-tertiary |
| `--ink-300` | `#A9A9BE` | text-secondary |
| `--ink-200` | `#C9C9D8` | — |
| `--ink-100` | `#E4E4EE` | — |
| `--ink-50`  | `#F5F5FA` | **text-primary** |
| `--white`   | `#FFFFFF` | on-accent / on-media |

### 2.2 Brand — "Hallyu Iris"

A confident blue-violet. Deep enough to feel premium, bright enough to be a
clear call-to-action signal, and — critically — *not* the color of any major
competitor.

| Token | HEX | Role |
|---|---|---|
| `--iris-50` | `#F0EEFF` | tint backgrounds |
| `--iris-100` | `#E0DBFF` | — |
| `--iris-200` | `#C4BAFF` | — |
| `--iris-300` | `#A594FF` | **brand-text** (links, <18px) |
| `--iris-400` | `#8B75FF` | anime world / hover |
| `--iris-500` | `#7B61FF` | **THE SIGNAL** (brand, CTAs) |
| `--iris-600` | `#6A4FF0` | light-theme brand |
| `--iris-700` | `#5A3FD6` | brand-pressed |
| `--iris-800` | `#472FB0` | — |
| `--iris-900` | `#37238A` | — |

### 2.3 Supporting accents

- **Ember (amber)** — ratings, verdicts, awards, warmth.
  `--amber-300 #FFD08A`, `--amber-400 #FFB74D`, `--amber-500 #FFA726`,
  `--amber-600 #F08C00`.
- **Pulse (coral)** — live, "now", social energy.
  `--coral-400 #FF8AA0`, `--coral-500 #FF5C7A`, `--coral-600 #EC3E60`.
- **Semantic** — `--green-400 #3DD68C`, `--yellow-400 #FFC24B`,
  `--red-400 #FF6B6B`, `--blue-400 #4DA3FF`.

### 2.4 World accents (metadata signals)

Each world owns exactly one hue. It appears **only** as a dot, a thin tag, or a
small icon tint — never as a page fill. This keeps the app recognizably Hallyu
while still letting a K-Drama fan feel "their" color.

| World | Token | HEX |
|---|---|---|
| K-Drama | `--world-kdrama` | `#FF6B8A` (coral rose) |
| C-Drama | `--world-cdrama` | `#3DD6C4` (jade) |
| Anime | `--world-anime` | `#8B75FF` (violet) |
| Hollywood | `--world-hollywood` | `#FFB74D` (amber) |

Each also has a `-soft` variant at 16% alpha for tinted chips.

> **Adding a world later** = add one token pair + one mock row. No layout
> change. This is the extensibility guarantee.

### 2.5 Semantic color roles (dark theme)

| Role | Value | Use |
|---|---|---|
| `--bg-canvas` | `#0A0A12` | app background |
| `--surface-1` | `#14141F` | cards |
| `--surface-2` | `#1B1B28` | sheets, menus, chips |
| `--surface-3` | `#232333` | pressed / overlay-on-surface |
| `--border-subtle` | `#232333` | hairlines |
| `--border-default` | `#2A2A3D` | card outlines |
| `--border-strong` | `#38384F` | focused inputs |
| `--text-primary` | `#F5F5FA` | body |
| `--text-secondary` | `#A9A9BE` | supporting |
| `--text-tertiary` | `#74748C` | meta |
| `--brand` | `#7B61FF` | primary action |
| `--live` | `#FF5C7A` | live badge |
| `--success` | `#3DD68C` | confirmations |
| `--warning` | `#FFC24B` | caution |
| `--danger` | `#FF6B6B` | destructive |
| `--overlay` | `rgba(5,5,10,0.66)` | behind sheets/dialogs |

### 2.6 Reaction set

Entertainment-native reactions (not generic emoji-only), each with its own hue:

| Reaction | HEX |
|---|---|
| Love | `#FF5C7A` |
| Cry | `#4DA3FF` |
| Hype | `#FFB74D` |
| Shock | `#A594FF` |
| Laugh | `#3DD68C` |
| Rage | `#FF6B6B` |

### 2.7 Light theme

Not a corporate dashboard. Warm-neutral paper, strong ink type, brand kept deep
enough for AA contrast.

| Role | Value |
|---|---|
| `--bg-canvas` | `#F6F6FA` |
| `--surface-1` | `#FFFFFF` |
| `--surface-2` | `#F2F2F8` |
| `--border-subtle` | `#E7E7F0` |
| `--text-primary` | `#14141F` |
| `--text-secondary` | `#55556B` |
| `--brand` | `#6A4FF0` |
| `--brand-text` | `#5A3FD6` |
| `--success` | `#12A567` |
| `--danger` | `#E23B3B` |

Switching theme is a single attribute: `<html data-theme="light">`.

---

## 3. Typography

**One family across the whole product:** a highly-readable
geometric-humanist sans. Display sizes tighten their tracking; body stays
neutral. The stack leads with Inter and falls back through Pretendard Variable
and Noto Sans KR so Korean and Japanese render natively.

```
--font-sans: "Inter", "Pretendard Variable", "Noto Sans KR",
             "Segoe UI", Roboto, system-ui, -apple-system, sans-serif;
--font-mono: "JetBrains Mono", "SFMono-Regular", ui-monospace, monospace;
```

Weights: `400 / 500 / 600 / 700 / 800`.

| Style class | Size | Line-height | Tracking | Weight |
|---|---|---|---|---|
| `.t-display-xl` | 44 | 48 | −0.02em | 800 |
| `.t-display` | 36 | 42 | −0.018em | 800 |
| `.t-display-sm` | 30 | 36 | −0.015em | 800 |
| `.t-h1` | 26 | 32 | −0.012em | 700 |
| `.t-h2` | 22 | 28 | −0.008em | 700 |
| `.t-h3` | 19 | 25 | −0.004em | 600 |
| `.t-section` | 17 | 23 | 0 | 700 |
| `.t-card-title` | 16 | 21 | 0 | 600 |
| `.t-body-l` | 17 | 26 | 0 | 400 |
| `.t-body` | 15 | 22 | 0 | 400 |
| `.t-body-s` | 13.5 | 20 | 0 | 400 |
| `.t-caption` | 12 | 16 | 0.002em | 500 |
| `.t-label` | 13 | 18 | 0.002em | 600 |
| `.t-nav` | 11 | 14 | 0.01em | 500 |
| `.t-button` | 15 | 20 | 0 | 600 |
| `.t-meta` | 12 | 16 | 0.01em | 500 |
| `.t-stat` | 20 | 24 | −0.01em | 700 |
| `.t-overline` | 11 | 14 | 0.08em | 700 |

**Hierarchy rules.** A screen has exactly one display-level element (the title
or hero). Section headers are `.t-section`; card titles `.t-card-title`; body
copy never exceeds `.t-body-l`. Meta and timestamps use `.t-meta` /
`.t-caption` in `--text-tertiary`.

---

## 4. Spacing (4pt base)

`--space-0: 0` · `--space-1: 4` · `--space-2: 8` · `--space-3: 12` ·
`--space-4: 16` · `--space-5: 20` · `--space-6: 24` · `--space-7: 28` ·
`--space-8: 32` · `--space-10: 40` · `--space-12: 48` · `--space-16: 64` ·
`--space-20: 80`.

Named rhythm tokens:

- `--screen-margin: 16px` — horizontal page padding (compact default)
- `--gutter: 12px` — between grid cells
- `--card-padding: 16px`
- `--section-gap: 28px` — vertical space between sections
- `--nav-gap: 8px`

---

## 5. Grid & layout

- **Base frame:** 390 × 844 (iPhone reference), 412 × 915 (Android),
  360 × 780 (small). All three are rendered from the same CSS.
- **Margins:** 16px compact, 20px on ≥ 414pt.
- **Shelves:** horizontal scroll, peek of the next card ≈ 24px.
- **Poster grid:** 3-up on phones, 4-up ≥ 414pt, 6-up on tablets.
- **Safe areas:** top status bar 44px, bottom home indicator 22px; the tab bar
  sits above the indicator.

---

## 6. Shape & radius

`--radius-xs: 6` · `--radius-sm: 10` · `--radius-md: 14` · `--radius-lg: 18` ·
`--radius-xl: 24` · `--radius-2xl: 30` · `--radius-full: 9999px`.

Cards use `lg`; posters use `md`; chips and avatars use `full`; sheets use
`2xl` top corners; inputs use `md`.

---

## 7. Elevation & surfaces

Depth is built from **surface + border**, not glow.

| Token | Value |
|---|---|
| `--elev-1` | `0 1px 2px rgba(0,0,0,.35)` |
| `--elev-2` | `0 4px 12px rgba(0,0,0,.40)` |
| `--elev-3` | `0 10px 28px rgba(0,0,0,.50)` |
| `--elev-floating` | `0 8px 24px rgba(0,0,0,.45)` |
| `--elev-brand-glow` | `0 8px 24px rgba(123,97,255,.35)` (reserved for the primary CTA) |

Cards sit on `surface-1`; sheets on `surface-2`; dialogs on `surface-2` with
`elev-3`. Only the primary CTA and the live badge may use a colored glow.

---

## 8. Iconography

A single **stroke-based** set: 24×24 viewBox, `1.8` stroke width, round caps and
joins, `currentColor`. Over 90 icons ship in `src/icons.py`. Icons inherit text
color and never carry their own fill except for explicit "fill" variants
(heart-fill, bookmark-fill, star-fill). World icons are the four marks
(`drama`, `building`, `anime`, `popcorn`).

Rules: icons are 20px inline, 24px in nav/icon buttons, 18px in chips. Never
scale an icon below 16px or above 28px in product UI.

---

## 9. Imagery rules

- **Posters** are 2:3 portrait; **backdrops** 16:9; **hero** 3:4 or 16:9.
- Every image that carries text over it gets a scrim:
  `--scrim-bottom rgba(5,5,10,0.86)` fading to transparent at the top.
- Text on media is always `--text-on-media` (white) with the scrim guaranteeing
  contrast — never rely on the image itself for legibility.
- Images are `object-fit: cover`; corners follow the container radius.
- No drop shadows on imagery; separation comes from the scrim and border.

---

## 10. Avatar system

Sizes: `xs 24` · `sm 32` · `md 40` · `lg 56` · `xl 96`.

- Default is a circle; **story/creator rings** use a 2px Iris gradient ring.
- **Live** avatars get a Pulse (`#FF5C7A`) ring plus a small live dot.
- **Stacks** overlap by 30% with a 2px canvas-colored gap; show `+N` overflow.
- **Status** dots (online/away) are 10px, bottom-right, with a 2px canvas ring.
- Fallback when no image: initials on a `--brand-soft` disc.

---

## 11. Motion system

Durations: `--dur-instant 90ms`, `--dur-fast 150ms`, `--dur-base 220ms`,
`--dur-medium 280ms`, `--dur-slow 360ms`, `--dur-slower 480ms`,
`--dur-skeleton 1200ms`.

Easings:

- `--ease-standard: cubic-bezier(0.2, 0, 0, 1)` — default UI motion
- `--ease-decel: cubic-bezier(0.05, 0.7, 0.1, 1)` — entrances
- `--ease-accel: cubic-bezier(0.3, 0, 0.8, 0.15)` — exits
- `--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)` — playful confirms

See `motion.md` for the full choreography and reduce-motion behavior.

---

## 12. Interaction states

Every interactive component defines: **default, hover, pressed, focus-visible,
selected, disabled, loading, success, error.** Pressed states scale to `0.97`
and dim ~8%; focus-visible draws a 2px `--border-strong` (Iris) ring at 2px
offset; disabled drops to `--text-disabled` and 45% opacity with no shadow;
loading swaps the label for a spinner; success/error use `--success` /
`--danger` fills. Details in `motion.md`.

---

## 13. Accessibility

- Target **WCAG 2.1 AA** (4.5:1 body, 3:1 large text and UI).
- Text tokens are chosen so `--text-primary` on `--surface-1` clears AA, and
  `--brand-text` (`#A594FF`) is used for small brand text on dark so links
  clear AA where `--brand` alone would not.
- Minimum touch target 48×48 (`--size-touch`).
- Focus is always visible and never removed without a replacement.
- Color is never the only signal: world tags pair hue with a label; states pair
  color with an icon and text.
- Motion respects `prefers-reduced-motion`.

---

## 14. Responsive behavior

| Breakpoint | Width | Behavior |
|---|---|---|
| Small | 360 | tighter margins, 3-up grids |
| Compact | 390 | reference layout |
| Regular | 414 | 4-up grids, 20px margins |
| Tablet | ≥ 768 | split detail, wider shelves |

Layouts are fluid: shelves grow, grids add columns, and the content hub
switches from stacked to two-column (poster rail + detail) on tablets. The tab
bar stays five items at every width; labels hide below 360 only if forced.

---

## 15. Component library

The full library is specified in `components.css` and demonstrated — with every
state — in `pages/components.html` (rendered to
`renders/pages/components.png`). Families:

**Actions** — buttons (primary / secondary / outline / ghost / soft / danger /
live / warm; sizes lg / md / sm / block), icon buttons, follow buttons,
reaction buttons.
**Inputs** — text fields, search bar, segmented control, tabs, chips, switches,
checkboxes, radios, rating.
**Containment** — poster card, wide card, section/shelf, list row, stat, kv,
poll, comment, composer.
**Overlays** — bottom sheet, dialog, toast, notification row, scrim.
**Feedback** — skeleton, empty / error / success / offline states, progress,
loading spinner.
**Media** — video controls, shorts rail, art badge, art progress, art scrim.
**Navigation** — top bar, tab bar / nav item, create button, back button.

---

## 16. Content hierarchy

1. **Title / hero** — the single display element.
2. **Section header** — `.t-section` + "See all".
3. **Card title** — `.t-card-title`.
4. **Body** — `.t-body` / `.t-body-s`.
5. **Meta** — world dot, year, type, rating, episode count in `.t-meta`.

---

## 17. Navigation patterns

Five-item tab bar: **Home · Explore · Create (center) · Activity · You**. The
center Create button is a raised 48×48 Iris disc that opens a creation sheet
rather than switching tabs. Detail screens push; sheets slide up; dialogs fade
and scale. Full map in `navigation.md`.

---

## 18. Loading & skeleton

Skeletons mirror the exact geometry of the content they replace (poster cards,
post rows, hero) using `--skeleton-base` with a `--skeleton-highlight` shimmer
sweeping over `--dur-skeleton`. No spinners for full-screen loads; spinners are
reserved for in-button and inline actions.

---

## 19. Empty / error / success states

Each state pairs an illustration or icon, a short headline, one sentence of
guidance, and a single primary action. Empty states are *inviting* ("Start the
conversation"), errors are *calm and recoverable* ("Something went wrong" +
Retry), success states are *brief and celebratory* without confetti spam.

---

## 20. Modal & bottom sheet

Sheets: `2xl` top radius, `surface-2`, `elev-3`, grabber handle, slide-up on
`--ease-decel`. Dialogs: centered, `xl` radius, max 320px wide, fade+scale on
`--ease-spring`. Both dim the background with `--overlay` and trap focus.

---

## 21. Toast & notification

Toasts: floating pill, `surface-2`, `elev-floating`, icon + message + optional
action, auto-dismiss ~4s, slide+fade in. In-app notification rows are list rows
with an icon disc, title, body, timestamp, and an unread dot.

---

## 22. Media & video

The video/shorts surface is full-bleed with a bottom scrim, a right-hand action
rail (like / comment / save / share), a scrubber, and centered play/pause on
tap. Controls auto-hide after 3s and reappear on tap. Poster-to-player
transitions cross-fade over `--dur-medium`.

---

## 23. Community & fandom visual language

Communities get a cover image, a compact header (icon, name, member count, Join
button), segmented tabs (Posts / Discussions / Members / About), and a
"create post" composer. Discussion threads use the spoiler veil: a blurred card
with an eye-off icon and "Spoiler · Episode N — tap to reveal." This is a
signature Hallyu primitive.

---

## 24. Dark / light parity

Both themes share the same component geometry; only tokens change. Light theme
raises `--brand` to `#6A4FF0` for contrast, warms the canvas to `#F6F6FA`, and
softens elevation shadows. Every screen is designed to work in both.

Two light-theme reference renders ship as proof of parity:
`03-home-foryou-light` and `06-content-anime-light` (see
`renders/screens/`). They are produced by the *same* functions as their dark
counterparts, with only the `theme` argument changed — the strongest possible
demonstration that the system is token-driven rather than hand-painted.

---

## 25. Extensibility

Adding a world, a content type, or a new section is a data change, not a
redesign: worlds are token pairs + rows; content types are fields on the title
record; sections are composable from the component library. The system is built
to absorb growth without visual drift.
