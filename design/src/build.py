#!/usr/bin/env python3
"""Build the Hallyu design workspace HTML (coded design representation).
Writes: design/screens/*.html, design/pages/*.html
Run:  python3 src/build.py   (from the design/ directory)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from icons import icon
from ui import *  # noqa
from mock import WORLDS, TITLES, TITLE_BY_ID, USERS, USER_BY_HANDLE, COMMUNITIES, IMG

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCREENS = os.path.join(ROOT, "screens")
PAGES = os.path.join(ROOT, "pages")
os.makedirs(SCREENS, exist_ok=True)
os.makedirs(PAGES, exist_ok=True)

def write(path, html):
    with open(path, "w") as f:
        f.write(html)
    print("  wrote", os.path.relpath(path, ROOT))

def screen(name, title, content, cls="", theme="dark"):
    body = device(statusbar() + content + home_indicator(), cls=cls, theme=theme)
    write(os.path.join(SCREENS, name), page(title, body, theme=theme))

# =====================================================================
# 01 BRAND / APP ENTRY
# =====================================================================
def s_brand():
    # Splash
    splash = f"""<div class="screen-body" style="align-items:center;justify-content:center;gap:20px">
      <div style="width:88px;height:88px">{icon("sparkle",0) if False else ''}
        <svg width="88" height="88" viewBox="0 0 512 512"><g fill="none" stroke="#7B61FF" stroke-width="26" stroke-linecap="round"><path d="M256 138 A118 118 0 0 1 374 256"/><path d="M374 256 A118 118 0 0 1 256 374"/><path d="M256 374 A118 118 0 0 1 138 256"/><path d="M138 256 A118 118 0 0 1 256 138"/></g><circle cx="256" cy="256" r="52" fill="#7B61FF"/><circle cx="256" cy="256" r="20" fill="#F5F5FA"/></svg>
      </div>
      <div class="t-display" style="letter-spacing:-0.03em">Hallyu</div>
      <div class="t-body c-secondary" style="margin-top:-12px">Where fandoms meet.</div>
    </div>"""
    screen("01-brand-splash.html", "Hallyu — Splash", splash)

    # Initial loading
    loading = f"""<div class="screen-body" style="align-items:center;justify-content:center;gap:24px">
      <svg width="56" height="56" viewBox="0 0 512 512"><g fill="none" stroke="#7B61FF" stroke-width="30" stroke-linecap="round"><path d="M256 138 A118 118 0 0 1 374 256"/><path d="M374 256 A118 118 0 0 1 256 374"/><path d="M256 374 A118 118 0 0 1 138 256"/><path d="M138 256 A118 118 0 0 1 256 138"/></g><circle cx="256" cy="256" r="52" fill="#7B61FF"/></svg>
      <div class="progress" style="width:180px"><i style="width:64%"></i></div>
      <div class="t-caption c-tertiary">Gathering your worlds…</div>
    </div>"""
    screen("01-brand-loading.html", "Hallyu — Loading", loading)

    # First-launch experience
    first = f"""<div class="screen-body">
      <div class="onb">
        <div class="onb__bg"><img src="assets/img/hero-onboarding.jpg" alt=""/></div>
        <div class="onb__content">
          <span class="onb__eyebrow">{icon("sparkle",16)} Welcome to Hallyu</span>
          <div class="onb__title">Where fandoms<br/>meet.</div>
          <div class="onb__sub">Discover what you love. Find people who love it too.</div>
          <div class="onb__worlds">
            {world_chip('kdrama')}{world_chip('cdrama')}{world_chip('anime')}{world_chip('hollywood')}
          </div>
          <div class="onb__actions">
            {button('Create account','primary',cls='btn--block btn--lg')}
            {button('Sign in','secondary',cls='btn--block btn--lg')}
            <button class="btn btn--ghost btn--block">Continue as guest</button>
          </div>
        </div>
      </div>
    </div>"""
    screen("01-brand-first-launch.html", "Hallyu — First launch", first)

# =====================================================================
# 02 ONBOARDING
# =====================================================================
def s_onboarding():
    # Welcome
    welcome = f"""<div class="screen-body">
      <div class="onb">
        <div class="onb__bg"><img src="assets/img/hero-onboarding.jpg" alt=""/></div>
        <div class="onb__content">
          <span class="onb__eyebrow">{icon("sparkle",16)} Hallyu</span>
          <div class="onb__title">One community.<br/>Four worlds.</div>
          <div class="onb__sub">K-Dramas, C-Dramas, Anime and Hollywood — discover, react, discuss and follow. All in one place.</div>
          <div class="onb__actions">
            {button('Get started','primary',cls='btn--block btn--lg')}
            <button class="btn btn--ghost btn--block">I already have an account</button>
          </div>
        </div>
      </div>
    </div>"""
    screen("02-onb-welcome.html", "Onboarding — Welcome", welcome)

    # Auth
    auth = f"""{topbar(left=back_btn(), center='')}
    <div class="screen-body pad" style="gap:20px;padding-top:8px">
      <div>
        <div class="t-display-l">Create your<br/>Hallyu identity</div>
        <div class="t-body c-secondary mt-3">Join millions of fans across every world.</div>
      </div>
      <div class="col gap-4 mt-2">
        <button class="btn btn--secondary btn--block btn--lg">{icon("globe",20)} Continue with Google</button>
        <button class="btn btn--secondary btn--block btn--lg">{icon("sparkle",20)} Continue with Apple</button>
        <div class="row gap-3" style="color:var(--text-tertiary)"><div class="divider grow"></div><span class="t-caption">or</span><div class="divider grow"></div></div>
        <div class="field"><label class="label">Email</label><input class="input" placeholder="you@example.com"/></div>
        <div class="field"><label class="label">Password</label><input class="input" type="password" placeholder="••••••••"/><span class="help">At least 8 characters</span></div>
        {button('Create account','primary',cls='btn--block btn--lg')}
      </div>
      <div class="t-caption c-tertiary" style="text-align:center;margin-top:auto">By continuing you agree to Hallyu's Terms & Privacy Policy.</div>
    </div>"""
    screen("02-onb-auth.html", "Onboarding — Account", auth)

    # Fandoms
    tiles = ""
    for w in ["kdrama","cdrama","anime","hollywood"]:
        d = WORLDS[w]
        sel = w in ("anime","kdrama")
        img = {"kdrama":"poster-kdrama-romance","cdrama":"poster-cdrama-wuxia","anime":"poster-anime-hero","hollywood":"poster-hollywood-scifi"}[w]
        tiles += f"""<div class="worldtile {'worldtile--selected' if sel else ''}">
          <img src="assets/img/{img}.jpg" alt=""/>
          <div class="worldtile__scrim"></div>
          <div class="worldtile__check">{icon("check",16)}</div>
          <div class="worldtile__label"><span class="worldtile__name">{d['label']}</span><span class="t-caption c-on-media" style="opacity:.8">{'Selected' if sel else 'Tap to select'}</span></div>
        </div>"""
    fandoms = f"""{topbar(left=back_btn(), right=f'<span class="t-label c-tertiary">1 / 4</span>')}
    <div class="screen-body pad" style="gap:20px;padding-top:4px">
      <div class="progress"><i style="width:25%"></i></div>
      <div>
        <div class="t-h1">What are you into?</div>
        <div class="t-body c-secondary mt-2">Pick one or more worlds. You can change this anytime.</div>
      </div>
      <div class="worldgrid">{tiles}</div>
      <div class="row between" style="margin-top:auto;padding-bottom:8px">
        <button class="btn btn--ghost">Skip</button>
        {button('Continue','primary',ic='arrow-right')}
      </div>
    </div>"""
    screen("02-onb-fandoms.html", "Onboarding — Fandoms", fandoms)

    # Genres
    genres = ["Romance","Action","Comedy","Thriller","Fantasy","Mystery","Horror","Sci-Fi","Drama","Adventure","Crime","Historical","School","Supernatural","Slice of Life"]
    sel = {"Romance","Thriller","Fantasy","Slice of Life"}
    gchips = "".join(chip(g, g in sel, ic="check" if g in sel else None) for g in genres)
    genre_screen = f"""{topbar(left=back_btn(), right='<span class="t-label c-tertiary">2 / 4</span>')}
    <div class="screen-body pad" style="gap:20px;padding-top:4px">
      <div class="progress"><i style="width:50%"></i></div>
      <div>
        <div class="t-h1">What keeps you watching?</div>
        <div class="t-body c-secondary mt-2">Choose a few. We'll use them to tune your feed.</div>
      </div>
      <div class="wrap gap-2">{gchips}</div>
      <div class="row between" style="margin-top:auto;padding-bottom:8px">
        <button class="btn btn--ghost">Back</button>
        {button('Continue','primary',ic='arrow-right')}
      </div>
    </div>"""
    screen("02-onb-genres.html", "Onboarding — Genres", genre_screen)

    # Favorite titles
    picks = ["neon","cherry","orbital","jade"]
    cards = "".join(poster_card(t, width=150, badge=None) for t in picks)
    titles_screen = f"""{topbar(left=back_btn(), right='<span class="t-label c-tertiary">3 / 4</span>')}
    <div class="screen-body" style="gap:16px;padding-top:4px">
      <div class="pad">
        <div class="progress"><i style="width:75%"></i></div>
        <div class="t-h1 mt-4">Pick a few favorites</div>
        <div class="t-body c-secondary mt-2">We'll suggest people and communities who love them too.</div>
      </div>
      <div class="shelf">{cards}</div>
      <div class="pad"><div class="searchbar">{icon("search")}<input placeholder="Search titles…"/></div></div>
      <div class="row between pad" style="margin-top:auto;padding-bottom:8px">
        <button class="btn btn--ghost">Back</button>
        {button('Continue','primary',ic='arrow-right')}
      </div>
    </div>"""
    screen("02-onb-titles.html", "Onboarding — Favorites", titles_screen)

    # Find your people
    rows = ""
    for c in COMMUNITIES[:4]:
        rows += f"""<div class="list-row">
          <span class="list-row__icon" style="background:{c['color']}22;color:{c['color']}">{icon(c['icon'],20)}</span>
          <div class="grow"><div class="list-row__title">{c['name']}</div><div class="list-row__sub">{c['members']} members</div></div>
          {follow_btn(c['joined'])}
        </div>"""
    people = f"""{topbar(left=back_btn(), right='<span class="t-label c-tertiary">4 / 4</span>')}
    <div class="screen-body" style="gap:16px;padding-top:4px">
      <div class="pad">
        <div class="progress"><i style="width:100%"></i></div>
        <div class="t-h1 mt-4">Find your people</div>
        <div class="t-body c-secondary mt-2">Join communities and follow creators to shape your feed.</div>
      </div>
      <div class="list">{rows}</div>
      <div class="pad" style="margin-top:auto;padding-bottom:8px">{button('Finish setup','primary',cls='btn--block btn--lg')}</div>
    </div>"""
    screen("02-onb-people.html", "Onboarding — People", people)

    # Done
    done = f"""<div class="screen-body" style="align-items:center;justify-content:center;gap:20px;text-align:center;padding:0 32px">
      <div style="width:96px;height:96px;border-radius:50%;background:var(--brand-soft);display:flex;align-items:center;justify-content:center;color:var(--brand)">{icon("sparkle",48)}</div>
      <div class="t-display">You're all set</div>
      <div class="t-body c-secondary">Your Hallyu world is ready. Here's what we found for you.</div>
      <div class="row gap-2">{world_chip('anime')}{world_chip('kdrama')}{world_chip('hollywood')}</div>
      <div style="width:100%;margin-top:8px">{button('Enter Hallyu','primary',cls='btn--block btn--lg')}</div>
    </div>"""
    screen("02-onb-done.html", "Onboarding — Complete", done)

# =====================================================================
# 03 HOME
# =====================================================================
def s_home():
    def home_body(seg_active="For You"):
        seg = f"""<div class="segmented" style="margin:0 var(--screen-margin)">
          <span class="seg {'seg--active' if seg_active=='For You' else ''}">For You</span>
          <span class="seg {'seg--active' if seg_active=='Following' else ''}">Following</span>
        </div>"""
        head = f"""<div class="home-head">{wordmark()}
          <div class="row gap-1">{icon_btn("search")}{icon_btn("bell","iconbtn--badge")}</div></div>"""
        worlds = f"""<div class="section"><div class="chip-scroll">
          {chip('All', True)}{world_chip('kdrama')}{world_chip('cdrama')}{world_chip('anime')}{world_chip('hollywood')}
        </div></div>"""
        hero = f"""<div class="section" style="padding-top:8px">
          <div class="hero-card"><img src="assets/img/backdrop-anime.jpg" alt=""/>
            <div class="art-scrim"></div>
            <div class="hero-card__body">
              <div class="hero-card__badges"><span class="art-badge art-badge--live">{icon("flame",12)} #1 Trending</span><span class="art-badge">Anime</span></div>
              <div class="t-h2 c-on-media">Neon Blade</div>
              <div class="t-body-s c-on-media" style="opacity:.85">24 episodes · Action · Sci-Fi</div>
              <div class="row gap-2 mt-2">{button('Add to watchlist','primary',ic='plus',size='sm')}{button('Discuss','secondary',ic='comment',size='sm')}</div>
            </div>
          </div>
        </div>"""
        trending = f"""<div class="section">{section_header('Trending on Hallyu','See all',icon_name='trending')}
          <div class="shelf">{poster_card('neon',132,'1')}{poster_card('midnight',132,'2')}{poster_card('orbital',132,'3')}</div>
        </div>"""
        fandoms = f"""<div class="section">{section_header('Your Fandoms')}
          <div class="shelf">
            {world_chip('anime','Anime · 12 new')}{world_chip('kdrama','K-Drama · 8 new')}{world_chip('hollywood','Hollywood · 5 new')}
          </div></div>"""
        cross = f"""<div class="section">{section_header('Because you love psychological anime')}
          <div class="shelf">{poster_card('midnight',132)}{poster_card('raincity',132)}{poster_card('jade',132)}</div>
        </div>"""
        feed = post_card("minji",
            "Episode 18 of Neon Blade absolutely rewired my brain. The way the score drops out right before the reveal… I had to pause and breathe. 🎬",
            ctx=title_ctx("neon"), media="single", likes="4.8K", comments="612", saves="1.1K", liked=True, saved=True)
        feed2 = post_card("devon",
            "Hot take: Orbital is the best sci-fi film of the decade and it's not close. The silence in the third act does more than any explosion could.",
            ctx=title_ctx("orbital"), likes="2.1K", comments="304", saves="420")
        body = head + worlds + hero + trending + fandoms + cross + feed + feed2
        return body

    screen("03-home-foryou.html", "Home — For You", f'<div class="screen-body screen-scroll">{home_body()}</div>' + tabbar("home"))

    # Following
    feed = post_card("aiko", "New edit drop for Starlight Oath — the summer festival scene, slowed down. Sound on. 🌟", ctx=title_ctx("starlight"), media="single", likes="9.2K", comments="1.4K")
    feed2 = post_card("leo", "Finished Jade Empire last night. 40 episodes and I'd watch 40 more. The clan politics alone deserve a rewatch.", ctx=title_ctx("jade"), likes="1.6K", comments="208")
    following = f"""<div class="home-head">{wordmark()}<div class="row gap-1">{icon_btn("search")}{icon_btn("bell")}</div></div>
      <div class="segmented" style="margin:0 var(--screen-margin)"><span class="seg">For You</span><span class="seg seg--active">Following</span></div>
      <div class="section" style="padding-bottom:0">{section_header('From people you follow', more=None)}</div>
      {feed}{feed2}"""
    screen("03-home-following.html", "Home — Following", f'<div class="screen-body screen-scroll">{following}</div>' + tabbar("home"))

    # Loading (skeleton)
    sk = f"""<div class="home-head">{wordmark()}<div class="row gap-1">{icon_btn("search")}{icon_btn("bell")}</div></div>
      <div class="pad"><div class="sk" style="height:190px;border-radius:18px"></div></div>
      <div class="section"><div class="shelf">
        <div class="sk sk--poster" style="width:132px"></div><div class="sk sk--poster" style="width:132px"></div><div class="sk sk--poster" style="width:132px"></div>
      </div></div>
      {skeleton_post()}{skeleton_post()}"""
    screen("03-home-loading.html", "Home — Loading", f'<div class="screen-body screen-scroll">{sk}</div>' + tabbar("home"))

    # Guest empty
    guest = f"""<div class="home-head">{wordmark()}<div class="row gap-1">{icon_btn("search")}</div></div>
      <div class="screen-body" style="justify-content:center">
        {empty_state('Create your Hallyu identity','Sign in to build a personal feed, follow fandoms, and join the conversation.','Sign in', 'user')}
      </div>"""
    screen("03-home-guest.html", "Home — Guest", guest + tabbar("home"))

    # Light theme parity
    screen("03-home-foryou-light.html", "Home — For You (Light)",
           f'<div class="screen-body screen-scroll">{home_body()}</div>' + tabbar("home"), theme="light")

# =====================================================================
# 04 DISCOVER
# =====================================================================
def s_discover():
    head = f"""{topbar(left='<span class="t-h1">Discover</span>', right=icon_btn("search"))}"""
    search = f"""<div class="pad" style="padding-bottom:8px"><div class="searchbar">{icon("search")}<input placeholder="Search movies, anime, people…"/></div></div>"""
    worlds = f"""<div class="section" style="padding-top:8px">{section_header('Fandoms')}
      <div class="shelf">
        <div class="pcard" style="width:150px"><div class="pcard__art" style="aspect-ratio:1/0.7"><img src="assets/img/poster-kdrama-romance.jpg"/><div class="art-scrim"></div><div style="position:absolute;left:12px;bottom:10px" class="row gap-2">{world_dot('kdrama')}<span class="t-card-title c-on-media">K-Dramas</span></div></div></div>
        <div class="pcard" style="width:150px"><div class="pcard__art" style="aspect-ratio:1/0.7"><img src="assets/img/poster-cdrama-wuxia.jpg"/><div class="art-scrim"></div><div style="position:absolute;left:12px;bottom:10px" class="row gap-2">{world_dot('cdrama')}<span class="t-card-title c-on-media">C-Dramas</span></div></div></div>
      </div>
      <div class="shelf" style="margin-top:12px">
        <div class="pcard" style="width:150px"><div class="pcard__art" style="aspect-ratio:1/0.7"><img src="assets/img/poster-anime-hero.jpg"/><div class="art-scrim"></div><div style="position:absolute;left:12px;bottom:10px" class="row gap-2">{world_dot('anime')}<span class="t-card-title c-on-media">Anime</span></div></div></div>
        <div class="pcard" style="width:150px"><div class="pcard__art" style="aspect-ratio:1/0.7"><img src="assets/img/poster-hollywood-scifi.jpg"/><div class="art-scrim"></div><div style="position:absolute;left:12px;bottom:10px" class="row gap-2">{world_dot('hollywood')}<span class="t-card-title c-on-media">Hollywood</span></div></div></div>
      </div>
    </div>"""
    trending = f"""<div class="section">{section_header('Trending Now','See all',icon_name='flame')}
      <div class="shelf">{poster_card('neon',132,badge=('#1 Trending','brand'))}{poster_card('cherry',132)}{poster_card('raincity',132)}{poster_card('jade',132)}</div></div>"""
    ranks = ""
    for i,t in enumerate(["neon","midnight","orbital","starlight","raincity"],1):
        tt = TITLE_BY_ID[t]
        ranks += f"""<div class="rank-row"><span class="rank-num">{i}</span>
          <div class="rank-thumb"><img src="{tt['poster']}"/></div>
          <div class="grow"><div class="t-card-title truncate">{tt['title']}</div><div class="t-meta c-tertiary">{WORLDS[tt['world']]['short']} · {tt['year']}</div></div>
          {rating(tt['rating'])}</div>"""
    most = f"""<div class="section">{section_header('Most Discussed This Week','See all')}{ranks}</div>"""
    new = f"""<div class="section">{section_header('New & Noticed','See all',icon_name='sparkles')}
      <div class="shelf">{poster_card('shanghai',132,badge=('New','warm'))}{poster_card('arcane',132,badge=('New','warm'))}{poster_card('lastsignal',132,badge=('New','warm'))}</div></div>"""
    body = head + search + worlds + trending + most + new
    screen("04-discover.html", "Discover", f'<div class="screen-body screen-scroll">{body}</div>' + tabbar("explore"))

    # World view (Anime)
    whead = f"""{topbar(left=back_btn(), center='<span class="t-h3">Anime</span>', right=icon_btn("search"))}"""
    wchips = f"""<div class="chip-scroll" style="padding-bottom:8px">{chip('All',True)}{chip('Top Rated')}{chip('Airing')}{chip('Movies')}{chip('Shōnen')}{chip('Romance')}</div>"""
    wbody = whead + wchips + f"""<div class="section" style="padding-top:8px">{section_header('Popular in Anime')}
      <div class="grid-posters">{poster_card('neon',120)}{poster_card('starlight',120)}{poster_card('arcane',120)}{poster_card('neon',120)}{poster_card('starlight',120)}{poster_card('arcane',120)}</div></div>"""
    screen("04-discover-world.html", "Discover — Anime", f'<div class="screen-body screen-scroll">{wbody}</div>' + tabbar("explore"))

    # Genres
    genres = ["Romance","Action","Comedy","Thriller","Fantasy","Mystery","Horror","Sci-Fi","Drama","Adventure","Crime","Historical","School","Supernatural","Slice of Life","Musical"]
    g = "".join(chip(x, ic="chevron-right") for x in genres)
    gbody = f"""{topbar(left=back_btn(), center='<span class="t-h3">Browse by genre</span>')}
      <div class="screen-body pad" style="gap:16px;padding-top:8px">
        <div class="searchbar">{icon("search")}<input placeholder="Find a genre"/></div>
        <div class="wrap gap-2">{g}</div>
      </div>"""
    screen("04-discover-genres.html", "Discover — Genres", gbody + tabbar("explore"))

# =====================================================================
# 05 SEARCH
# =====================================================================
def s_search():
    idle = f"""{topbar(left=back_btn(), right='<span class="t-label c-brand">Cancel</span>')}
    <div class="screen-body" style="gap:12px">
      <div class="pad"><div class="searchbar searchbar--focused">{icon("search")}<input placeholder="Search everything on Hallyu" value="neon"/></div></div>
      <div class="search-seg">{chip('All',True)}{chip('Content')}{chip('People')}{chip('Communities')}{chip('Posts')}</div>
      <div class="pad"><div class="t-overline c-tertiary">Recent</div></div>
      <div class="list">
        <div class="list-row">{icon("history",20)}<div class="grow"><div class="list-row__title">jade empire</div></div>{icon("close",16)}</div>
        <div class="list-row">{icon("history",20)}<div class="grow"><div class="list-row__title">aiko tanaka</div></div>{icon("close",16)}</div>
      </div>
      <div class="pad"><div class="t-overline c-tertiary">Trending searches</div></div>
      <div class="list">
        <div class="list-row"><span class="rank-num" style="font-size:16px">1</span><div class="grow"><div class="list-row__title">neon blade finale</div></div>{icon("trending",16)}</div>
        <div class="list-row"><span class="rank-num" style="font-size:16px">2</span><div class="grow"><div class="list-row__title">orbital 2</div></div>{icon("trending",16)}</div>
        <div class="list-row"><span class="rank-num" style="font-size:16px">3</span><div class="grow"><div class="list-row__title">best wuxia dramas</div></div></div>
      </div>
    </div>"""
    screen("05-search-idle.html", "Search — Idle", idle)

    # Results
    results = f"""{topbar(left=back_btn(), right='<span class="t-label c-brand">Cancel</span>')}
    <div class="screen-body" style="gap:12px">
      <div class="pad"><div class="searchbar searchbar--focused">{icon("search")}<input value="neon"/></div></div>
      <div class="search-seg">{chip('All',True)}{chip('Content')}{chip('People')}{chip('Communities')}{chip('Posts')}</div>
      <div class="section" style="padding-top:12px">{section_header('Content', more=None)}
        <div class="shelf">{poster_card('neon',120)}{poster_card('arcane',120)}{poster_card('starlight',120)}</div></div>
      <div class="section" style="padding-top:0">{section_header('People', more=None)}
        <div class="list">
          <div class="list-row">{avatar('assets/img/avatar-03.jpg','md')}<div class="grow"><div class="list-row__title">Aiko Tanaka {icon('verified',13,'verified')}</div><div class="list-row__sub">@aiko · 48.9K followers</div></div>{follow_btn()}</div>
          <div class="list-row">{avatar('assets/img/avatar-02.jpg','md')}<div class="grow"><div class="list-row__title">Devon Reyes</div><div class="list-row__sub">@devon · 3.1K followers</div></div>{follow_btn(True)}</div>
        </div></div>
      <div class="section" style="padding-top:0">{section_header('Communities', more=None)}
        <div class="list"><div class="list-row"><span class="list-row__icon" style="background:#8B75FF22;color:#8B75FF">{icon('anime',20)}</span><div class="grow"><div class="list-row__title">Anime World</div><div class="list-row__sub">1.2M members</div></div>{follow_btn()}</div></div>
      </div>
    </div>"""
    screen("05-search-results.html", "Search — Results", results)

    # Empty
    empty = f"""{topbar(left=back_btn(), right='<span class="t-label c-brand">Cancel</span>')}
    <div class="screen-body" style="gap:12px">
      <div class="pad"><div class="searchbar searchbar--focused">{icon("search")}<input value="asdfgh"/></div></div>
      <div class="screen-body" style="justify-content:center">
        {empty_state('No results for "asdfgh"','Try a different spelling, or explore by fandom instead.','Browse fandoms','search')}
      </div>
    </div>"""
    screen("05-search-empty.html", "Search — No results", empty)

    # Loading
    loading = f"""{topbar(left=back_btn(), right='<span class="t-label c-brand">Cancel</span>')}
    <div class="screen-body" style="gap:12px">
      <div class="pad"><div class="searchbar searchbar--focused">{icon("search")}<input value="neon"/></div></div>
      <div class="search-seg">{chip('All',True)}{chip('Content')}{chip('People')}{chip('Communities')}{chip('Posts')}</div>
      <div class="section" style="padding-top:12px"><div class="shelf">
        <div class="sk sk--poster" style="width:120px"></div><div class="sk sk--poster" style="width:120px"></div><div class="sk sk--poster" style="width:120px"></div>
      </div></div>
      <div class="list">{skeleton_post()}{skeleton_post()}</div>
    </div>"""
    screen("05-search-loading.html", "Search — Loading", loading)

# =====================================================================
# 06 CONTENT HUB (universal)
# =====================================================================
def content_hub(tid, tab="Overview", extra_section=""):
    t = TITLE_BY_ID[tid]
    hero = f"""<div class="content-hero">
      <img class="content-hero__img" src="{t['backdrop']}" alt=""/>
      <div class="content-hero__grad"></div>
      <div class="content-hero__nav">{icon_btn("back","iconbtn--glass")}<div class="row gap-1">{icon_btn("share","iconbtn--glass")}{icon_btn("more","iconbtn--glass")}</div></div>
      <div class="content-hero__info">
        <div class="content-poster"><img src="{t['poster']}"/></div>
        <div class="grow" style="padding-bottom:6px">
          <div class="row gap-2" style="margin-bottom:4px">{world_chip(t['world'])}<span class="art-badge art-badge--live">{t['tag']}</span></div>
          <div class="t-h2 c-on-media">{t['title']}</div>
        </div>
      </div>
    </div>"""
    meta = f"""<div class="pad meta-row" style="padding-top:12px">
      {rating(t['rating'])}<span class="dot"></span><span>{t['year']}</span><span class="dot"></span><span>{t['type']}</span><span class="dot"></span><span>{t['eps']} eps</span><span class="dot"></span><span>{' · '.join(t['genres'])}</span>
    </div>"""
    actions = f"""<div class="pad row gap-3" style="padding-top:14px">
      {button('Watchlist','primary',ic='plus',cls='grow')}{button('Follow','secondary',ic='bell')}{button('','secondary',ic='share')}
    </div>"""
    tabs = f"""<div class="tab-scroll" style="margin-top:16px">
      <span class="tab {'tab--active' if tab=='Overview' else ''}">Overview</span>
      <span class="tab {'tab--active' if tab=='Episodes' else ''}">Episodes</span>
      <span class="tab {'tab--active' if tab=='Community' else ''}">Community</span>
      <span class="tab {'tab--active' if tab=='Cast' else ''}">Cast</span>
      <span class="tab {'tab--active' if tab=='Related' else ''}">Related</span>
    </div>"""
    synopsis = f"""<div class="section" style="padding-top:16px">
      <div class="pad"><div class="t-body c-secondary">{t['synopsis']}</div>
      <div class="row gap-2 mt-3">{world_chip(t['world'])}<span class="chip">{icon('tv',15)}{t['type']}</span></div></div>
    </div>"""
    community = f"""<div class="section">{section_header('Community activity','See all',icon_name='users')}
      <div class="pad row gap-3" style="margin-bottom:12px">
        <div class="row gap-2">{avatar_stack(['assets/img/avatar-01.jpg','assets/img/avatar-02.jpg','assets/img/avatar-03.jpg'])}<span class="t-caption c-secondary">2.4K fans discussing</span></div>
      </div>
      {post_card('minji', f"Rewatching {t['title']} and catching so much foreshadowing I missed the first time.", ctx={'world':t['world'],'title':t['title']}, likes='1.1K', comments='142')}
    </div>"""
    related = f"""<div class="section">{section_header('More like this')}
      <div class="shelf">{poster_card('neon',120)}{poster_card('midnight',120)}{poster_card('orbital',120)}</div></div>"""
    body = hero + meta + actions + tabs + synopsis + community + related + extra_section
    return body

screen("06-content-kdrama.html", "Content Hub — K-Drama",
       f'<div class="screen-body screen-scroll">{content_hub("cherry")}</div>' + tabbar("home"))
screen("06-content-anime.html", "Content Hub — Anime",
       f'<div class="screen-body screen-scroll">{content_hub("neon")}</div>' + tabbar("home"))
screen("06-content-anime-light.html", "Content Hub — Anime (Light)",
       f'<div class="screen-body screen-scroll">{content_hub("neon")}</div>' + tabbar("home"), theme="light")

# Hollywood movie (no episodes tab)
def content_hub_movie():
    t = TITLE_BY_ID["orbital"]
    body = content_hub("orbital")
    body = body.replace('<span class="tab ">Episodes</span>','').replace('<span class="tab">Episodes</span>','')
    return body
screen("06-content-hollywood-movie.html", "Content Hub — Movie",
       f'<div class="screen-body screen-scroll">{content_hub_movie()}</div>' + tabbar("home"))

# Episodes tab
def episodes_screen():
    t = TITLE_BY_ID["cherry"]
    eps = ""
    for i in range(1,6):
        eps += f"""<div class="list-row" style="align-items:flex-start">
          <div class="rank-thumb" style="width:96px;height:56px"><img src="{t['backdrop']}"/></div>
          <div class="grow"><div class="row between"><span class="t-card-title">{i}. {'The First Rain' if i==1 else 'Intersections' if i==2 else 'Slow Season' if i==3 else 'Confession' if i==4 else 'Cherry Blossom Season'}</span><span class="t-meta c-tertiary">{52+i*2}m</span></div>
          <div class="t-meta c-tertiary mt-1">Aired {'Mar '+str(4+i)} · {1.2+i*0.3:.1f}M views</div></div>
        </div>"""
    body = content_hub("cherry", tab="Episodes")
    # replace community section with episodes list
    body = body.split('<div class="section">'+section_header('Community activity','See all',icon_name='users'))[0]
    body += f'<div class="section">{section_header("Episodes","16 total")}<div class="list">{eps}</div></div>'
    return body
screen("06-content-episodes.html", "Content Hub — Episodes",
       f'<div class="screen-body screen-scroll">{episodes_screen()}</div>' + tabbar("home"))

# Discussion tab (community)
def discussion_screen():
    body = content_hub("neon", tab="Community")
    body = body.split('<div class="section">'+section_header('Community activity','See all',icon_name='users'))[0]
    body += f"""<div class="section">{section_header('Discussions','New post',icon_name='message')}
      {post_card('aiko','Unpopular opinion: the finale was perfect and the "rushed" complaint misses the point of the arc.', ctx=title_ctx('neon'), likes='3.2K', comments='890')}
      {post_card('devon','Theory: the blade remembers the *viewer* too. Reread the opening monologue.', ctx=title_ctx('neon'), spoiler=True, likes='1.4K', comments='220')}
    </div>"""
    return body
screen("06-content-discussion.html", "Content Hub — Discussion",
       f'<div class="screen-body screen-scroll">{discussion_screen()}</div>' + tabbar("home"))

# Cast
def cast_screen():
    people = [("aiko","Neon Blade"),("devon","Orbital"),("minji","Cherry Blossom Season"),("leo","Jade Empire")]
    cards = ""
    for h,role in people:
        u = USER_BY_HANDLE[h]
        cards += f"""<div class="pcard" style="width:120px"><div class="pcard__art" style="aspect-ratio:1"><img src="{u['avatar']}"/></div>
          <div class="pcard__title truncate">{u['name']}</div><div class="pcard__meta truncate">as {role.split()[0]}</div></div>"""
    body = content_hub("neon", tab="Cast")
    body = body.split('<div class="section">'+section_header('Community activity','See all',icon_name='users'))[0]
    body += f"""<div class="section">{section_header('Cast & Characters',more=None)}<div class="shelf">{cards}</div></div>"""
    return body
screen("06-content-cast.html", "Content Hub — Cast",
       f'<div class="screen-body screen-scroll">{cast_screen()}</div>' + tabbar("home"))

# =====================================================================
# 07 COMMUNITIES
# =====================================================================
def s_communities():
    rows = ""
    for c in COMMUNITIES[:6]:
        rows += f"""<div class="list-row">
          <span class="list-row__icon" style="background:{c['color']}22;color:{c['color']}">{icon(c['icon'],20)}</span>
          <div class="grow"><div class="list-row__title">{c['name']}</div><div class="list-row__sub">{c['members']} members</div></div>
          {follow_btn(c['joined'])}
        </div>"""
    disc = f"""{topbar(left='<span class="t-h1">Communities</span>', right=icon_btn("plus"))}
    <div class="screen-body" style="gap:12px">
      <div class="pad"><div class="searchbar">{icon("search")}<input placeholder="Find a community"/></div></div>
      <div class="chip-scroll">{chip('For you',True)}{chip('Trending')}{chip('Anime')}{chip('K-Drama')}{chip('Hollywood')}</div>
      <div class="section" style="padding-top:12px">{section_header('Recommended for you', more=None)}<div class="list">{rows}</div></div>
    </div>"""
    screen("07-comm-discover.html", "Communities — Discover", disc + tabbar("explore"))

    # Community detail
    c = COMMUNITIES[0]
    detail = f"""{topbar(left=back_btn(), right=icon_btn("more"))}
    <div class="screen-body screen-scroll">
      <div class="comm-cover"><img src="assets/img/backdrop-anime.jpg"/></div>
      <div class="pad" style="margin-top:-40px;position:relative;z-index:2">
        <div class="row gap-3" style="align-items:flex-end">
          <span style="width:72px;height:72px;border-radius:18px;background:{c['color']}22;color:{c['color']};display:flex;align-items:center;justify-content:center;border:3px solid var(--bg-canvas)">{icon(c['icon'],34)}</span>
          <div class="grow" style="padding-bottom:4px">{button('Joined','secondary',ic='check',size='sm')}</div>
        </div>
        <div class="t-h2 mt-3">{c['name']}</div>
        <div class="t-body-s c-secondary mt-1">{c['desc']}</div>
        <div class="row gap-5 mt-3">{stat('1.2M','Members')}{stat('14.2K','Posts today')}{stat('98%','Positive')}</div>
      </div>
      <div class="tab-scroll" style="margin-top:16px"><span class="tab tab--active">Popular</span><span class="tab">Latest</span><span class="tab">Media</span><span class="tab">About</span></div>
      <div class="section" style="padding-top:12px">
        <div class="pad"><span class="chip chip--selected">{icon('pin',14)} Pinned · Season 3 watch thread</span></div>
      </div>
      {post_card('aiko','Season 3 premiere thread is LIVE. Drop your first-episode theories below — spoilers behind the veil.', ctx=title_ctx('neon'), likes='2.8K', comments='1.2K')}
      {post_card('leo','Weekly edit challenge: best 15 seconds from any anime this season. Winner pinned.', likes='980', comments='340')}
    </div>"""
    screen("07-comm-detail.html", "Community — Detail", detail + tabbar("explore"))

    # Create community
    create = f"""{topbar(left=back_btn(), center='<span class="t-h3">Create community</span>')}
    <div class="screen-body pad" style="gap:16px;padding-top:8px">
      <div class="row gap-3"><span style="width:64px;height:64px;border-radius:16px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;color:var(--text-tertiary)">{icon("camera",24)}</span><span class="t-caption c-tertiary">Add cover & icon</span></div>
      <div class="field"><label class="label">Name</label><input class="input" placeholder="e.g. Psychological Anime"/></div>
      <div class="field"><label class="label">Description</label><textarea class="input textarea" placeholder="What is this community about?"></textarea></div>
      <div class="field"><label class="label">Primary world</label><div class="wrap gap-2">{world_chip('anime')}{world_chip('kdrama')}{world_chip('cdrama')}{world_chip('hollywood')}</div></div>
      <div class="list-row card card--pad" style="padding:16px"><div class="grow"><div class="list-row__title">Public community</div><div class="list-row__sub">Anyone can view and join</div></div><span class="switch switch--on"></span></div>
      <div style="margin-top:auto;padding-bottom:8px">{button('Create community','primary',cls='btn--block btn--lg')}</div>
    </div>"""
    screen("07-comm-create.html", "Community — Create", create)

    # Empty
    empty = f"""{topbar(left='<span class="t-h1">Communities</span>', right=icon_btn("plus"))}
    <div class="screen-body" style="justify-content:center">
      {empty_state('Find your people','Explore fandom communities and join the conversation.','Explore communities','users')}
    </div>"""
    screen("07-comm-empty.html", "Communities — Empty", empty + tabbar("explore"))

# =====================================================================
# 08 SOCIAL FEED
# =====================================================================
def s_feed():
    head = f"""{topbar(left=wordmark(19), right=f'<div class="row gap-1">{icon_btn("search")}{icon_btn("sliders")}</div>')}"""
    feed = head + post_card("minji","Episode 18 of Neon Blade rewired my brain. The score dropping out right before the reveal… I had to pause. 🎬", ctx=title_ctx("neon"), media="single", liked=True, saved=True, likes="4.8K", comments="612", saves="1.1K") \
        + post_card("devon","Hot take: Orbital is the best sci-fi film of the decade.", ctx=title_ctx("orbital"), likes="2.1K", comments="304") \
        + post_card("leo","Which should I start tonight?", poll=[{"t":"Jade Empire","pct":48,"win":True},{"t":"Rain City","pct":31},{"t":"Starlight Oath","pct":21}], likes="640", comments="212")
    screen("08-feed.html", "Feed", f'<div class="screen-body screen-scroll">{feed}</div>' + tabbar("home"))

    # Post detail
    detail = f"""{topbar(left=back_btn(), center='<span class="t-h3">Post</span>', right=icon_btn("more"))}
    <div class="screen-body screen-scroll">
      {post_card("minji","Episode 18 of Neon Blade rewired my brain. The score dropping out right before the reveal… I had to pause and breathe. 🎬", ctx=title_ctx("neon"), media="single", liked=True, likes="4.8K", comments="612", saves="1.1K")}
      <div class="pad" style="padding-top:16px"><div class="t-overline c-tertiary">612 comments</div></div>
      <div class="pad">
        <div class="comment">{avatar('assets/img/avatar-02.jpg','sm')}<div class="comment__body"><div class="comment__head"><span class="comment__name">Devon Reyes</span><span class="comment__time">· 1h</span></div><div class="comment__text">The sound design team deserves an award. That silence was louder than any explosion.</div><div class="comment__meta"><span>Reply</span><span>♥ 214</span></div></div></div>
        <div class="comment comment--reply">{avatar('assets/img/avatar-03.jpg','sm')}<div class="comment__body"><div class="comment__head"><span class="comment__name">Aiko Tanaka</span><span class="comment__time">· 48m</span></div><div class="comment__text">Exactly. Restraint is the whole thesis of the episode.</div><div class="comment__meta"><span>Reply</span><span>♥ 96</span></div></div></div>
        <div class="comment">{avatar('assets/img/avatar-04.jpg','sm')}<div class="comment__body"><div class="comment__head"><span class="comment__name">Leo Martins</span><span class="comment__time">· 20m</span></div><div class="comment__text">Marking this to rewatch tonight with headphones.</div><div class="comment__meta"><span>Reply</span><span>♥ 41</span></div></div></div>
      </div>
    </div>
    <div class="pad" style="padding:10px 16px;border-top:1px solid var(--border-subtle)"><div class="searchbar">{avatar('assets/img/avatar-01.jpg','sm')}<input placeholder="Add a comment…"/>{icon("send",20)}</div></div>"""
    screen("08-post-detail.html", "Post Detail", detail)

    # Post menu sheet
    menu = f"""{topbar(left=back_btn(), center='<span class="t-h3">Post</span>', right=icon_btn("more"))}
    <div class="screen-body screen-scroll">{post_card("devon","Hot take: Orbital is the best sci-fi film of the decade.", ctx=title_ctx("orbital"), likes="2.1K", comments="304")}</div>
    <div class="scrim"></div>
    {sheet('', f'''<div class="list">
      <div class="list-row">{icon("bookmark",20)}<div class="grow"><div class="list-row__title">Save post</div></div></div>
      <div class="list-row">{icon("link",20)}<div class="grow"><div class="list-row__title">Copy link</div></div></div>
      <div class="list-row">{icon("eye-off",20)}<div class="grow"><div class="list-row__title">Hide from feed</div></div></div>
      <div class="list-row">{icon("flag",20)}<div class="grow"><div class="list-row__title c-danger">Report post</div></div></div>
    </div>''')}"""
    screen("08-post-menu.html", "Post — Menu", menu)

    # Feed empty
    empty = head + f"""<div class="screen-body" style="justify-content:center">{empty_state('Start the conversation','Follow people and fandoms to fill your feed — or share what you’re watching.','Create post','edit')}</div>"""
    screen("08-feed-empty.html", "Feed — Empty", empty + tabbar("home"))

# =====================================================================
# 09 EXPLORE / SHORTS
# =====================================================================
def s_shorts():
    body = f"""<div class="screen-body">
      <div class="shorts"><img src="assets/img/backdrop-anime.jpg"/>
        <div class="shorts__grad"></div>
        <div class="content-hero__nav">{icon_btn("back","iconbtn--glass")}</div>
        <div class="shorts__meta">
          <div class="row gap-3">{avatar('assets/img/avatar-03.jpg','md','avatar--live')}<div><div class="t-card-title c-on-media">Aiko Tanaka {icon('verified',13,'verified')}</div><div class="t-caption c-on-media" style="opacity:.8">@aiko · Follow</div></div>{follow_btn()}</div>
          <div class="t-body-s c-on-media">The Neon Blade finale edit everyone asked for. Sound ON. 🎧</div>
          <div class="row gap-2">{world_chip('anime')}<span class="chip" style="background:rgba(5,5,10,0.5);color:#fff">{icon('play',14)} 0:42</span></div>
        </div>
        <div class="rail-actions">
          <div class="rail-action">{icon("heart-fill",30)}<span>18.2K</span></div>
          <div class="rail-action">{icon("comment-fill",30)}<span>1.4K</span></div>
          <div class="rail-action">{icon("bookmark-fill",30)}<span>3.9K</span></div>
          <div class="rail-action">{icon("share",30)}<span>Share</span></div>
        </div>
        <div class="shorts__progress"><i></i></div>
      </div>
    </div>"""
    screen("09-shorts.html", "Explore — Shorts", body)

    # Shorts with comments sheet
    body2 = f"""<div class="screen-body">
      <div class="shorts"><img src="assets/img/poster-anime-hero.jpg"/>
        <div class="shorts__grad"></div>
        <div class="content-hero__nav">{icon_btn("back","iconbtn--glass")}</div>
      </div>
      <div class="scrim"></div>
      {sheet('1,432 comments', f'''<div class="comment">{avatar('assets/img/avatar-02.jpg','sm')}<div class="comment__body"><div class="comment__head"><span class="comment__name">Devon Reyes</span><span class="comment__time">· 2h</span></div><div class="comment__text">This edit is unreal. What's the song?</div><div class="comment__meta"><span>Reply</span><span>♥ 210</span></div></div></div>
      <div class="comment">{avatar('assets/img/avatar-04.jpg','sm')}<div class="comment__body"><div class="comment__head"><span class="comment__name">Leo Martins</span><span class="comment__time">· 1h</span></div><div class="comment__text">Aiko never misses 🔥</div><div class="comment__meta"><span>Reply</span><span>♥ 88</span></div></div></div>''', footer='<div class="searchbar">'+avatar('assets/img/avatar-01.jpg','sm')+'<input placeholder="Add a comment…"/>'+icon("send",20)+'</div>')}"""
    screen("09-shorts-comments.html", "Explore — Shorts comments", body2)

# =====================================================================
# 10 CREATION
# =====================================================================
def s_create():
    # Create menu (sheet over home)
    home_bg = f"""<div class="screen-body screen-scroll"><div class="home-head">{wordmark()}<div class="row gap-1">{icon_btn("search")}{icon_btn("bell")}</div></div>
      <div class="pad"><div class="sk" style="height:190px;border-radius:18px"></div></div></div>"""
    menu = home_bg + '<div class="scrim"></div>' + sheet('Create', f'''<div class="create-grid">
      <div class="create-tile"><span class="create-tile__ic">{icon("edit",22)}</span><span class="create-tile__t">Post</span><span class="create-tile__d">Share a thought</span></div>
      <div class="create-tile"><span class="create-tile__ic">{icon("message",22)}</span><span class="create-tile__t">Discussion</span><span class="create-tile__d">Start a conversation</span></div>
      <div class="create-tile"><span class="create-tile__ic">{icon("sparkle",22)}</span><span class="create-tile__t">Recommendation</span><span class="create-tile__d">Suggest something</span></div>
      <div class="create-tile"><span class="create-tile__ic">{icon("poll",22)}</span><span class="create-tile__t">Poll</span><span class="create-tile__d">Ask the community</span></div>
      <div class="create-tile"><span class="create-tile__ic">{icon("image",22)}</span><span class="create-tile__t">Media</span><span class="create-tile__d">Photo or video</span></div>
      <div class="create-tile"><span class="create-tile__ic">{icon("video",22)}</span><span class="create-tile__t">Short</span><span class="create-tile__d">Vertical clip</span></div>
    </div>''')
    screen("10-create-menu.html", "Create — Menu", menu)

    # Create post composer
    composer = f"""{topbar(left='<span class="t-label c-brand">Cancel</span>', center='<span class="t-h3">New post</span>', right=button('Post','primary',size='sm'))}
    <div class="screen-body" style="gap:14px;padding-top:8px">
      <div class="pad row gap-3">{avatar('assets/img/avatar-01.jpg','md')}<div class="grow"><div class="t-card-title">You</div><div class="t-meta c-tertiary">Posting to your feed</div></div></div>
      <div class="pad"><textarea class="input textarea" style="min-height:140px" placeholder="What are you watching?">Rewatching Neon Blade before the finale and I keep noticing new details in the background art…</textarea></div>
      <div class="pad"><span class="chip chip--selected">{world_dot('anime')} Neon Blade {icon("close",14)}</span></div>
      <div class="pad row between" style="margin-top:auto;padding-bottom:8px">
        <div class="composer-tools">
          <span class="composer-tool">{icon("image",20)}</span><span class="composer-tool">{icon("video",20)}</span><span class="composer-tool">{icon("poll",20)}</span><span class="composer-tool">{icon("hash",20)}</span><span class="composer-tool">{icon("at",20)}</span>
        </div>
        <span class="t-caption c-tertiary">112 / 1000</span>
      </div>
      <div class="pad row gap-3" style="padding-bottom:12px">
        <span class="chip">{icon("users",15)} Add community</span>
        <span class="chip">{icon("eye-off",15)} Spoiler</span>
      </div>
    </div>"""
    screen("10-create-post.html", "Create — Post", composer)

    # Poll composer
    poll = f"""{topbar(left='<span class="t-label c-brand">Cancel</span>', center='<span class="t-h3">New poll</span>', right=button('Post','primary',size='sm'))}
    <div class="screen-body" style="gap:14px;padding-top:8px">
      <div class="pad"><textarea class="input textarea" style="min-height:90px" placeholder="Ask a question…">Which should I start tonight?</textarea></div>
      <div class="pad col gap-2">
        <input class="input" value="Jade Empire"/>
        <input class="input" value="Rain City"/>
        <input class="input" value="Starlight Oath"/>
        <button class="btn btn--ghost" style="justify-content:flex-start">{icon("plus",18)} Add option</button>
      </div>
      <div class="pad row gap-3"><span class="chip chip--selected">{icon("clock",15)} 24 hours</span><span class="chip">{icon("users",15)} Add community</span></div>
    </div>"""
    screen("10-create-poll.html", "Create — Poll", poll)

    # Attach content search
    attach = f"""{topbar(left=back_btn(), center='<span class="t-h3">Attach content</span>')}
    <div class="screen-body" style="gap:12px;padding-top:8px">
      <div class="pad"><div class="searchbar searchbar--focused">{icon("search")}<input value="neon" autofocus/></div></div>
      <div class="search-seg">{chip('All',True)}{chip('Movies')}{chip('Series')}{chip('Anime')}</div>
      <div class="list">
        <div class="list-row"><div class="rank-thumb" style="width:40px;height:56px"><img src="assets/img/poster-anime-hero.jpg"/></div><div class="grow"><div class="list-row__title">Neon Blade</div><div class="list-row__sub">Anime · 2025</div></div>{icon("plus",20)}</div>
        <div class="list-row"><div class="rank-thumb" style="width:40px;height:56px"><img src="assets/img/poster-kdrama-thriller.jpg"/></div><div class="grow"><div class="list-row__title">Midnight in Seoul</div><div class="list-row__sub">K-Drama · 2023</div></div>{icon("plus",20)}</div>
        <div class="list-row"><div class="rank-thumb" style="width:40px;height:56px"><img src="assets/img/poster-hollywood-scifi.jpg"/></div><div class="grow"><div class="list-row__title">Orbital</div><div class="list-row__sub">Movie · 2025</div></div>{icon("plus",20)}</div>
      </div>
    </div>"""
    screen("10-create-attach.html", "Create — Attach", attach)

    # Uploading
    upload = f"""{topbar(left='<span class="t-label c-brand">Cancel</span>', center='<span class="t-h3">Posting…</span>')}
    <div class="screen-body" style="gap:16px;padding-top:8px">
      <div class="pad"><div class="post__media" style="position:relative"><img src="assets/img/backdrop-anime.jpg"/>
        <div style="position:absolute;inset:0;background:rgba(5,5,10,0.5);display:flex;align-items:center;justify-content:center"><div class="progress-ring" style="--p:72"><span>72%</span></div></div></div></div>
      <div class="pad"><div class="t-card-title">Uploading media…</div><div class="t-meta c-tertiary mt-1">2 of 3 files · 4.2 MB / 5.8 MB</div></div>
      <div class="pad"><div class="progress"><i style="width:72%"></i></div></div>
    </div>"""
    screen("10-create-uploading.html", "Create — Uploading", upload)

    # Success
    success = f"""{topbar(left=icon_btn("close"))}
    <div class="screen-body" style="align-items:center;justify-content:center;gap:16px;text-align:center;padding:0 32px">
      <div style="width:88px;height:88px;border-radius:50%;background:var(--success-soft);display:flex;align-items:center;justify-content:center;color:var(--success)">{icon("check",44)}</div>
      <div class="t-h2">Posted!</div>
      <div class="t-body c-secondary">Your post is live in your feed and in Anime World.</div>
      <div class="row gap-3 mt-2">{button('View post','primary')}{button('Share','secondary',ic='share')}</div>
    </div>"""
    screen("10-create-success.html", "Create — Success", success)

# =====================================================================
# 11 PROFILES
# =====================================================================
def s_profiles():
    u = USER_BY_HANDLE["you"]
    own = f"""{topbar(left='<span class="t-h1">You</span>', right=f'<div class="row gap-1">{icon_btn("qr")}{icon_btn("settings")}</div>')}
    <div class="screen-body screen-scroll">
      <div class="profile-cover"><img src="assets/img/backdrop-anime.jpg"/></div>
      <div class="profile-head">
        <div class="row between" style="align-items:flex-end">
          {avatar(u['avatar'],'xl','avatar--ring')}
          {button('Edit profile','secondary',size='sm')}
        </div>
        <div class="t-h2 mt-3">{u['name']}</div>
        <div class="t-body-s c-tertiary">@you</div>
        <div class="t-body-s c-secondary mt-2">{u['bio']}</div>
        <div class="row gap-2 mt-3">{world_chip('anime')}{world_chip('kdrama')}{world_chip('hollywood')}</div>
        <div class="profile-stats mt-4">{stat('128','Followers')}{stat('96','Following')}{stat('34','Posts')}</div>
      </div>
      <div class="tab-scroll" style="margin-top:16px"><span class="tab tab--active">Posts</span><span class="tab">Media</span><span class="tab">Collections</span><span class="tab">Watchlist</span></div>
      <div class="section" style="padding-top:12px">{post_card('you','Finally caught up on Neon Blade. No spoilers but the last arc is a masterpiece.', ctx=title_ctx('neon'), likes='42', comments='6')}</div>
    </div>"""
    screen("11-profile-own.html", "Profile — Own", own + tabbar("you"))

    # Creator profile
    c = USER_BY_HANDLE["aiko"]
    creator = f"""{topbar(left=back_btn(), right=icon_btn("more"))}
    <div class="screen-body screen-scroll">
      <div class="profile-cover"><img src="assets/img/backdrop-anime.jpg"/></div>
      <div class="profile-head">
        <div class="row between" style="align-items:flex-end">
          {avatar(c['avatar'],'xl','avatar--ring')}
          <div class="row gap-2">{follow_btn()}{icon_btn("message","iconbtn--filled")}</div>
        </div>
        <div class="row gap-2 mt-3" style="align-items:center"><span class="t-h2">{c['name']}</span>{icon('verified',18,'verified')}<span class="tag tag--brand">Creator</span></div>
        <div class="t-body-s c-tertiary">@aiko</div>
        <div class="t-body-s c-secondary mt-2">{c['bio']}</div>
        <div class="row gap-2 mt-3">{world_chip('anime')}{world_chip('kdrama')}</div>
        <div class="profile-stats mt-4">{stat('48.9K','Followers')}{stat('540','Following')}{stat('1.2M','Likes')}</div>
      </div>
      <div class="tab-scroll" style="margin-top:16px"><span class="tab tab--active">Posts</span><span class="tab">Media</span><span class="tab">Reviews</span></div>
      <div class="section" style="padding-top:12px">
        {post_card('aiko','New edit drop for Starlight Oath — the summer festival scene, slowed down. Sound on. 🌟', ctx=title_ctx('starlight'), media='single', likes='9.2K', comments='1.4K')}
      </div>
    </div>"""
    screen("11-profile-creator.html", "Profile — Creator", creator)

    # Edit profile
    edit = f"""{topbar(left='<span class="t-label c-brand">Cancel</span>', center='<span class="t-h3">Edit profile</span>', right=button('Save','primary',size='sm'))}
    <div class="screen-body pad" style="gap:16px;padding-top:12px">
      <div class="col center gap-2">{avatar('assets/img/avatar-01.jpg','xl')}<span class="t-label c-brand">{icon("camera",16)} Change photo</span></div>
      <div class="field"><label class="label">Display name</label><input class="input" value="You"/></div>
      <div class="field"><label class="label">Handle</label><input class="input" value="you"/></div>
      <div class="field"><label class="label">Bio</label><textarea class="input textarea" style="min-height:90px">Building my Hallyu identity. Anime, K-Dramas, and a growing watchlist.</textarea><span class="help">128 / 160</span></div>
      <div class="field"><label class="label">My fandoms</label><div class="wrap gap-2">{world_chip('anime')}{world_chip('kdrama')}{world_chip('hollywood')}{chip('Add',ic='plus')}</div></div>
    </div>"""
    screen("11-profile-edit.html", "Profile — Edit", edit)

# =====================================================================
# 12 NOTIFICATIONS / ACTIVITY
# =====================================================================
def notif(icon_name, color, text, time, unread=False):
    return f"""<div class="notif {'notif--unread' if unread else ''}">
      <span class="notif__icon" style="background:{color}22;color:{color}">{icon(icon_name,18)}</span>
      <div class="grow"><div class="notif__text">{text}</div><div class="notif__time">{time}</div></div>
    </div>"""

def s_activity():
    body = f"""{topbar(left='<span class="t-h1">Activity</span>', right=button('Mark all read','ghost',size='sm'))}
    <div class="screen-body screen-scroll">
      <div class="pad"><div class="t-overline c-tertiary">New</div></div>
      {notif('heart-fill','#FF5C7A','<b>Min-ji Park</b> and <b>214 others</b> liked your post','12m',True)}
      {notif('comment-fill','#7B61FF','<b>Devon Reyes</b> replied: "The sound design team deserves an award."','48m',True)}
      {notif('user-fill','#3DD68C','<b>Aiko Tanaka</b> started following you','2h',True)}
      <div class="pad" style="padding-top:12px"><div class="t-overline c-tertiary">Earlier</div></div>
      {notif('users','#8B75FF','<b>Anime World</b> is trending — 14.2K posts today','5h')}
      {notif('at','#FFB74D','<b>Leo Martins</b> mentioned you in a discussion','Yesterday')}
      {notif('sparkles','#7B61FF','New episode of <b>Neon Blade</b> is out','Yesterday')}
    </div>"""
    screen("12-notifications.html", "Activity", body + tabbar("activity"))

    empty = f"""{topbar(left='<span class="t-h1">Activity</span>')}
    <div class="screen-body" style="justify-content:center">{empty_state('You’re all caught up','When people react to your posts or follow you, it shows up here.','Explore','bell')}</div>"""
    screen("12-notifications-empty.html", "Activity — Empty", empty + tabbar("activity"))

# =====================================================================
# 13 MESSAGES
# =====================================================================
def s_messages():
    rows = ""
    for h,msg,time,unread in [("aiko","that edit is going viral 🔥","2m",2),("devon","did you finish orbital?","1h",0),("leo","jade empire ep 22 broke me","3h",0),("minji","sending you the thread","Yesterday",0)]:
        u = USER_BY_HANDLE[h]
        badge = f'<span class="badge-count">{unread}</span>' if unread else f'<span class="t-meta c-tertiary">{time}</span>'
        rows += f"""<div class="chat-row">{avatar(u['avatar'],'lg')}<div class="grow"><div class="row between"><span class="t-card-title">{u['name']}</span>{badge}</div><div class="t-body-s c-tertiary truncate">{msg}</div></div></div>"""
    list_ = f"""{topbar(left='<span class="t-h1">Messages</span>', right=icon_btn("edit"))}
    <div class="screen-body" style="gap:8px">
      <div class="pad"><div class="searchbar">{icon("search")}<input placeholder="Search conversations"/></div></div>
      <div class="list">{rows}</div>
    </div>"""
    screen("13-messages-list.html", "Messages — List", list_ + tabbar("activity"))

    # Thread
    thread = f"""{topbar(left=back_btn(), center=f'<div class="row gap-2" style="justify-content:center">{avatar("assets/img/avatar-03.jpg","sm")}<span class="t-h3">Aiko Tanaka</span></div>', right=icon_btn("more"))}
    <div class="screen-body" style="display:flex;flex-direction:column;padding:12px 0">
      <div class="chat-day">Today</div>
      <div class="col gap-2 pad"><div class="bubble bubble--in">hey! did you see the finale yet??</div>
      <div class="bubble bubble--out">just finished. i need a minute 😭</div>
      <div class="bubble bubble--in">RIGHT. the last 10 minutes…</div>
      <div class="bubble bubble--in" style="padding:6px"><img src="assets/img/backdrop-anime.jpg" style="border-radius:12px;width:200px"/></div>
      <div class="bubble bubble--out">that edit is going viral 🔥</div></div>
    </div>
    <div class="pad" style="padding:10px 16px;border-top:1px solid var(--border-subtle)"><div class="searchbar">{icon("plus")}<input placeholder="Message…"/>{icon("image",20)}{icon("send",20)}</div></div>"""
    screen("13-message-thread.html", "Messages — Thread", thread)

# =====================================================================
# 14 WATCHLIST / SAVED
# =====================================================================
def s_watchlist():
    tabs = f"""<div class="tab-scroll">{''.join(f'<span class="tab {"tab--active" if x=="Watching" else ""}">{x}</span>' for x in ["Want","Watching","Completed","Dropped"])}</div>"""
    items = ""
    for tid,prog in [("neon",60),("cherry",100),("orbital",0),("jade",35)]:
        t = TITLE_BY_ID[tid]
        status = "Completed" if prog==100 else ("Watching" if prog>0 else "Want to watch")
        prog_html = f'<div class="progress" style="margin-top:8px"><i style="width:{prog}%"></i></div>' if prog>0 and prog<100 else ""
        items += f"""<div class="list-row"><div class="rank-thumb" style="width:52px;height:74px"><img src="{t['poster']}"/></div>
          <div class="grow"><div class="t-card-title">{t['title']}</div><div class="t-meta c-tertiary mt-1">{WORLDS[t['world']]['short']} · {t['type']} · {t['year']}</div>
          <div class="row gap-2 mt-2">{world_dot(t['world'])}<span class="t-caption {'c-success' if prog==100 else 'c-secondary'}">{status}{f' · {prog}%' if prog>0 and prog<100 else ''}</span></div>{prog_html}</div>
          {icon_btn("more")}</div>"""
    body = f"""{topbar(left='<span class="t-h1">Watchlist</span>', right=icon_btn("sliders"))}{tabs}<div class="list">{items}</div>"""
    screen("14-watchlist.html", "Watchlist", body + tabbar("you"))

    # Saved
    saved = f"""{topbar(left='<span class="t-h1">Saved</span>', right=icon_btn("sliders"))}
    <div class="tab-scroll"><span class="tab tab--active">Posts</span><span class="tab">Content</span><span class="tab">Communities</span></div>
    {post_card('devon','Hot take: Orbital is the best sci-fi film of the decade.', ctx=title_ctx('orbital'), saved=True, likes='2.1K', comments='304')}
    {post_card('aiko','New edit drop for Starlight Oath — the summer festival scene, slowed down.', ctx=title_ctx('starlight'), saved=True, likes='9.2K', comments='1.4K')}"""
    screen("14-saved.html", "Saved", saved + tabbar("you"))

# =====================================================================
# 15 SETTINGS
# =====================================================================
def setting_row(ic, title, sub="", right=None, danger=False):
    r = right if right is not None else icon("chevron-right",18)
    return f"""<div class="list-row"><span class="list-row__icon">{icon(ic,20)}</span><div class="grow"><div class="list-row__title {'c-danger' if danger else ''}">{title}</div>{f'<div class="list-row__sub">{sub}</div>' if sub else ''}</div><span class="c-tertiary">{r}</span></div>"""

def s_settings():
    body = f"""{topbar(left=back_btn(), center='<span class="t-h3">Settings</span>')}
    <div class="screen-body screen-scroll">
      <div class="settings-group"><div class="settings-group__label">Account</div>
        {setting_row('user','Profile','Name, handle, bio, avatar')}
        {setting_row('lock','Security','Password, 2FA, devices')}
        {setting_row('link','Connected accounts')}
      </div>
      <div class="settings-group"><div class="settings-group__label">Preferences</div>
        {setting_row('sparkle','My fandoms','Anime · K-Drama · Hollywood')}
        {setting_row('sliders','Content preferences')}
        {setting_row('moon','Appearance','Dark', right='<span class="switch switch--on"></span>')}
        {setting_row('translate','Language','English')}
      </div>
      <div class="settings-group"><div class="settings-group__label">Content</div>
        {setting_row('eye-off','Spoiler protection','Hide spoilers by default', right='<span class="switch switch--on"></span>')}
        {setting_row('alert','Muted topics')}
      </div>
      <div class="settings-group"><div class="settings-group__label">Notifications</div>
        {setting_row('bell','Push notifications', right='<span class="switch switch--on"></span>')}
        {setting_row('users','Community activity', right='<span class="switch"></span>')}
      </div>
      <div class="settings-group"><div class="settings-group__label">Support</div>
        {setting_row('info','Help & support')}
        {setting_row('flag','Report a problem')}
        {setting_row('sparkle','About Hallyu','v1.0.0')}
      </div>
      <div class="settings-group"><div class="settings-group__label c-danger">Danger zone</div>
        {setting_row('logout','Log out')}
        {setting_row('trash','Delete account', danger=True)}
      </div>
    </div>"""
    screen("15-settings.html", "Settings", body)

    # Appearance
    appear = f"""{topbar(left=back_btn(), center='<span class="t-h3">Appearance</span>')}
    <div class="screen-body pad" style="gap:16px;padding-top:12px">
      <div class="t-overline c-tertiary">Theme</div>
      <div class="row gap-3">
        <div class="card" style="flex:1;padding:12px;border-color:var(--brand)"><div style="height:70px;border-radius:10px;background:#0A0A12;border:1px solid #26263A"></div><div class="row between mt-2"><span class="t-label">Dark</span>{icon("check",18)}</div></div>
        <div class="card" style="flex:1;padding:12px"><div style="height:70px;border-radius:10px;background:#F6F6FA;border:1px solid #E7E7F0"></div><div class="row between mt-2"><span class="t-label">Light</span></div></div>
      </div>
      <div class="t-overline c-tertiary mt-2">Accent</div>
      <div class="row gap-3">{''.join(f'<span style="width:36px;height:36px;border-radius:50%;background:{c};border:{"2px solid var(--text-primary)" if c=="#7B61FF" else "none"}"></span>' for c in ["#7B61FF","#FF5C7A","#3DD68C","#FFB74D","#4DA3FF"])}</div>
      <div class="list-row card card--pad" style="padding:16px"><div class="grow"><div class="list-row__title">Reduce motion</div><div class="list-row__sub">Minimize animations</div></div><span class="switch"></span></div>
      <div class="list-row card card--pad" style="padding:16px"><div class="grow"><div class="list-row__title">True black</div><div class="list-row__sub">OLED-friendly canvas</div></div><span class="switch"></span></div>
    </div>"""
    screen("15-settings-appearance.html", "Settings — Appearance", appear)

# =====================================================================
# 16 GLOBAL STATES
# =====================================================================
def s_states():
    # Loading
    screen("16-states-loading.html", "States — Loading",
        f"""<div class="screen-body screen-scroll">{topbar(left=back_btn(), center="<span class='t-h3'>Loading</span>")}<div class="pad"><div class="sk" style="height:180px;border-radius:18px"></div></div>{skeleton_post()}{skeleton_post()}</div>""")
    # Empty
    screen("16-states-empty.html", "States — Empty",
        f'<div class="screen-body" style="justify-content:center">{empty_state("Nothing saved yet","Find something worth watching and add it to your list.","Explore","bookmark")}</div>')
    # Error
    screen("16-states-error.html", "States — Error",
        f"""<div class="screen-body" style="justify-content:center">{empty_state("Something went wrong","We couldn’t load this right now. Please try again.","Retry","refresh")}</div>""")
    # Offline
    offline = f"""<div class="screen-body" style="justify-content:center">
      <div class="state"><div class="state__art">{state_art('wifi-off')}</div>
      <div class="state__title">You're offline</div><div class="state__text">Showing cached content. Some things may be out of date.</div>
      <div class="state__actions"><button class="btn btn--secondary">{icon("refresh",18)} Retry</button></div></div></div>"""
    screen("16-states-offline.html", "States — Offline", offline)
    # Success
    success = f"""<div class="screen-body" style="justify-content:center">
      <div class="state"><div class="state__art" style="color:var(--success)">{state_art('check')}</div>
      <div class="state__title">Added to watchlist</div><div class="state__text">We'll let you know when new episodes drop.</div>
      <div class="state__actions"><button class="btn btn--primary">View watchlist</button></div></div></div>"""
    screen("16-states-success.html", "States — Success", success)
    # Toast
    toast_s = f"""<div class="screen-body screen-scroll">{topbar(left=wordmark(19), right=icon_btn('search'))}<div class="pad"><div class="sk" style="height:180px;border-radius:18px"></div></div>{skeleton_post()}</div>{toast('Post published to your feed')}"""
    screen("16-states-toast.html", "States — Toast", toast_s)
    # Dialog
    dialog_s = f"""<div class="screen-body screen-scroll">{topbar(left=back_btn(), center='<span class="t-h3">Settings</span>')}<div class="list">{setting_row('logout','Log out')}{setting_row('trash','Delete account',danger=True)}</div></div>{dialog('Log out of Hallyu?','You can sign back in anytime. Your watchlist and collections stay safe.','Log out','Cancel')}"""
    screen("16-states-dialog.html", "States — Dialog", dialog_s)
    # Sheet
    sheet_s = f"""<div class="screen-body screen-scroll">{topbar(left=back_btn(), center='<span class="t-h3">Neon Blade</span>')}<div class="pad"><div class="t-body c-secondary">Tap share to see the share sheet.</div></div></div><div class="scrim"></div>{sheet('Share', '<div class="list"><div class="list-row">'+icon('link',20)+'<div class="grow"><div class="list-row__title">Copy link</div></div></div><div class="list-row">'+icon('message',20)+'<div class="grow"><div class="list-row__title">Send in a message</div></div></div><div class="list-row">'+icon('external',20)+'<div class="grow"><div class="list-row__title">Share externally</div></div></div></div>')}"""
    screen("16-states-sheet.html", "States — Sheet", sheet_s)

# =====================================================================
# PAGES — design system, components, icons, navigation
# =====================================================================
def build_pages():
    # ---- Icons page ----
    from icons import icon_names
    cells = ""
    for n in icon_names():
        cells += f'<div class="ic-cell"><div class="ic-box">{icon(n,26)}</div><div class="ic-name">{n}</div></div>'
    icons_html = f"""<div class="doc">
      <div class="doc-head"><div class="doc-title">Iconography</div><div class="doc-sub">{len(icon_names())} icons · 24×24 · 1.8 stroke · currentColor · round caps</div></div>
      <div class="ic-grid">{cells}</div>
    </div>"""
    write(os.path.join(PAGES, "icons.html"), page("Hallyu — Icons", icons_html, extra_css=DOC_CSS, body_class="doc-body"))

    # ---- Design system page ----
    colors_dark = [("canvas","#0A0A12"),("surface-1","#14141F"),("surface-2","#1B1B28"),("surface-3","#232333"),
                   ("border-subtle","#232333"),("border-strong","#38384F"),("text-primary","#F5F5FA"),("text-secondary","#A9A9BE"),
                   ("text-tertiary","#74748C"),("brand","#7B61FF"),("brand-pressed","#5A3FD6"),("warm","#FFB74D"),
                   ("live","#FF5C7A"),("success","#3DD68C"),("warning","#FFC24B"),("danger","#FF6B6B"),("info","#4DA3FF")]
    world_colors = [("K-Drama","#FF6B8A"),("C-Drama","#3DD6C4"),("Anime","#8B75FF"),("Hollywood","#FFB74D")]
    def swatches(items):
        return "".join(f'<div class="sw"><div class="sw-chip" style="background:{hexv}"></div><div class="sw-name">{name}</div><div class="sw-hex">{hexv}</div></div>' for name,hexv in items)
    types = [("Display XL","44/48 · 800","t-display-xl"),("Display","30/36 · 800","t-display"),("H1","26/32 · 700","t-h1"),
             ("H2","22/28 · 700","t-h2"),("H3","19/25 · 600","t-h3"),("Section","17/23 · 700","t-section"),
             ("Card title","16/21 · 600","t-card-title"),("Body L","17/26 · 400","t-body-l"),("Body","15/22 · 400","t-body"),
             ("Body S","13.5/20 · 400","t-body-s"),("Caption","12/16 · 500","t-caption"),("Label","13/18 · 600","t-label"),
             ("Button","15/20 · 600","t-button"),("Meta","12/16 · 500","t-meta"),("Stat","20/24 · 700","t-stat"),("Overline","11/14 · 700","t-overline")]
    type_rows = "".join(f'<div class="ty-row"><div class="ty-meta">{name}<br/><span>{meta}</span></div><div class="{cls}">Where fandoms meet</div></div>' for name,meta,cls in types)
    spaces = [("1","4px"),("2","8px"),("3","12px"),("4","16px"),("5","20px"),("6","24px"),("8","32px"),("10","40px"),("12","48px"),("16","64px")]
    space_rows = "".join(f'<div class="sp-row"><span class="sp-lbl">{n} · {v}</span><span class="sp-bar" style="width:{v}"></span></div>' for n,v in spaces)
    radii = [("xs","6px"),("sm","10px"),("md","14px"),("lg","18px"),("xl","24px"),("2xl","30px"),("full","9999px")]
    radius_rows = "".join(f'<div class="rad-box" style="border-radius:{v}"><span>{n}<br/>{v}</span></div>' for n,v in radii)
    ds_html = f"""<div class="doc">
      <div class="doc-head"><div class="doc-title">Hallyu Design System</div><div class="doc-sub">Where Fandoms Meet · tokens v1.0 · dark primary + light theme</div></div>

      <h2 class="doc-h2">1 · Brand</h2>
      <div class="brand-row">
        <div class="brand-card" style="background:#0A0A12"><svg width="56" height="56" viewBox="0 0 512 512"><g fill="none" stroke="#7B61FF" stroke-width="30" stroke-linecap="round"><path d="M256 138 A118 118 0 0 1 374 256"/><path d="M374 256 A118 118 0 0 1 256 374"/><path d="M256 374 A118 118 0 0 1 138 256"/><path d="M138 256 A118 118 0 0 1 256 138"/></g><circle cx="256" cy="256" r="52" fill="#7B61FF"/><circle cx="256" cy="256" r="20" fill="#F5F5FA"/></svg><div><div style="font-weight:800;font-size:22px">Hallyu</div><div style="color:#A9A9BE;font-size:13px">Where fandoms meet.</div></div></div>
        <div class="brand-card" style="background:#14141F;border:1px solid #26263A"><div style="font-weight:700">The Signal</div><div style="color:#A9A9BE;font-size:13px;max-width:280px">One confident blue-violet. Restrained, premium, distinct from Netflix red, Spotify green and Twitch purple.</div></div>
      </div>

      <h2 class="doc-h2">2 · Color — Dark (primary)</h2>
      <div class="sw-grid">{swatches(colors_dark)}</div>
      <h2 class="doc-h2">3 · World accents (metadata signals)</h2>
      <div class="sw-grid">{swatches(world_colors)}</div>

      <h2 class="doc-h2">4 · Typography</h2>
      <div class="ty-list">{type_rows}</div>

      <h2 class="doc-h2">5 · Spacing (4pt base)</h2>
      <div class="sp-list">{space_rows}</div>

      <h2 class="doc-h2">6 · Radius</h2>
      <div class="rad-grid">{radius_rows}</div>

      <h2 class="doc-h2">7 · Elevation</h2>
      <div class="elev-grid">
        <div class="elev-box" style="box-shadow:0 1px 2px rgba(0,0,0,.35)">elev-1</div>
        <div class="elev-box" style="box-shadow:0 4px 12px rgba(0,0,0,.40)">elev-2</div>
        <div class="elev-box" style="box-shadow:0 10px 28px rgba(0,0,0,.50)">elev-3</div>
        <div class="elev-box" style="box-shadow:0 8px 24px rgba(123,97,255,.35)">brand glow</div>
      </div>

      <h2 class="doc-h2">8 · Motion</h2>
      <div class="motion-grid">
        <div class="motion-card"><b>instant</b> 90ms</div><div class="motion-card"><b>fast</b> 150ms</div>
        <div class="motion-card"><b>base</b> 220ms</div><div class="motion-card"><b>medium</b> 280ms</div>
        <div class="motion-card"><b>slow</b> 360ms</div><div class="motion-card"><b>spring</b> 0.34,1.56,0.64,1</div>
      </div>
    </div>"""
    write(os.path.join(PAGES, "design-system.html"), page("Hallyu — Design System", ds_html, extra_css=DOC_CSS, body_class="doc-body"))

    # ---- Components page ----
    comp = build_components_page()
    write(os.path.join(PAGES, "components.html"), page("Hallyu — Components", comp, extra_css=DOC_CSS, body_class="doc-body"))

    # ---- Navigation page ----
    nav = build_nav_page()
    write(os.path.join(PAGES, "navigation.html"), page("Hallyu — Navigation", nav, extra_css=DOC_CSS, body_class="doc-body"))

DOC_CSS = """<style>
body.doc-body { background:#07070C; color:#F5F5FA; padding:40px; }
.doc { max-width:1180px; margin:0 auto; }
.doc-head { margin-bottom:32px; }
.doc-title { font-size:34px; font-weight:800; letter-spacing:-0.02em; }
.doc-sub { color:#A9A9BE; margin-top:6px; }
.doc-h2 { font-size:20px; font-weight:700; margin:40px 0 16px; padding-bottom:10px; border-bottom:1px solid #26263A; }
.ic-grid { display:grid; grid-template-columns:repeat(8,1fr); gap:12px; }
.ic-cell { background:#14141F; border:1px solid #26263A; border-radius:14px; padding:16px 8px; text-align:center; }
.ic-box { color:#F5F5FA; display:flex; justify-content:center; margin-bottom:8px; }
.ic-name { font-size:11px; color:#A9A9BE; word-break:break-word; }
.sw-grid { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; }
.sw { background:#14141F; border:1px solid #26263A; border-radius:14px; overflow:hidden; }
.sw-chip { height:64px; }
.sw-name { font-size:12px; font-weight:600; padding:8px 10px 0; }
.sw-hex { font-size:11px; color:#74748C; padding:0 10px 10px; font-variant-numeric:tabular-nums; }
.ty-list { display:flex; flex-direction:column; gap:6px; }
.ty-row { display:grid; grid-template-columns:220px 1fr; gap:24px; align-items:baseline; padding:14px 0; border-bottom:1px solid #1B1B28; }
.ty-meta { font-size:12px; color:#A9A9BE; }
.ty-meta span { color:#74748C; }
.sp-list { display:flex; flex-direction:column; gap:10px; }
.sp-row { display:flex; align-items:center; gap:16px; }
.sp-lbl { width:120px; font-size:12px; color:#A9A9BE; }
.sp-bar { height:16px; background:#7B61FF; border-radius:4px; }
.rad-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:12px; }
.rad-box { height:90px; background:#14141F; border:1px solid #38384F; display:flex; align-items:center; justify-content:center; text-align:center; font-size:11px; color:#A9A9BE; }
.elev-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:20px; }
.elev-box { height:90px; background:#1B1B28; border-radius:14px; display:flex; align-items:center; justify-content:center; color:#A9A9BE; font-size:13px; }
.motion-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
.motion-card { background:#14141F; border:1px solid #26263A; border-radius:12px; padding:16px; font-size:13px; color:#A9A9BE; }
.motion-card b { color:#F5F5FA; display:block; margin-bottom:4px; }
.brand-row { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
.brand-card { border-radius:18px; padding:28px; display:flex; align-items:center; gap:20px; }
.comp-sec { margin-bottom:36px; }
.comp-sec h3 { font-size:15px; color:#A9A9BE; text-transform:uppercase; letter-spacing:0.08em; margin:0 0 16px; }
.comp-row { display:flex; flex-wrap:wrap; gap:16px; align-items:center; }
.comp-panel { background:#0E0E18; border:1px solid #1B1B28; border-radius:18px; padding:24px; }
.nav-map { display:flex; flex-direction:column; gap:20px; }
.nav-node { background:#14141F; border:1px solid #26263A; border-radius:14px; padding:14px 18px; display:inline-flex; gap:10px; align-items:center; }
.nav-arrow { color:#74748C; text-align:center; font-size:20px; }
.nav-cols { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; }
</style>"""


def build_components_page():
    def sec(title, inner):
        return f'<div class="comp-sec"><h3>{title}</h3><div class="comp-panel">{inner}</div></div>'
    buttons = '<div class="comp-row">' + "".join([
        button('Primary','primary'), button('Secondary','secondary'), button('Outline','outline'),
        button('Ghost','ghost'), button('Soft','soft'), button('Live','live'), button('Danger','danger'),
        button('With icon','primary',ic='plus'), button('Loading','primary',cls='',size=''),
        '<button class="btn btn--primary" data-state="loading">Loading</button>',
        '<button class="btn btn--secondary" data-state="disabled">Disabled</button>',
        '<button class="btn btn--primary" data-state="success">Saved</button>',
        button('Small','secondary',size='sm'), button('Large','primary',size='lg'),
    ]) + '</div>'
    iconbtns = '<div class="comp-row">' + "".join([
        icon_btn('search'), icon_btn('bell'), icon_btn('heart'), icon_btn('bookmark'), icon_btn('share'),
        icon_btn('more','iconbtn--filled'), icon_btn('plus','iconbtn--on'), icon_btn('bell','iconbtn--badge'),
    ]) + '</div>'
    avatars = '<div class="comp-row">' + "".join([
        avatar('assets/img/avatar-01.jpg','xs'), avatar('assets/img/avatar-02.jpg','sm'),
        avatar('assets/img/avatar-03.jpg','md'), avatar('assets/img/avatar-04.jpg','lg'),
        avatar('assets/img/avatar-01.jpg','xl','avatar--ring'), avatar('assets/img/avatar-02.jpg','lg','avatar--live','','avatar-status--live'),
        avatar_stack(['assets/img/avatar-01.jpg','assets/img/avatar-02.jpg','assets/img/avatar-03.jpg','assets/img/avatar-04.jpg']),
        avatar('','md','','MK'),
    ]) + '</div>'
    chips = '<div class="comp-row">' + "".join([
        chip('Default'), chip('Selected',True), chip('With icon',ic='plus'), chip('Outline',cls='chip--outline'),
        chip('Small',cls='chip--sm'), chip('Disabled',cls='chip--disabled'),
        world_chip('kdrama'), world_chip('cdrama'), world_chip('anime'), world_chip('hollywood'),
    ]) + '</div>'
    tabs = f'<div class="comp-row" style="gap:40px"><div class="segmented"><span class="seg seg--active">For You</span><span class="seg">Following</span><span class="seg">Trending</span></div><div class="tabs" style="border:0"><span class="tab tab--active">Posts</span><span class="tab">Media</span><span class="tab">Collections</span></div></div>'
    fields = f'<div class="comp-row" style="flex-direction:column;align-items:stretch;max-width:420px;gap:16px"><div class="field"><label class="label">Email</label><input class="input" placeholder="you@example.com"/></div><div class="field"><label class="label">With error</label><input class="input" data-state="error" value="bad@" /><span class="help help--error">Enter a valid email</span></div><div class="searchbar searchbar--focused">{icon("search")}<input value="neon blade"/></div></div>'
    controls = '<div class="comp-row">' + "".join([
        '<span class="switch switch--on"></span>','<span class="switch"></span>',
        '<span class="checkbox checkbox--on">'+icon('check',14)+'</span>','<span class="checkbox"></span>',
        '<span class="radio radio--on"></span>','<span class="radio"></span>',
        follow_btn(), follow_btn(True), rating('8.9'),
    ]) + '</div>'
    cards = f'<div class="comp-row">{poster_card("neon",132,badge=("#1","brand"),show_rank=None)}{poster_card("cherry",132,show_progress=60)}{poster_card("orbital",132,show_save=True)}{wide_card("neon",240,badge="LIVE")}</div>'
    reactions = '<div class="comp-row"><div class="reactions">' + "".join([
        '<span class="react react--on" data-react="love">'+icon('heart-fill',18)+'Love</span>',
        '<span class="react" data-react="cry">'+icon('comment',18)+'Cry</span>',
        '<span class="react react--on" data-react="hype">'+icon('flame',18)+'Hype</span>',
        '<span class="react">'+icon('sparkle',18)+'Shock</span>',
    ]) + '</div></div>'
    states = f'<div class="comp-row" style="align-items:stretch">{empty_state("Nothing here yet","Add something to see it here.","Explore","bookmark")}{toast("Saved to your watchlist","success")}</div>'
    skeleton = f'<div style="max-width:420px">{skeleton_post()}</div>'
    poll = f'<div style="max-width:420px"><div class="poll"><div class="poll__opt"><span class="fill fill--win" style="--pct:48%"></span><span class="lbl"><span>Jade Empire</span><span class="tnum c-secondary">48%</span></span></div><div class="poll__opt"><span class="fill" style="--pct:31%"></span><span class="lbl"><span>Rain City</span><span class="tnum c-secondary">31%</span></span></div></div></div>'
    spoiler = f'<div style="max-width:420px"><div class="spoiler"><div class="spoiler__veil">{icon("eye-off",22)}<span class="t-label">Spoiler · Episode 8</span><span class="t-caption">Tap to reveal</span></div></div></div>'
    return f"""<div class="doc">
      <div class="doc-head"><div class="doc-title">Component Library</div><div class="doc-sub">Every component with its interaction states · default / pressed / focused / selected / active / disabled / loading / success / error</div></div>
      {sec('Buttons', buttons)}
      {sec('Icon buttons', iconbtns)}
      {sec('Avatars & stacks', avatars)}
      {sec('Chips & world tags', chips)}
      {sec('Tabs & segmented controls', tabs)}
      {sec('Inputs & search', fields)}
      {sec('Controls', controls)}
      {sec('Cards & shelves', cards)}
      {sec('Reactions', reactions)}
      {sec('Poll & spoiler', poll + spoiler)}
      {sec('Skeleton loading', skeleton)}
      {sec('States & toast', states)}
    </div>"""


def build_nav_page():
    return f"""<div class="doc">
      <div class="doc-head"><div class="doc-title">Navigation</div><div class="doc-sub">Five-tab shell, stack, and modal navigation · entertainment ↔ fandom ↔ social</div></div>
      <h2 class="doc-h2">Primary shell (bottom navigation)</h2>
      <div class="comp-panel">{tabbar('home')}</div>
      <h2 class="doc-h2">The core loop</h2>
      <div class="nav-map">
        <div class="nav-node">{icon('compass',20)} Discover</div><div class="nav-arrow">↓</div>
        <div class="nav-node">{icon('play',20)} Experience</div><div class="nav-arrow">↓</div>
        <div class="nav-node">{icon('heart',20)} React</div><div class="nav-arrow">↓</div>
        <div class="nav-node">{icon('comment',20)} Discuss</div><div class="nav-arrow">↓</div>
        <div class="nav-node">{icon('user',20)} Follow</div><div class="nav-arrow">↓</div>
        <div class="nav-node">{icon('edit',20)} Create</div><div class="nav-arrow">↓</div>
        <div class="nav-node">{icon('sparkle',20)} Rediscover</div>
      </div>
      <h2 class="doc-h2">Stack routes</h2>
      <div class="nav-cols">
        <div class="nav-node">{icon('search',18)} Search</div><div class="nav-node">{icon('tv',18)} Content Hub</div><div class="nav-node">{icon('users',18)} Community</div>
        <div class="nav-node">{icon('message',18)} Post Detail</div><div class="nav-node">{icon('user',18)} Profile</div><div class="nav-node">{icon('sparkle',18)} Creator</div>
        <div class="nav-node">{icon('bookmark',18)} Watchlist</div><div class="nav-node">{icon('grid',18)} Collections</div><div class="nav-node">{icon('settings',18)} Settings</div>
      </div>
      <h2 class="doc-h2">Modal routes</h2>
      <div class="nav-cols">
        <div class="nav-node">{icon('edit',18)} Create</div><div class="nav-node">{icon('share',18)} Share</div><div class="nav-node">{icon('flag',18)} Report</div>
        <div class="nav-node">{icon('grid',18)} Collection</div><div class="nav-node">{icon('eye-off',18)} Spoiler</div><div class="nav-node">{icon('sliders',18)} Filters</div>
      </div>
    </div>"""


# =====================================================================
if __name__ == "__main__":
    print("Building Hallyu design screens…")
    s_brand(); s_onboarding(); s_home(); s_discover(); s_search()
    s_communities(); s_feed(); s_shorts(); s_create(); s_profiles()
    s_activity(); s_messages(); s_watchlist(); s_settings(); s_states()
    build_pages()
    print("Done.")
