"""Capture a README screenshot of the game running on a phone, on the real GPU.

Captures from the local build rather than the deployed site, so the shot can be
taken in the same commit that introduces the feature it is documenting.
"""

import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from serve import serve  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
DIST = ROOT / "dist"
W, H = 844, 390  # phone landscape

if not (DIST / "index.html").exists():
    print("dist/ not found - run `npm run build` first")
    sys.exit(2)

with serve(DIST) as URL, sync_playwright() as pw:
    b = pw.chromium.launch(
        channel="chrome", headless=False, args=["--hide-scrollbars", f"--window-size={W},{H + 140}"]
    )
    ctx = b.new_context(viewport={"width": W, "height": H}, has_touch=True, is_mobile=True, device_scale_factor=2)
    page = ctx.new_page()
    page.set_default_timeout(300_000)
    page.goto(URL + "?demo=1", wait_until="load")
    page.wait_for_function("() => !!window.NOCTIS", timeout=300_000, polling=500)

    # Start the race, then hold the throttle and a steering button so the
    # shot shows the controls in their pressed state, as a player would.
    page.evaluate("() => { const N = window.NOCTIS; N.director.startRace(); N.menu.showScreen('none'); }")
    page.wait_for_function("() => window.NOCTIS.director.state === 'race'", timeout=180_000, polling=300)
    print("  racing")

    cdp = ctx.new_cdp_session(page)
    cdp.send(
        "Input.dispatchTouchEvent",
        {
            "type": "touchStart",
            "touchPoints": [
                {"x": 52, "y": 346, "id": 0},   # steer left
                {"x": 673, "y": 339, "id": 1},  # throttle
            ],
        },
    )
    page.wait_for_timeout(2600)
    info = page.evaluate(
        """() => {
        const p = window.NOCTIS.director.player;
        return { speed: p.speedKmh, held: { ...window.NOCTIS.touch.held } };
    }"""
    )
    page.screenshot(path=str(DOCS / "mobile.png"))
    print(f"  mobile.png  ({info['speed']:.0f} km/h, controls held: {info['held']['throttle']}/{info['held']['left']})")
    b.close()

out = DOCS / "mobile.png"
print(f"    {out.name}  {out.stat().st_size // 1024} KB")
