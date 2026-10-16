"""Hallyu design — HTML -> PNG renderer.

Renders every coded screen (390x844 device frame) and every documentation page
to high-fidelity PNG references using headless Chromium (Playwright).

Usage:  python3 src/render.py            # render everything
        python3 src/render.py screens    # screens only
        python3 src/render.py pages      # doc pages only
"""
import os
import sys
import glob
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent          # .../design
OUT_SCREENS = ROOT / "renders" / "screens"
OUT_PAGES = ROOT / "renders" / "pages"
SCALE = 2          # deviceScaleFactor -> 780x1688 for a 390x844 frame


def render_screens(browser):
    OUT_SCREENS.mkdir(parents=True, exist_ok=True)
    files = sorted(glob.glob(str(ROOT / "screens" / "*.html")))
    print(f"Rendering {len(files)} screens ...")
    for f in files:
        name = Path(f).stem
        page = browser.new_page(viewport={"width": 390, "height": 844},
                                device_scale_factor=SCALE)
        page.goto("file://" + f)
        page.wait_for_timeout(220)
        el = page.query_selector(".device")
        out = OUT_SCREENS / f"{name}.png"
        if el:
            el.screenshot(path=str(out))
        else:
            page.screenshot(path=str(out), full_page=True)
        page.close()
        print(f"  -> renders/screens/{name}.png")


def render_pages(browser):
    OUT_PAGES.mkdir(parents=True, exist_ok=True)
    files = sorted(glob.glob(str(ROOT / "pages" / "*.html")))
    print(f"Rendering {len(files)} doc pages ...")
    for f in files:
        name = Path(f).stem
        page = browser.new_page(viewport={"width": 1440, "height": 1000},
                                device_scale_factor=1)
        page.goto("file://" + f)
        page.wait_for_timeout(300)
        out = OUT_PAGES / f"{name}.png"
        page.screenshot(path=str(out), full_page=True)
        page.close()
        print(f"  -> renders/pages/{name}.png")


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        if what in ("all", "screens"):
            render_screens(browser)
        if what in ("all", "pages"):
            render_pages(browser)
        browser.close()
    print("Done.")


if __name__ == "__main__":
    main()
