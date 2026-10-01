"""
Capture README artwork from the real game, on the real GPU.

Headless Chrome falls back to a CPU rasteriser, which means no bloom and no
shadows - fine for testing, poor for a README hero image. This launches a
normal Chrome window so the game renders with the actual GPU, then grabs the
states worth showing.

Auto-starts an AI-driven race (?race=1&demo=1) so the car is actually racing
rather than parked on the grid.
"""

import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
DOCS.mkdir(exist_ok=True)
URL = "https://zhameersheraz.github.io/Noctis-GP/"

W, H = 1600, 1000

print(f"\n=== capturing README artwork (real GPU) ===\n  {URL}\n")

with sync_playwright() as pw:
    b = pw.chromium.launch(
        channel="chrome",
        headless=False,  # real window => real GPU => bloom and shadows
        args=["--hide-scrollbars", "--window-position=0,0", f"--window-size={W},{H + 120}"],
    )
    page = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
    page.set_default_timeout(300_000)

    # ---- menu -------------------------------------------------------------
    page.goto(URL + "?demo=1", wait_until="load")  # autopilot, but stay on the menu
    page.wait_for_function("() => !!window.NOCTIS", timeout=300_000, polling=500)
    page.wait_for_timeout(9000)  # let the attract loop reach a good camera shot
    page.screenshot(path=str(DOCS / "menu.png"))
    print("  captured menu.png")

    # ---- everything else, on the SAME page load --------------------------
    # Reloading the page builds a second 1M vertex world in the same window
    # and Chrome was dropping the target. Start the race through the game's
    # own API instead, which is also closer to what a player does.
    page.evaluate(
        """() => {
        const N = window.NOCTIS;
        N.director.startRace();
        N.menu.showScreen('none');
        N.snapCamera();
    }"""
    )
    page.wait_for_function("() => window.NOCTIS.director.state === 'race'", timeout=180_000, polling=300)
    print("  race started, letting the AI settle into a pack")

    # Give the field time to string out, then grab a few frames to choose from.
    best = []
    for i in range(14):
        page.wait_for_timeout(1400)
        info = page.evaluate(
            """() => {
            const p = window.NOCTIS.director.player;
            const n = window.NOCTIS.track.nearestS(p.pos.x, p.pos.z);
            let ahead = 0;
            for (const c of window.NOCTIS.director.cars) {
                if (c !== p) { let d = c.s - p.s; if (d > n && d < 4000) ahead++; }
            }
            return { speed: p.speedKmh, onRoad: n.dist < n.frame.hw, ahead };
        }"""
        )
        name = f"race-{i:02d}.png"
        page.screenshot(path=str(DOCS / name))
        best.append((info["speed"] * (1 + 0.12 * info["ahead"]), info["onRoad"], name, info))

    best.sort(reverse=True)
    top = best[0]
    chosen = DOCS / top[2]
    chosen.rename(DOCS / "race.png")
    for _, _, name, _ in best[1:]:
        (DOCS / name).unlink(missing_ok=True)
    print(f"  captured race.png (from {top[2]}: {top[3]['speed']:.0f} km/h, {top[3]['ahead']} cars ahead)")

    # ---- results ----------------------------------------------------------
    page.evaluate(
        """() => {
        const d = window.NOCTIS.director, T = window.NOCTIS.track, TER = window.NOCTIS.terrain;
        const L = T.length;
        d.player.placeAt(T.frameAt(L - 25), L - 25, TER);
        d.player.lap = 2;
        d.player.cpIndex = T.checkpoints.length;
        d.player.lapTimes = [118.42, 117.06, 115.88];
        d.player.totalDist = L * 3 - 25;
        d.cars.forEach((c, i) => { c.lap = 3; c.finished = false; c.totalDist = L * 3 - 25 - i * 40; });
    }"""
    )
    page.wait_for_function("() => window.NOCTIS.director.state === 'results'", timeout=180_000, polling=500)
    page.wait_for_timeout(4000)  # crossfade
    page.screenshot(path=str(DOCS / "results.png"))
    print("  captured results.png")

    b.close()

print("\n  done:")
for p in sorted(DOCS.glob("*.png")):
    print(f"    {p.name}  {p.stat().st_size // 1024} KB")
print()
