"""
End-to-end check against the DEPLOYED GitHub Pages site, not a local build.

    python tools/live-check.py

Proves the thing a visitor would actually get: the real HTTPS URL, real CDN
assets, and the game running from it.
"""

import pathlib
import sys

from playwright.sync_api import sync_playwright

URL = "https://zhameersheraz.github.io/Noctis-GP/"
OUT = pathlib.Path(__file__).resolve().parent.parent / "playtest"
OUT.mkdir(exist_ok=True)

failures = []


def check(label, ok, detail=""):
    if not ok:
        failures.append(label)
    print(f"  {'PASS' if ok else 'FAIL'}  {label:<40} {detail}")


print(f"\n=== live site check: {URL} ===\n")

with sync_playwright() as pw:
    b = pw.chromium.launch(
        channel="chrome", headless=True,
        args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    )
    page = b.new_page(viewport={"width": 1280, "height": 800})
    page.set_default_timeout(300_000)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    resp = page.goto(URL, wait_until="load")
    check("site responds 200", resp is not None and resp.ok, f"HTTP {resp.status if resp else '?'}")

    page.wait_for_function("() => !!window.NOCTIS", timeout=300_000, polling=500)
    check("game boots from the live URL", True, "window.NOCTIS ready")

    check("title is correct", "NOCTIS GP" in page.title(), page.title())
    check("author meta present",
          page.evaluate("() => document.querySelector('meta[name=author]')?.content") == "zham",
          page.evaluate("() => document.querySelector('meta[name=author]')?.content"))

    page.wait_for_timeout(3000)
    page.evaluate("() => window.NOCTIS.stepSim(240)")
    page.wait_for_timeout(1500)

    moving = page.evaluate("() => window.NOCTIS.director.cars[0].speedKmh")
    check("attract loop is running", moving > 20, f"pack leader at {moving:.0f} km/h")

    check("menu is up", page.locator(".screen-main.active").count() == 1, "main screen active")
    credit = page.evaluate("() => document.querySelector('.credit')?.textContent ?? ''")
    check("zham credit is live", "zham" in credit, repr(credit))

    page.screenshot(path=str(OUT / "13-live.png"))
    from PIL import Image
    im = Image.open(OUT / "13-live.png").convert("RGB").resize((160, 100))
    lumas = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in im.getdata()]
    mean = sum(lumas) / len(lumas)
    lit = sum(1 for v in lumas if v > 12) / len(lumas)
    check("scene renders on the live site", lit > 0.05 and mean > 3, f"{lit*100:.0f}% lit, mean luma {mean:.1f}")

    # Start a real race and confirm the HUD goes live. Hold the throttle:
    # stepSim reads the live key state, so with nothing held the car simply
    # coasts away from the grid.
    page.keyboard.press("Enter")
    page.wait_for_timeout(1200)
    page.keyboard.down("KeyW")
    page.evaluate("() => window.NOCTIS.stepSim(420)")
    page.evaluate("() => window.NOCTIS.snapCamera()")
    page.wait_for_timeout(1500)
    speed = page.evaluate("() => window.NOCTIS.director.player.speedKmh")
    onroad = page.evaluate(
        """() => {
        const p = window.NOCTIS.director.player;
        const n = window.NOCTIS.track.nearestS(p.pos.x, p.pos.z);
        return { dist: n.dist, hw: n.frame.hw, state: window.NOCTIS.director.state };
    }"""
    )
    check(
        "race is playable on the live site",
        speed > 40 and onroad["dist"] < onroad["hw"] + 6,
        f"{speed:.0f} km/h, {onroad['dist']:.1f} m off centreline, state {onroad['state']}",
    )
    page.screenshot(path=str(OUT / "14-live-race.png"))

    real = [e for e in errors if "favicon" not in e.lower()]
    check("no console errors live", not real, "; ".join(real[:2]) if real else "clean")
    b.close()

print(f"\n{'LIVE SITE VERIFIED' if not failures else str(len(failures)) + ' CHECK(S) FAILED'}")
for f in failures:
    print(f"  - {f}")
print()
sys.exit(0 if not failures else 1)
