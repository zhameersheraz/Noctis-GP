"""
Grab one HUD-free race frame for the banner.

The README body wants the HUD visible - it is part of the game. The hero
banner does not: under the title scrim the standings list and the progress
rail show through as faint ghosts, which reads as a rendering bug rather than
as game UI. So the banner gets its own clean frame.
"""

import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
URL = "https://zhameersheraz.github.io/Noctis-GP/"
W, H = 1600, 1000

with sync_playwright() as pw:
    b = pw.chromium.launch(
        channel="chrome", headless=False,
        args=["--hide-scrollbars", f"--window-size={W},{H + 120}"],
    )
    page = b.new_page(viewport={"width": W, "height": H})
    page.set_default_timeout(300_000)

    page.goto(URL + "?demo=1", wait_until="load")
    page.wait_for_function("() => !!window.NOCTIS", timeout=300_000, polling=500)
    page.evaluate("() => { const N = window.NOCTIS; N.director.startRace(); N.menu.showScreen('none'); }")
    page.wait_for_function("() => window.NOCTIS.director.state === 'race'", timeout=180_000, polling=300)
    print("  racing")

    best = []
    for i in range(18):
        page.wait_for_timeout(1400)
        info = page.evaluate(
            """() => {
            const p = window.NOCTIS.director.player;
            const n = window.NOCTIS.track.nearestS(p.pos.x, p.pos.z);
            let ahead = 0, nearest = 1e9;
            for (const c of window.NOCTIS.director.cars) {
                if (c === p) continue;
                const d = Math.hypot(c.pos.x - p.pos.x, c.pos.z - p.pos.z);
                nearest = Math.min(nearest, d);
                let ds = c.s - p.s; if (ds > n && ds < 4000) ahead++;
            }
            return { speed: p.speedKmh, onRoad: n.dist < n.frame.hw, ahead, nearest };
        }"""
        )
        page.screenshot(path=str(DOCS / f"clean-{i:02d}.png"))
        # A car filling the frame, or a name tag parked on the lens, both read
        # as bugs. Reward a clean line with a pack strung out ahead of it.
        spacing = min(info["nearest"], 60)
        best.append((spacing * 3 + info["ahead"] * 25 + info["speed"] * 0.25, info, f"clean-{i:02d}.png"))

    best.sort(reverse=True)
    score, info, name = best[0]
    (DOCS / name).replace(DOCS / "race-clean.png")
    for _, _, n in best[1:]:
        (DOCS / n).unlink(missing_ok=True)
    print(f"  race-clean.png  ({info['speed']:.0f} km/h, {info['ahead']} ahead, nearest car {info['nearest']:.0f} m)")

    # Same frame with all overlay UI removed: that is the banner source.
    #
    # updateHud({visible:false}) is not enough - the render loop calls
    # pushHud() every frame, which passes visible:true and takes the class
    # straight back off. A stylesheet with !important cannot be undone that
    # way. The Three.js name tags are not DOM at all, so they are hidden on
    # the objects themselves; syncMesh only touches their opacity, so a
    # visible=false here sticks.
    page.evaluate(
        """() => {
        const s = document.createElement('style');
        s.textContent = '.hud-layer{display:none !important}';
        document.head.appendChild(s);
        for (const c of window.NOCTIS.director.cars) {
            if (c.tag) c.tag.visible = false;
        }
    }"""
    )
    page.wait_for_timeout(2200)
    page.screenshot(path=str(DOCS / "banner-source.png"))
    print("  banner-source.png (HUD + name tags hidden)")
    b.close()

for p in sorted(DOCS.glob("*.png")):
    print(f"    {p.name}  {p.stat().st_size // 1024} KB")
