# Hallyu — Screen Specifications

This document specifies all 17 product areas. Every screen listed here exists as
a coded HTML file in `screens/` and a high-fidelity PNG in `renders/screens/`
(780 × 1688, a 390 × 844 device frame at 2×). States are called out explicitly
where they exist as separate renders.

The core loop the whole product serves:

**Discover → Experience → React → Discuss → Follow → Create → Rediscover**

---

## 01 · Brand / App Entry

| Render | Purpose |
|---|---|
| `01-brand-splash` | Native splash — the convergence-bloom mark on `--bg-canvas`, no chrome. |
| `01-brand-loading` | Cold-start loading — mark + a thin indeterminate Iris progress line. |
| `01-brand-first-launch` | First-launch welcome over the hero image: overline, "Where fandoms meet.", the four world tiles, primary "Create account", secondary "Sign in", ghost "Continue as guest". |

**Interaction.** The four world tiles are tappable and select the user's
starting interest before auth (they animate with `--ease-spring` on tap). The
primary CTA routes to onboarding; "Continue as guest" enters Home in a limited
guest mode (`03-home-guest`).

**Motion.** Mark fades and scales from 0.96 → 1 over `--dur-slow`; the loading
line sweeps left→right continuously.

---

## 02 · Onboarding

| Render | Purpose |
|---|---|
| `02-onb-welcome` | Value framing: "Create your Hallyu identity." |
| `02-onb-auth` | Email / social auth with a clear consent line. |
| `02-onb-fandoms` | Pick worlds (K-Drama, C-Drama, Anime, Hollywood) — multi-select tiles. |
| `02-onb-genres` | Refine with genres; chips with selected state. |
| `02-onb-titles` | "Pick a few favorites" — poster grid, multi-select with a check overlay. |
| `02-onb-people` | "Find your people" — suggested creators/fandoms to follow. |
| `02-onb-done` | "You're all set." Confirmation with a single "Enter Hallyu" CTA. |

**Interaction.** A progress-dot rail sits under the top bar; "Skip" is always
available. Selection persists across steps. Each step advances with a
decelerated slide; the final step uses a spring confirm.

**States.** Each selection tile has default / selected (Iris ring + check) /
pressed (scale 0.97). The poster grid supports empty (nothing selected) and
disabled (max reached) states.

---

## 03 · Home

| Render | Purpose |
|---|---|
| `03-home-foryou` | Default: world chips, a hero card, "Trending on Hallyu", "Your Fandoms", "Because you love…". |
| `03-home-following` | Social-forward: "From people you follow" feed. |
| `03-home-loading` | Skeleton hero + skeleton shelves. |
| `03-home-guest` | Guest mode: a soft sign-in prompt replaces the personalised shelves. |
| `03-home-foryou-light` | Light-theme parity render of the default Home. |

**Interaction.** World chips filter every shelf below without a page change.
The hero card has "Add to watchlist" and "Discuss" actions. Shelves scroll
horizontally with a peek of the next card.

**States.** Chips: default / selected / pressed. Cards: default / pressed.
Loading uses skeletons that match real card geometry.

---

## 04 · Discover

| Render | Purpose |
|---|---|
| `04-discover` | Editorial landing: worlds, trending, "Most Discussed This Week" ranks, "New & Noticed". |
| `04-discover-world` | A single world (e.g. Anime) with its own shelves and accent. |
| `04-discover-genres` | Genre browse — a dense grid of genre tiles. |

**Interaction.** Ranked rows open the content hub; genre tiles filter into a
results shelf. The world header carries the world accent as a thin underline
and dot only.

**States.** Default / pressed on every tile; empty when a filter yields nothing.

---

## 05 · Search

| Render | Purpose |
|---|---|
| `05-search-idle` | Recent searches, trending queries, category shortcuts. |
| `05-search-results` | Segmented results: Content / People / Communities, with a content section, people rows, community rows. |
| `05-search-empty` | No results — calm empty state with suggestions. |
| `05-search-loading` | Skeleton result rows. |

**Interaction.** The search field autofocuses; typing debounces into results.
Segmented control switches result type in place. Recent queries are
individually dismissible.

**States.** Field: default / focused / filled / cleared. Results: loading /
populated / empty.

---

## 06 · Entertainment Detail (universal Content Hub)

This is the most important screen in the product: **one template serves every
world**. A movie, an anime, and a K-Drama differ only by their data.

| Render | Purpose |
|---|---|
| `06-content-kdrama` | Series hub (Cherry Blossom Season). |
| `06-content-anime` | Anime hub (Neon Blade) — the reference render. |
| `06-content-anime-light` | Light-theme parity render of the anime hub. |
| `06-content-hollywood-movie` | Film hub (Orbital) — runtime instead of episodes. |
| `06-content-episodes` | Episodes tab — season selector + episode list with progress. |
| `06-content-discussion` | Community tab — posts, spoiler-veiled threads. |
| `06-content-cast` | Cast & characters — horizontal people rail. |

**Anatomy.** Backdrop hero with scrim → back / share / more → world badge +
trending badge → title (display) → rating · year · type · episode count →
genres → primary "Watchlist" + "Follow" → synopsis → **Community activity**
("2.4K fans discussing" + avatar stack) → tabbed sections (Overview / Episodes /
Community / Cast).

**Interaction.** Watchlist toggles in place with a spring confirm. Tabs switch
content without navigation. Episode rows carry a progress bar and a resume
affordance. Spoiler threads blur until tapped.

**States.** Watchlist: default / added. Follow: default / following. Episode:
unwatched / in-progress / watched. Loading / error covered by Global States.

**Code/design parity.** The hub is produced by one `content_hub(tid, tab)`
function; the three world variants pass different title ids and the template
renders the correct metadata for each. This is the extensibility proof: a new
content type is a new data row, not a new screen.

---

## 07 · Fandoms / Communities

| Render | Purpose |
|---|---|
| `07-comm-discover` | Browse communities with a "Create community" entry. |
| `07-comm-detail` | A community: cover, header, Join, segmented tabs, posts, premiere thread. |
| `07-comm-create` | Create a community — name, world, description, cover. |
| `07-comm-empty` | A community with no posts yet. |

**Interaction.** Join toggles with a spring; the segmented tabs (Posts /
Discussions / Members / About) swap in place. The premiere thread demonstrates
the spoiler veil.

**States.** Join: default / joined. Tabs: default / selected. Empty community
uses the shared empty-state component.

---

## 08 · Social Feed

| Render | Purpose |
|---|---|
| `08-feed` | Mixed feed: text post with media, hot-take post, poll post. |
| `08-post-detail` | A single post with threaded comments and a reply composer. |
| `08-post-menu` | Post overflow sheet: Save, Copy link, Hide, Report. |
| `08-feed-empty` | "Start the conversation" empty state. |

**Interaction.** Like / comment / save / share actions sit under each post; like
and save animate with a spring and a color fill. Polls reveal results on vote.
Comments support one level of reply nesting.

**States.** Action buttons: default / liked / saved. Post: default / spoiler-
veiled. Poll: unvoted / voted (winning option highlighted). Sheet: closed / open.

---

## 09 · Explore / Short-form

| Render | Purpose |
|---|---|
| `09-shorts` | Full-bleed vertical video with a right action rail and bottom meta. |
| `09-shorts-comments` | Short with the comment sheet open. |

**Interaction.** Tap to play/pause; controls auto-hide after 3s. Swipe up/down
moves between shorts; the right rail carries like / comment / save / share.
The comment sheet slides up over the video.

**States.** Play / pause; liked / saved; comment sheet open.

---

## 10 · Creation

| Render | Purpose |
|---|---|
| `10-create-menu` | The create sheet: post, poll, review, list, community. |
| `10-create-post` | Composer: text, attach media, tag a title, world selector. |
| `10-create-poll` | Poll builder with options and duration. |
| `10-create-attach` | Media attach sheet (camera / library / link). |
| `10-create-uploading` | Upload progress with per-item status. |
| `10-create-success` | Post-published confirmation with a "View post" action. |

**Interaction.** The center Create tab opens the create sheet rather than
switching tabs. The composer tags content via a searchable title picker.
Upload shows per-item progress; success uses a spring confirm and a brief toast.

**States.** Composer: empty / filled / disabled (nothing to post). Upload:
queued / uploading / done / failed. Button: default / loading / success.

---

## 11 · Profiles

| Render | Purpose |
|---|---|
| `11-profile-own` | Your profile: cover, avatar, bio, world badges, stats, tabs, your posts. |
| `11-profile-creator` | A creator profile with a Follow button and a featured post. |
| `11-profile-edit` | Edit profile: avatar, name, handle, bio, worlds, links. |

**Interaction.** Cover and avatar are editable on your own profile. Stats are
tappable (followers / following / posts). Tabs switch between Posts / Lists /
Likes. Follow toggles with a spring.

**States.** Follow: default / following. Tabs: default / selected. Avatar:
default / with ring / live.

---

## 12 · Notifications

| Render | Purpose |
|---|---|
| `12-notifications` | Grouped activity: reactions, follows, replies, community mentions. |
| `12-notifications-empty` | "You're all caught up." |

**Interaction.** Rows are tappable and deep-link to the source. Unread rows
carry an Iris dot; a "Mark all read" action sits in the top bar.

**States.** Read / unread. Empty state uses the shared component.

---

## 13 · Messages

| Render | Purpose |
|---|---|
| `13-messages-list` | Conversation list with avatars, previews, unread counts. |
| `13-message-thread` | A conversation: bubbles, timestamps, a composer. |

**Interaction.** Threads open on tap; the composer sends on submit. Own messages
align right in `--brand-soft`; others align left on `--surface-2`.

**States.** Unread badge; sending / sent; empty thread.

---

## 14 · Watchlist / Saved

| Render | Purpose |
|---|---|
| `14-watchlist` | Titles you plan to watch, with progress and world filters. |
| `14-saved` | Saved posts, organized by type. |

**Interaction.** Watchlist items show a progress bar and a "continue" affordance;
filters narrow by world. Saved posts open the post detail.

**States.** Filter: default / selected. Item: not-started / in-progress /
completed. Empty state for both.

---

## 15 · Settings

| Render | Purpose |
|---|---|
| `15-settings` | Grouped settings: account, notifications, content, privacy, about. |
| `15-settings-appearance` | Theme (system / dark / light), text size, reduce motion. |

**Interaction.** Rows toggle switches or push sub-screens. Appearance changes
apply live across the app.

**States.** Switch: on / off. Row: default / pressed. Danger rows use
`--danger` text.

---

## 16 · Global States

| Render | Purpose |
|---|---|
| `16-states-loading` | Full-screen skeleton (top bar + hero + posts). |
| `16-states-empty` | Generic empty state. |
| `16-states-error` | "Something went wrong" + Retry. |
| `16-states-offline` | No connection + Retry. |
| `16-states-success` | Success confirmation. |
| `16-states-toast` | Floating toast. |
| `16-states-dialog` | Centered dialog. |
| `16-states-sheet` | Bottom sheet. |

**Interaction.** Toasts auto-dismiss (~4s). Dialogs and sheets trap focus and
dismiss on scrim tap or the close affordance.

**States.** This section *is* the state library — every other screen composes
from these.

---

## 17 · Navigation

| Render | Purpose |
|---|---|
| `pages/navigation.html` | The navigation map: tab bar, nav item states, create button, back button, top bars. |

**Interaction.** Five tabs: Home · Explore · Create (center) · Activity · You.
The center Create disc opens the create sheet. Detail screens push; sheets slide
up; dialogs fade+scale.

**States.** Nav item: default / selected / pressed. Create: default / pressed.
See `navigation.md` for the full information architecture.

---

## Cross-cutting requirements

**Asset requirements.** Every screen relies only on assets in `assets/` —
posters (2:3), backdrops (16:9), avatars (1:1), the hero image, the brand marks
and the icon set. No screen embeds a one-off graphic that isn't in the manifest.

**Interaction definitions.** Pressed = scale 0.97 + 8% dim; focus-visible = 2px
Iris ring at 2px offset; selected = Iris fill or ring; disabled = 45% opacity,
no shadow, no press.

**Code/design parity.** Screens are generated by `src/build.py` from shared
component helpers in `src/ui.py`; the PNGs are rendered from the resulting HTML
by `src/render.py`. The reference images therefore *are* the coded design.

**Responsive behavior.** All screens are built on a fluid frame; at ≥ 414pt
grids gain a column and margins widen to 20px; at tablet widths the content hub
becomes two-column and shelves widen. The tab bar stays five items at every
width.
