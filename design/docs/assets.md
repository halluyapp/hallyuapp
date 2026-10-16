# Hallyu — Asset Manifest

All assets live under `assets/`. Every screen references only these files; there
are no one-off graphics embedded elsewhere. Brand marks are SVG (resolution
independent); imagery is optimized JPEG.

---

## 1. Brand marks — `assets/brand/`

| File | Purpose | Notes |
|---|---|---|
| `hallyu-mark.svg` | The convergence-bloom mark (four arcs + center signal). | Iris `#7B61FF`; works on dark and light. |
| `hallyu-wordmark.svg` | Lockup: mark + "Hallyu" wordmark. | Horizontal; tight tracking. |
| `app-icon.svg` | iOS / store icon, 1024 master. | Mark on `--bg-canvas` rounded square. |
| `app-icon-adaptive-foreground.svg` | Android adaptive icon — foreground layer. | Mark centered in the 66% safe zone. |
| `app-icon-adaptive-monochrome.svg` | Android themed-icon layer. | Single-color mark. |
| `notification-icon.svg` | Android status-bar icon. | Monochrome, 24dp. |
| `splash-mark.svg` | Splash-screen mark. | Mark only, no background. |
| `world-kdrama.svg` | K-Drama world mark. | Coral rose `#FF6B8A`. |
| `world-cdrama.svg` | C-Drama world mark. | Jade `#3DD6C4`. |
| `world-anime.svg` | Anime world mark. | Violet `#8B75FF`. |
| `world-hollywood.svg` | Hollywood world mark. | Amber `#FFB74D`. |

**Usage rules.** Never recolor the mark outside the Iris ramp. Minimum mark size
24px. Keep clear space equal to the center signal's diameter on all sides. The
wordmark is horizontal-only; do not stack.

---

## 2. Imagery — `assets/img/`

### Posters (2:3 portrait)

| File | World | Approx. size |
|---|---|---|
| `poster-kdrama-romance.jpg` | K-Drama | 64K |
| `poster-kdrama-thriller.jpg` | K-Drama | 52K |
| `poster-cdrama-wuxia.jpg` | C-Drama | 80K |
| `poster-cdrama-romance.jpg` | C-Drama | 48K |
| `poster-anime-hero.jpg` | Anime | 76K |
| `poster-anime-magic.jpg` | Anime | 84K |
| `poster-anime-romance.jpg` | Anime | 56K |
| `poster-hollywood-scifi.jpg` | Hollywood | 52K |
| `poster-hollywood-thriller.jpg` | Hollywood | 68K |
| `poster-hollywood-action.jpg` | Hollywood | 88K |

### Backdrops (16:9 landscape)

| File | World | Approx. size |
|---|---|---|
| `backdrop-kdrama.jpg` | K-Drama | 80K |
| `backdrop-anime.jpg` | Anime | 124K |
| `backdrop-hollywood.jpg` | Hollywood | 72K |

### Hero & avatars

| File | Purpose | Approx. size |
|---|---|---|
| `hero-onboarding.jpg` | First-launch / onboarding hero. | 164K |
| `avatar-01.jpg` … `avatar-04.jpg` | Sample user avatars (1:1). | 8–12K each |

**Usage rules.** Posters are `object-fit: cover` at 2:3; backdrops at 16:9. Any
text placed over imagery sits on a `--scrim-bottom` gradient — never rely on the
image for contrast. No shadows on imagery; separation comes from scrim + border.
All images fade in on load over `--dur-base`.

**Provenance.** Imagery was generated as original, textless cinematic art
specifically for this design package, then resized and JPEG-compressed for the
reference renders. It is placeholder-grade *art direction* (mood, palette,
composition) — production will swap in licensed key art at the same aspect
ratios and focal points.

---

## 3. Icon set — `src/icons.py`

90+ stroke icons, 24×24 viewBox, 1.8 stroke, `currentColor`. Rendered as inline
SVG by `icon(name, size, cls, extra)`. Categories:

- **Navigation:** home, compass, plus, bell, user, users, chevron-*, back.
- **Media:** play, film, tv, clapper, sparkles, flame, trending, clock, star,
  grid, image, video, poll, mic.
- **Social:** heart, comment, share, bookmark, send, reply, mention, hash,
  verified, eye, eye-off.
- **System:** search, sliders, settings, more, close, check, camera, edit,
  trash, flag, lock, shield, globe, refresh, wifi-off, alert, info, moon, sun,
  logout.
- **Worlds:** drama, building, anime, popcorn.

Icons are 20px inline, 24px in nav/icon buttons, 18px in chips. Never below 16px
or above 28px in product UI.

---

## 4. Fonts

The design references Inter (with Pretendard / Noto Sans KR fallbacks). In
production the app bundles the same stack; the CSS declares the full fallback
chain so Korean and Japanese render natively without a separate family.

---

## 5. What production needs to supply

- Licensed key art at the poster (2:3) and backdrop (16:9) ratios.
- Final app-icon exports at 1024 (iOS), 512 (store), and adaptive layers
  (Android) — the SVGs here are the masters.
- Real avatar uploads (user-generated).
- Any localized wordmark variants (currently Latin-only).
