"""Hallyu UI kit — Python helpers that emit the coded HTML for every component.
The same functions power the component library page AND every screen, which is
what guarantees the PNG renders correspond to the coded design.
"""
from icons import icon
from mock import WORLDS, TITLES, TITLE_BY_ID, USERS, USER_BY_HANDLE, COMMUNITIES, title_ctx

# ----------------------------------------------------------------- page ----
def page(title, body, theme="dark", extra_css="", body_class=""):
    theme_attr = f' data-theme="{theme}"' if theme != "dark" else ""
    return f"""<!doctype html>
<html lang="en"{theme_attr}>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<base href="../"/>
<title>{title}</title>
<link rel="stylesheet" href="src/css/tokens.css"/>
<link rel="stylesheet" href="src/css/base.css"/>
<link rel="stylesheet" href="src/css/components.css"/>
<link rel="stylesheet" href="src/css/screens.css"/>
{extra_css}
</head>
<body class="{body_class}">
{body}
</body>
</html>"""


def device(content, cls="", theme="dark"):
    t = "" if theme == "dark" else f' data-theme="{theme}"'
    return f'<div class="device {cls}"{t}>{content}</div>'


def statusbar(time="9:41", dark=True):
    col = "" if dark else ' style="color:#14141F"'
    return f"""<div class="statusbar"{col}>
  <span class="tnum">{time}</span>
  <span class="sb-right">
    <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="7" width="3" height="5" rx="1"/><rect x="4.5" y="4.5" width="3" height="7.5" rx="1"/><rect x="9" y="2" width="3" height="10" rx="1"/><rect x="13.5" y="0" width="3" height="12" rx="1"/></svg>
    <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.2c2.2 0 4.2.8 5.7 2.1l1.3-1.4A10 10 0 0 0 8.5 0 10 10 0 0 0 1.5 2.9l1.3 1.4A8.4 8.4 0 0 1 8.5 2.2zM8.5 5.6c1.3 0 2.5.5 3.4 1.3l1.3-1.4A6.6 6.6 0 0 0 8.5 3.6a6.6 6.6 0 0 0-4.7 1.9l1.3 1.4A4.9 4.9 0 0 1 8.5 5.6zm0 3.4 2 2.1a2.8 2.8 0 0 0-4 0z"/></svg>
    <svg width="25" height="12" viewBox="0 0 25 12"><rect x="0.5" y="0.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" opacity="0.5"/><rect x="2" y="2" width="16" height="8" rx="1.5" fill="currentColor"/><rect x="22.5" y="4" width="1.8" height="4" rx="0.9" fill="currentColor" opacity="0.5"/></svg>
  </span>
</div>"""


def home_indicator():
    return '<div class="home-indicator"></div>'


def wordmark(size=21):
    return f"""<span class="wordmark" style="font-size:{size}px">
  <svg class="mark" width="22" height="22" viewBox="0 0 512 512"><g fill="none" stroke="#7B61FF" stroke-width="30" stroke-linecap="round"><path d="M256 138 A118 118 0 0 1 374 256"/><path d="M374 256 A118 118 0 0 1 256 374"/><path d="M256 374 A118 118 0 0 1 138 256"/><path d="M138 256 A118 118 0 0 1 256 138"/></g><circle cx="256" cy="256" r="52" fill="#7B61FF"/><circle cx="256" cy="256" r="20" fill="#F5F5FA"/></svg>
  <span>Hallyu</span>
</span>"""


# ------------------------------------------------------------- top bars ----
def topbar(left="", center="", right="", cls=""):
    return f'<div class="topbar {cls}">{left}<div class="grow center" style="display:flex">{center}</div>{right}</div>'


def back_btn():
    return f'<button class="iconbtn" aria-label="Back">{icon("back",24)}</button>'


def icon_btn(name, cls="", size=24, label=""):
    return f'<button class="iconbtn {cls}" aria-label="{label or name}">{icon(name,size)}</button>'


# ------------------------------------------------------------- tab bar -----
def tabbar(active="home", badge_activity=True):
    items = [("home","Home","home"),("explore","Explore","compass"),("create","Create","plus"),("activity","Activity","bell"),("you","You","user")]
    out = []
    for key,label,ic in items:
        if key == "create":
            out.append(f'<button class="navitem navitem--create" aria-label="Create"><span class="createbtn">{icon("plus",26)}</span></button>')
            continue
        is_a = key == active
        icon_name = ic + ("-fill" if (is_a and ic in ("home","compass","bell","user")) else "")
        badge = ''
        if key == "activity" and badge_activity:
            badge = '<span class="navitem__badge">3</span>'
        out.append(f'<button class="navitem {"navitem--active" if is_a else ""}" aria-label="{label}">{icon(icon_name,24)}{badge}<span class="navitem__label">{label}</span></button>')
    return f'<div class="tabbar">{"".join(out)}</div>'


# ------------------------------------------------------------- chips -------
def world_chip(world, label=None, cls=""):
    w = WORLDS[world]
    return f'<span class="chip chip--world {cls}" data-world="{world}">{icon(w["icon"],15)}{label or w["label"]}</span>'


def chip(label, selected=False, ic=None, cls=""):
    i = icon(ic,15) if ic else ""
    return f'<span class="chip {"chip--selected" if selected else ""} {cls}">{i}{label}</span>'


def world_dot(world):
    return f'<span class="world-dot" data-world="{world}"></span>'


# ------------------------------------------------------------- avatars -----
def avatar(src, size="md", cls="", initials="", status=""):
    st = f'<span class="avatar-status {status}"></span>' if status else ""
    if src:
        inner = f'<img src="{src}" alt=""/>'
    else:
        inner = initials
    return f'<span class="avatar avatar--{size} {cls}">{inner}{st}</span>'


def avatar_stack(srcs, size="sm"):
    return '<span class="avatar-stack">' + "".join(avatar(s,"sm" if size=="sm" else size) for s in srcs) + '</span>'


# ------------------------------------------------------------- cards -------
def poster_card(tid, width=132, show_rank=None, badge=None, show_progress=None, show_save=False):
    t = TITLE_BY_ID[tid] if isinstance(tid,str) else tid
    rank = f'<span class="pcard__rank tnum">{show_rank}</span>' if show_rank else ""
    b = ""
    if badge:
        cls = {"live":"art-badge--live","brand":"art-badge--brand","warm":"art-badge--warm"}.get(badge[1],"")
        b = f'<span class="art-badge {cls}">{badge[0]}</span>'
    save = f'<div class="art-actions">{icon_btn("bookmark","iconbtn--sm iconbtn--glass",18)}</div>' if show_save else ""
    prog = ""
    if show_progress is not None:
        prog = f'<div class="art-progress"><i style="width:{show_progress}%"></i></div>'
    return f"""<div class="pcard" style="width:{width}px">
  <div class="pcard__art"><img src="{t['poster']}" alt="{t['title']}"/>
    <div class="art-scrim"></div>{b}{rank}{save}{prog}</div>
  <div class="pcard__title truncate">{t['title']}</div>
  <div class="pcard__meta">{world_dot(t['world'])}<span>{t['year']}</span><span class="dot"></span><span>{t['type']}</span></div>
</div>"""


def wide_card(tid, width=240, badge=None):
    t = TITLE_BY_ID[tid] if isinstance(tid,str) else tid
    b = f'<span class="art-badge art-badge--live">{badge}</span>' if badge else ""
    return f"""<div class="wcard" style="width:{width}px">
  <div class="wcard__art"><img src="{t['backdrop']}" alt="{t['title']}"/><div class="art-scrim"></div>{b}
    <div style="position:absolute;left:10px;right:10px;bottom:8px">
      <div class="t-card-title c-on-media truncate">{t['title']}</div>
      <div class="t-meta c-on-media" style="opacity:.8">{WORLDS[t['world']]['short']} · {t['year']}</div>
    </div>
  </div>
</div>"""


def section_header(title, more="See all", icon_name=None, dot_world=None):
    ic = icon(icon_name,18) if icon_name else (world_dot(dot_world) if dot_world else "")
    m = f'<a class="section__more">{more}{icon("chevron-right",16)}</a>' if more else ""
    return f'<div class="section__head"><div class="section__title">{ic}{title}</div>{m}</div>'


# ------------------------------------------------------------- post --------
def post_card(user, body, ctx=None, media=None, likes="1.2K", comments="184", saves="96",
              liked=False, saved=False, spoiler=False, poll=None, verified_extra=""):
    u = USER_BY_HANDLE[user] if isinstance(user,str) else user
    ctx_html = ""
    if ctx:
        ctx_html = f'<span class="post__context">{world_dot(ctx["world"])}{WORLDS[ctx["world"]]["short"]} · {ctx["title"]}</span>'
    media_html = ""
    if media == "single":
        media_html = f'<div class="post__media"><img src="{IMG_MEDIA}" alt=""/></div>'
    elif media == "grid":
        media_html = f'<div class="post__media post__media--grid"><img src="{IMG_MEDIA}" alt=""/><img src="{IMG_MEDIA2}" alt=""/></div>'
    spoiler_html = ""
    if spoiler:
        spoiler_html = f"""<div class="spoiler"><div class="spoiler__veil">{icon("eye-off",22)}<span class="t-label">Spoiler · Episode 8</span><span class="t-caption">Tap to reveal</span></div></div>"""
    poll_html = ""
    if poll:
        opts = "".join(f'<div class="poll__opt {"poll__opt--selected" if o.get("sel") else ""}"><span class="fill {"fill--win" if o.get("win") else ""}" style="--pct:{o["pct"]}%"></span><span class="lbl"><span>{o["t"]}</span><span class="tnum c-secondary">{o["pct"]}%</span></span></div>' for o in poll)
        poll_html = f'<div class="poll">{opts}</div>'
    vbadge = f'<svg class="verified" viewBox="0 0 24 24">{icon("verified",14).split(">",1)[1]}' if u.get("verified") else ""
    return f"""<div class="post">
  <div class="post__head">
    {avatar(u['avatar'],'md')}
    <div class="who grow">
      <div class="post__name">{u['name']}{icon("verified",14,"verified") if u.get('verified') else ''}</div>
      <div class="post__sub">@{u['handle']}<span class="dot"></span>2h</div>
    </div>
    {icon_btn("more","iconbtn--sm")}
  </div>
  {ctx_html}
  <div class="post__body">{body}</div>
  {media_html}{spoiler_html}{poll_html}
  <div class="post__actions">
    <button class="paction {"paction--liked" if liked else ""}">{icon("heart-fill" if liked else "heart",20)}<span class="tnum">{likes}</span></button>
    <button class="paction">{icon("comment",20)}<span class="tnum">{comments}</span></button>
    <button class="paction {"paction--saved" if saved else ""}">{icon("bookmark-fill" if saved else "bookmark",20)}<span class="tnum">{saves}</span></button>
    <button class="paction">{icon("share",20)}</button>
  </div>
</div>"""


IMG_MEDIA = "assets/img/backdrop-anime.jpg"
IMG_MEDIA2 = "assets/img/backdrop-kdrama.jpg"


# ------------------------------------------------------------- states ------
def empty_state(title, text, action="Explore", icon_name="compass", art=True):
    art_html = f'<div class="state__art">{state_art(icon_name)}</div>' if art else ""
    return f"""<div class="state">{art_html}
  <div class="state__title">{title}</div>
  <div class="state__text">{text}</div>
  <div class="state__actions"><button class="btn btn--primary">{action}</button></div>
</div>"""


def state_art(icon_name):
    return f"""<svg viewBox="0 0 140 140" width="140" height="140">
  <circle cx="70" cy="70" r="52" fill="var(--surface-2)"/>
  <circle cx="70" cy="70" r="52" fill="none" stroke="var(--border-default)" stroke-width="1.5"/>
  <g transform="translate(46,46)" color="var(--brand)">{icon(icon_name,48)}</g>
</svg>"""


def skeleton_post():
    return f"""<div class="post">
  <div class="post__head">{avatar('','md','sk sk--circle')}<div class="grow col gap-2"><div class="sk sk--line" style="width:40%"></div><div class="sk sk--line" style="width:24%"></div></div></div>
  <div class="sk sk--text" style="width:92%"></div>
  <div class="sk sk--text" style="width:78%"></div>
  <div class="sk" style="width:100%;height:200px;border-radius:14px"></div>
</div>"""


def toast(text, kind="success"):
    ic = {"success":"check","error":"alert","info":"info"}[kind]
    return f'<div class="toast toast--{kind}"><span class="toast__icon">{icon(ic,18)}</span><span class="toast__text">{text}</span></div>'


def sheet(title, body, footer="", handle=True):
    h = '<div class="sheet__handle"></div>' if handle else ""
    f = f'<div class="sheet__foot">{footer}</div>' if footer else ""
    return f"""<div class="sheet">{h}
  <div class="sheet__head"><span class="sheet__title">{title}</span>{icon_btn("close")}</div>
  <div class="sheet__body">{body}</div>{f}
</div>"""


def dialog(title, text, confirm="Confirm", cancel="Cancel", danger=False):
    return f"""<div class="scrim"></div><div class="dialog">
  <div class="dialog__title">{title}</div><div class="dialog__text">{text}</div>
  <div class="dialog__actions">
    <button class="btn btn--secondary btn--block">{cancel}</button>
    <button class="btn {'btn--danger' if danger else 'btn--primary'} btn--block">{confirm}</button>
  </div>
</div>"""


# ------------------------------------------------------------- misc --------
def button(label, variant="primary", ic=None, cls="", size=""):
    i = icon(ic,18) if ic else ""
    return f'<button class="btn btn--{variant} {"btn--"+size if size else ""} {cls}">{i}{label}</button>'


def follow_btn(following=False, label=None):
    if following:
        return f'<button class="followbtn followbtn--following">{icon("check",16)}{label or "Following"}</button>'
    return f'<button class="followbtn">{icon("plus",16)}{label or "Follow"}</button>'


def stat(num, lbl):
    return f'<div class="stat"><span class="stat__num tnum">{num}</span><span class="stat__lbl">{lbl}</span></div>'


def rating(v):
    return f'<span class="rating">{icon("star-fill",14)}<span class="tnum">{v}</span></span>'
