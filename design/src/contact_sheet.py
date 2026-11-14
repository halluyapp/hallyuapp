"""Compose contact sheets from the rendered PNG references.

Produces:
  renders/contact-sheet-all.png          (every screen, labelled)
  renders/contact-sheets/<section>.png   (one sheet per product area)
"""
import glob
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "renders" / "screens"
OUT = ROOT / "renders"
SHEETS = OUT / "contact-sheets"

THUMB_W = 300
PAD = 26
LABEL_H = 40
COLS = 6
BG = (14, 14, 24)
LABEL_BG = (22, 22, 36)
FG = (210, 210, 225)
ACCENT = (123, 97, 255)


def _font(size):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def _load(path):
    im = Image.open(path).convert("RGB")
    h = int(im.height * (THUMB_W / im.width))
    return im.resize((THUMB_W, h), Image.LANCZOS)


def make_sheet(files, out_path, title):
    thumbs = [(_load(f), Path(f).stem) for f in files]
    th = thumbs[0][0].height
    cols = min(COLS, len(thumbs))
    rows = (len(thumbs) + cols - 1) // cols
    title_h = 64
    W = PAD + cols * (THUMB_W + PAD)
    H = title_h + PAD + rows * (th + LABEL_H + PAD)
    sheet = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    d.text((PAD, 20), title, font=_font(30), fill=(240, 240, 250))
    d.line([(PAD, 58), (W - PAD, 58)], fill=ACCENT, width=2)
    for i, (im, name) in enumerate(thumbs):
        c, r = i % cols, i // cols
        x = PAD + c * (THUMB_W + PAD)
        y = title_h + PAD + r * (th + LABEL_H + PAD)
        sheet.paste(im, (x, y))
        d.rectangle([x, y + th, x + THUMB_W, y + th + LABEL_H], fill=LABEL_BG)
        d.text((x + 10, y + th + 11), name, font=_font(15), fill=FG)
    sheet.save(out_path)
    print("  wrote", out_path.relative_to(ROOT), f"({len(thumbs)} screens)")


def main():
    SHEETS.mkdir(parents=True, exist_ok=True)
    files = sorted(glob.glob(str(SRC / "*.png")))
    if not files:
        print("No renders found. Run render.py first.")
        return

    # master sheet (chunked so it stays readable)
    for i in range(0, len(files), 30):
        chunk = files[i:i + 30]
        make_sheet(chunk, OUT / f"contact-sheet-all-{i//30+1}.png",
                   f"Hallyu — All Screens ({i+1}-{i+len(chunk)} of {len(files)})")

    # per-section sheets
    sections = {}
    for f in files:
        key = Path(f).stem.split("-")[0]
        sections.setdefault(key, []).append(f)
    titles = {
        "01": "01 · Brand / App Entry", "02": "02 · Onboarding", "03": "03 · Home",
        "04": "04 · Discover", "05": "05 · Search", "06": "06 · Content Hub",
        "07": "07 · Fandoms / Communities", "08": "08 · Social Feed",
        "09": "09 · Explore / Short-form", "10": "10 · Creation",
        "11": "11 · Profiles", "12": "12 · Notifications", "13": "13 · Messages",
        "14": "14 · Watchlist / Saved", "15": "15 · Settings", "16": "16 · Global States",
    }
    for key, fs in sorted(sections.items()):
        make_sheet(fs, SHEETS / f"{key}.png", titles.get(key, key))
    print("Done.")


if __name__ == "__main__":
    main()
