"""Hallyu mock data — realistic entertainment + social content for the design
reference renders. Kept in one place so every screen shares the same world."""

IMG = "assets/img"

WORLDS = {
    "kdrama":    {"label": "K-Dramas",  "short": "K-Drama",   "icon": "drama",  "color": "#FF6B8A"},
    "cdrama":    {"label": "C-Dramas",  "short": "C-Drama",   "icon": "building","color": "#3DD6C4"},
    "anime":     {"label": "Anime",     "short": "Anime",     "icon": "anime",  "color": "#8B75FF"},
    "hollywood": {"label": "Hollywood", "short": "Hollywood", "icon": "popcorn","color": "#FFB74D"},
}

# id, title, world, year, type, genres, rating, episodes, poster, backdrop, synopsis, tag
TITLES = [
    dict(id="cherry", title="Cherry Blossom Season", world="kdrama", year=2024, type="Series",
         genres=["Romance", "Drama"], rating=8.7, eps=16, poster=f"{IMG}/poster-kdrama-romance.jpg",
         backdrop=f"{IMG}/backdrop-kdrama.jpg", tag="Trending",
         synopsis="A reserved architect and a free-spirited florist keep colliding at the same Seoul intersection — and slowly rewrite the seasons of each other's lives."),
    dict(id="midnight", title="Midnight in Seoul", world="kdrama", year=2023, type="Series",
         genres=["Thriller", "Crime"], rating=9.1, eps=12, poster=f"{IMG}/poster-kdrama-thriller.jpg",
         backdrop=f"{IMG}/backdrop-kdrama.jpg", tag="Most Discussed",
         synopsis="A homicide detective with a photographic memory hunts a killer who only strikes during the city's heaviest rains."),
    dict(id="jade", title="Jade Empire", world="cdrama", year=2024, type="Series",
         genres=["Fantasy", "Historical", "Action"], rating=8.9, eps=40, poster=f"{IMG}/poster-cdrama-wuxia.jpg",
         backdrop=f"{IMG}/backdrop-hollywood.jpg", tag="Hidden Gem",
         synopsis="In a fractured empire, a disgraced swordswoman must unite four rival clans before an ancient power wakes beneath the mountains."),
    dict(id="shanghai", title="Shanghai Nights", world="cdrama", year=2025, type="Series",
         genres=["Romance", "Drama"], rating=8.3, eps=24, poster=f"{IMG}/poster-cdrama-romance.jpg",
         backdrop=f"{IMG}/backdrop-hollywood.jpg", tag="New",
         synopsis="Two ambitious founders fall for each other while racing to save their rival startups in a city that never slows down."),
    dict(id="neon", title="Neon Blade", world="anime", year=2025, type="Anime",
         genres=["Action", "Sci-Fi", "Supernatural"], rating=9.3, eps=24, poster=f"{IMG}/poster-anime-hero.jpg",
         backdrop=f"{IMG}/backdrop-anime.jpg", tag="#1 Trending",
         synopsis="In a rain-drenched megacity, a young swordsman inherits a blade that remembers every life it has ever taken."),
    dict(id="starlight", title="Starlight Oath", world="anime", year=2024, type="Anime",
         genres=["Romance", "Fantasy", "Slice of Life"], rating=8.8, eps=12, poster=f"{IMG}/poster-anime-romance.jpg",
         backdrop=f"{IMG}/backdrop-anime.jpg", tag="Fan Favorite",
         synopsis="Two childhood friends promise to meet under the same star every summer — until one of them stops coming."),
    dict(id="arcane", title="Arcane Bloom", world="anime", year=2025, type="Anime",
         genres=["Fantasy", "Action"], rating=8.5, eps=12, poster=f"{IMG}/poster-anime-magic.jpg",
         backdrop=f"{IMG}/backdrop-anime.jpg", tag="New & Noticed",
         synopsis="A quiet academy student discovers she can grow living weapons from light — and that the academy has been waiting for her."),
    dict(id="orbital", title="Orbital", world="hollywood", year=2025, type="Movie",
         genres=["Sci-Fi", "Adventure"], rating=8.6, eps=None, poster=f"{IMG}/poster-hollywood-scifi.jpg",
         backdrop=f"{IMG}/backdrop-hollywood.jpg", tag="Popular This Week",
         synopsis="When the last deep-space relay goes silent, a lone engineer must cross a dying solar system to send one final message home."),
    dict(id="raincity", title="Rain City", world="hollywood", year=2024, type="Series",
         genres=["Thriller", "Mystery"], rating=8.9, eps=10, poster=f"{IMG}/poster-hollywood-thriller.jpg",
         backdrop=f"{IMG}/backdrop-hollywood.jpg", tag="Trending",
         synopsis="A disgraced journalist returns to her flooded hometown to chase the story that ended her career — and finds it never ended."),
    dict(id="lastsignal", title="The Last Signal", world="hollywood", year=2025, type="Movie",
         genres=["Action", "Thriller"], rating=8.2, eps=None, poster=f"{IMG}/poster-hollywood-action.jpg",
         backdrop=f"{IMG}/backdrop-hollywood.jpg", tag="New",
         synopsis="A retired field agent is pulled back for one night in a neon-soaked city where every ally is a suspect."),
]

TITLE_BY_ID = {t["id"]: t for t in TITLES}


USERS = [
    dict(handle="minji", name="Min-ji Park", avatar=f"{IMG}/avatar-01.jpg", verified=True,
         bio="Romance-drama apologist. I will defend the slow burn. 🇰🇷✈️🌍", followers="12.4K", following="312",
         fandoms=["kdrama", "cdrama", "anime"]),
    dict(handle="devon", name="Devon Reyes", avatar=f"{IMG}/avatar-02.jpg", verified=False,
         bio="Sci-fi, thrillers, and anything with a good score. Reviews weekly.", followers="3.1K", following="208",
         fandoms=["hollywood", "anime"]),
    dict(handle="aiko", name="Aiko Tanaka", avatar=f"{IMG}/avatar-03.jpg", verified=True,
         bio="Anime critic & editor. Shōnen heart, slice-of-life soul.", followers="48.9K", following="540",
         fandoms=["anime", "kdrama"]),
    dict(handle="leo", name="Leo Martins", avatar=f"{IMG}/avatar-04.jpg", verified=False,
         bio="Watching everything, spoiling nothing. Horror + wuxia + prestige TV.", followers="1.8K", following="421",
         fandoms=["cdrama", "hollywood", "kdrama"]),
    dict(handle="you", name="You", avatar=f"{IMG}/avatar-01.jpg", verified=False,
         bio="Building my Hallyu identity. Anime, K-Dramas, and a growing watchlist.",
         followers="128", following="96", fandoms=["anime", "kdrama", "hollywood"]),
]
USER_BY_HANDLE = {u["handle"]: u for u in USERS}


COMMUNITIES = [
    dict(id="anime-world", name="Anime World", members="1.2M", icon="anime", color="#8B75FF",
         desc="The biggest anime community on Hallyu. Seasonal rankings, theories, and edits.", joined=False),
    dict(id="kdrama-lovers", name="K-Drama Lovers", members="864K", icon="drama", color="#FF6B8A",
         desc="From slow burns to revenge plots. Weekly episode threads, no spoilers.", joined=True),
    dict(id="cdrama-central", name="C-Drama Central", members="312K", icon="building", color="#3DD6C4",
         desc="Wuxia, xianxia, and modern romance. Subtitle-friendly discussions.", joined=False),
    dict(id="marvel-fans", name="Marvel Fans", members="2.1M", icon="sparkles", color="#FFB74D",
         desc="Movies, series, and everything in between. Theories welcome.", joined=False),
    dict(id="romance-fans", name="Romance Fans", members="540K", icon="heart", color="#FF5C7A",
         desc="For everyone who rewatches the confession scene. All worlds welcome.", joined=True),
    dict(id="shonen", name="Shōnen Community", members="780K", icon="flame", color="#FFB74D",
         desc="Power scaling, tournament arcs, and the eternal debate.", joined=False),
    dict(id="horror", name="Horror Fans", members="198K", icon="alert", color="#FF6B6B",
         desc="Scares across every world. Watch with the lights on.", joined=False),
    dict(id="onepiece", name="One Piece", members="1.6M", icon="world", color="#8B75FF",
         desc="The Grand Line's biggest crew. Manga + anime discussion.", joined=False),
]
COMMUNITY_BY_ID = {c["id"]: c for c in COMMUNITIES}


def title_ctx(tid):
    t = TITLE_BY_ID[tid]
    return {"world": t["world"], "title": t["title"]}
