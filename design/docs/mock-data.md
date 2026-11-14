# Hallyu — Mock Data

All screens share one coherent mock universe, defined in `src/mock.py`. Using a
single dataset is what makes the reference renders feel like *one product*
rather than disconnected mockups: the same titles, users and communities recur
across Home, Discover, the Content Hub, the feed, profiles and communities.

---

## 1. Worlds

| id | Label | Short | Icon | Accent |
|---|---|---|---|---|
| `kdrama` | K-Dramas | K-Drama | `drama` | `#FF6B8A` |
| `cdrama` | C-Dramas | C-Drama | `building` | `#3DD6C4` |
| `anime` | Anime | Anime | `anime` | `#8B75FF` |
| `hollywood` | Hollywood | Hollywood | `popcorn` | `#FFB74D` |

A world is a token pair plus a row — the extensibility guarantee.

---

## 2. Titles

Each title carries: `id, title, world, year, type, genres, rating, eps, poster,
backdrop, synopsis, tag`.

| id | Title | World | Year | Type | Rating | Eps |
|---|---|---|---|---|---|---|
| `cherry` | Cherry Blossom Season | K-Drama | 2024 | Series | 8.7 | 16 |
| `midnight` | Midnight in Seoul | K-Drama | 2023 | Series | 9.1 | 12 |
| `jade` | Jade Empire | C-Drama | 2024 | Series | 8.9 | 40 |
| `shanghai` | Shanghai Nights | C-Drama | 2025 | Series | 8.3 | 24 |
| `neon` | Neon Blade | Anime | 2025 | Anime | 9.3 | 24 |
| `starlight` | Starlight Oath | Anime | 2024 | Anime | 8.8 | 12 |
| `arcane` | Arcane Bloom | Anime | 2025 | Anime | 8.5 | 12 |
| `orbital` | Orbital | Hollywood | 2025 | Movie | 8.6 | — |
| `raincity` | Rain City | Hollywood | 2024 | Series | 8.9 | 10 |
| `lastsignal` | The Last Signal | Hollywood | 2025 | Movie | 8.2 | — |

`neon` (Neon Blade) is the reference title used across the Content Hub, feed,
shorts and discussion renders. `orbital` demonstrates the movie variant
(runtime, no episodes). `cherry` demonstrates the series variant.

Tags in use: `#1 Trending`, `Trending`, `Most Discussed`, `Hidden Gem`, `New`,
`New & Noticed`, `Fan Favorite`, `Popular This Week`.

---

## 3. Users

| handle | Name | Verified | Followers | Fandoms |
|---|---|---|---|---|
| `minji` | Min-ji Park | ✓ | 12.4K | kdrama, cdrama, anime |
| `devon` | Devon Reyes | — | 3.1K | hollywood, anime |
| `aiko` | Aiko Tanaka | ✓ | 48.9K | anime, kdrama |
| `leo` | Leo Martins | — | 1.8K | cdrama, hollywood, kdrama |
| `you` | You | — | 128 | anime, kdrama, hollywood |

`you` is the signed-in user for profile / own-post renders. `aiko` is the
featured creator and the author of the shorts clip.

---

## 4. Communities

| id | Name | Members | Icon | Accent | Joined |
|---|---|---|---|---|---|
| `anime-world` | Anime World | 1.2M | anime | `#8B75FF` | — |
| `kdrama-lovers` | K-Drama Lovers | 864K | drama | `#FF6B8A` | ✓ |
| `cdrama-central` | C-Drama Central | 312K | building | `#3DD6C4` | — |
| `marvel-fans` | Marvel Fans | 2.1M | sparkles | `#FFB74D` | — |
| `romance-fans` | Romance Fans | 540K | heart | `#FF5C7A` | ✓ |
| `shonen` | Shōnen Community | 780K | flame | `#FFB74D` | — |
| `horror` | Horror Fans | 198K | alert | `#FF6B6B` | — |
| `onepiece` | One Piece | 1.6M | world | `#8B75FF` | — |

---

## 5. Sample post content

The feed and detail renders use realistic, world-appropriate posts, e.g.:

- *"Episode 18 of Neon Blade rewired my brain. The score dropping out right
  before the reveal… I had to pause."* — Min-ji, about Neon Blade (with media).
- *"Hot take: Orbital is the best sci-fi film of the decade."* — Devon.
- *"Which should I start tonight?"* — Leo (poll: Jade Empire / Rain City /
  Starlight Oath).
- *"Unpopular opinion: the finale was perfect…"* — Aiko (spoiler-veiled).

Comments, replies, poll percentages and engagement counts are all populated so
the layouts demonstrate real density.

---

## 6. Why this matters for review

Because every screen draws from the same dataset, a reviewer can follow a single
title — Neon Blade — from the Home hero, into the Content Hub, through its
episodes, into a community discussion, into a post, and onto its author's
profile, and the data stays consistent the whole way. That continuity is the
strongest evidence that the system is a *product*, not a set of pictures.
