# Hallyu — Motion & Interaction States

Motion in Hallyu is **short, decisive, and physical**. It confirms actions and
orients the user; it never performs. There is no ambient animation on content,
no parallax for its own sake, and no bouncy excess.

---

## 1. Durations

| Token | Value | Used for |
|---|---|---|
| `--dur-instant` | 90ms | press feedback, tiny toggles |
| `--dur-fast` | 150ms | hover, chip select, icon swaps |
| `--dur-base` | 220ms | most transitions |
| `--dur-medium` | 280ms | push navigation, tab cross-fade |
| `--dur-slow` | 360ms | sheet entrance, hero reveals |
| `--dur-slower` | 480ms | first-launch brand reveal |
| `--dur-skeleton` | 1200ms | shimmer loop |

## 2. Easings

| Token | Curve | Used for |
|---|---|---|
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | default UI motion |
| `--ease-decel` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | entrances (sheets, pushes) |
| `--ease-accel` | `cubic-bezier(0.3, 0, 0.8, 0.15)` | exits |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | playful confirms (like, follow, success) |

---

## 3. Interaction states (all components)

| State | Treatment |
|---|---|
| **Default** | Resting surface + border. |
| **Hover** (pointer) | Surface lifts one step; `--dur-fast`. |
| **Pressed** | `transform: scale(0.97)` + 8% dim; `--dur-instant`. |
| **Focus-visible** | 2px `--brand` ring at 2px offset; never removed. |
| **Selected** | Iris fill or ring; label stays `--text-primary`. |
| **Disabled** | 45% opacity, `--text-disabled`, no shadow, no press. |
| **Loading** | Label → spinner; width locked to avoid reflow. |
| **Success** | Fill → `--success`; brief spring; reverts after ~1.2s. |
| **Error** | Fill → `--danger`; a short shake (±4px, 2 cycles). |

---

## 4. Signature choreography

**Like.** Heart scales 1 → 1.25 → 1 on `--ease-spring` over `--dur-base` and
fills to `--react-love`; a single ring pulse expands and fades.

**Save.** Bookmark fills and gives a small vertical nudge (translateY −2px).

**Follow.** Button collapses from "Follow" to "Following" with a width tween on
`--dur-base`; the label cross-fades.

**Watchlist add.** Checkmark draws in (stroke-dashoffset) over `--dur-base`;
the button color settles to `--brand-soft`.

**Spoiler reveal.** The veil blurs out and fades over `--dur-medium`; content
scales from 0.98 → 1.

**Sheet entrance.** Slides from `translateY(100%)` → 0 on `--ease-decel` over
`--dur-slow`; the scrim fades on `--dur-base`.

**Dialog.** Fade + scale 0.94 → 1 on `--ease-spring`.

**Toast.** Slide up 12px + fade in; auto-dismiss after ~4s with an accelerated
fade.

**Tab switch.** Cross-fade content over `--dur-medium`; the selected indicator
slides between items on `--ease-standard`.

**Skeleton.** A `--skeleton-highlight` band sweeps left→right on a
`--dur-skeleton` loop; geometry matches the real content exactly.

**First-launch brand.** The convergence-bloom mark scales 0.96 → 1 and fades in
over `--dur-slower`; the four arcs are drawn in sequence.

---

## 5. Reduce motion

When `prefers-reduced-motion: reduce` is set:

- All durations collapse to `--dur-instant` (90ms) or 0.
- Transforms (scale, translate, spring) are removed; only opacity changes remain.
- The skeleton shimmer becomes a static `--skeleton-base` fill.
- The first-launch reveal becomes a simple fade.
- Auto-advancing content (shorts) does not auto-play.

Motion is never the sole carrier of meaning: every state that animates also has
a static visual difference (color, icon, or label).

---

## 6. Performance rules

- Animate only `transform` and `opacity` where possible.
- Sheets and pushes use GPU-composited transforms; never animate layout.
- Lists virtualise; skeletons render at fixed height to prevent layout shift.
- Images fade in on load over `--dur-base` from a `--surface-2` placeholder.
