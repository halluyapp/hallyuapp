# Hallyu — Navigation & Information Architecture

## 1. The shell

Hallyu uses a **five-item bottom tab bar** as its persistent shell:

```
┌───────────────────────────────────────────────┐
│                                               │
│                  (content)                    │
│                                               │
├───────────────────────────────────────────────┤
│   Home    Explore   (＋)   Activity    You     │
└───────────────────────────────────────────────┘
```

| Tab | Icon | Purpose |
|---|---|---|
| **Home** | `home` | Personalised shelves, your fandoms, following. |
| **Explore** | `compass` | Discover, worlds, genres, short-form, search entry. |
| **Create** | `plus` | **Action, not a destination.** Opens the create sheet. |
| **Activity** | `bell` | Notifications + messages. |
| **You** | `user` | Your profile, watchlist, saved, settings. |

The **center Create button** is a raised 48 × 48 Iris disc. Tapping it does
*not* change the selected tab — it presents the create sheet over the current
screen. This keeps creation one thumb-reach away from anywhere in the app.

### Tab bar states

- **Default:** icon `--text-tertiary`, label `.t-nav`.
- **Selected:** icon + label `--brand`; a subtle 4px dot or the icon fill.
- **Pressed:** scale 0.94, `--dur-instant`.
- **Create:** always Iris; pressed deepens to `--brand-pressed`.

---

## 2. Route map

```
Splash / First-launch
└─ Onboarding (welcome → auth → fandoms → genres → titles → people → done)
   └─ Tabs
      ├─ Home ──────────────► Content Hub (push)
      │                        └─ Episodes / Community / Cast (in-place tabs)
      ├─ Explore ───────────► Discover (world / genre)
      │        └─ Search ───► Results (content / people / communities)
      │        └─ Shorts ───► Comments (sheet)
      ├─ Create ────────────► Create sheet ─► Post / Poll / Attach / Uploading
      │                                      └─ Success
      ├─ Activity ──────────► Notifications
      │        └─ Messages ─► Thread
      └─ You ───────────────► Profile (own / creator) ─► Edit
               └─ Watchlist / Saved / Settings ─► Appearance
```

---

## 3. Navigation patterns by layer

**Tabs (root).** No back affordance. Switching tabs preserves each tab's own
scroll position and navigation stack.

**Push (detail).** Content Hub, Post Detail, Community Detail, Thread, Profile.
Slide in from the right over `--dur-medium` with `--ease-decel`; back slides out.

**Sheet (bottom).** Create menu, attach media, comments, post overflow, share.
Slide up from the bottom, `2xl` top radius, scrim behind, dismiss on scrim tap
or drag-down.

**Dialog (centered).** Destructive confirmations and blocking decisions. Fade +
scale on `--ease-spring`.

**Overlay (in-place).** Segmented tabs, world chips, watchlist toggle — these
change content without navigating, preserving context.

---

## 4. Deep links

| Link | Destination |
|---|---|
| `hallyu://title/:id` | Content Hub |
| `hallyu://title/:id/episode/:n` | Content Hub → Episodes, scrolled to episode |
| `hallyu://post/:id` | Post Detail |
| `hallyu://community/:id` | Community Detail |
| `hallyu://user/:handle` | Profile |
| `hallyu://short/:id` | Shorts, opened at that clip |

Notifications and shared links resolve through this map.

---

## 5. Back behavior

- Android hardware back pops the current stack; at a tab root it returns to the
  previously selected tab before exiting.
- Sheets and dialogs consume back to dismiss.
- The Content Hub remembers the active tab (Overview / Episodes / Community /
  Cast) when you leave and return within a session.

---

## 6. Accessibility of navigation

- Every tab has a label plus an icon; the selected tab is announced.
- The create disc has an accessible label ("Create") and a 48px target.
- Focus order follows visual order; sheets trap focus and restore it on close.
- The tab bar sits above the home indicator and never overlaps content.

---

## 7. Why this structure

The five-tab shell maps directly onto the core loop. **Discover** lives in
Explore; **Experience** in the Content Hub; **React / Discuss** in the feed and
community; **Follow** across profiles and communities; **Create** in the center
disc; **Rediscover** in Home's personalised shelves. Creation being an action
rather than a tab keeps the loop reachable without adding a sixth destination,
and keeps the bar legible at 360px.
