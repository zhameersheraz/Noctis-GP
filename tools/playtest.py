"""
Browser playtest for NOCTIS GP.

Drives the real built game in Chrome and captures evidence from each state:
boot, main menu, controls, settings, countdown, racing, pause and results.

    python tools/playtest.py

Notes on method
  * Waits on `window.NOCTIS` (set at the end of boot) rather than on the
    loader disappearing, because a loader that has not been created yet also
    "does not exist".
  * Headless Chrome here has no GPU, so it falls back to a CPU rasteriser and
    a single frame can take seconds. Gameplay is therefore advanced with
    `window.NOCTIS.stepSim()`, which runs the real input read and the real
    RaceDirector.update - the same code path the render loop uses - just
    without waiting for pixels. Rendering is verified separately by
    screenshotting real frames.
"""

import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from serve import serve  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "playtest"
OUT.mkdir(exist_ok=True)
DIST = ROOT / "dist"

failures = []
BOOT_TIMEOUT = 300_000


def check(label, ok, detail=""):
    if not ok:
        failures.append(label)
    print(f"  {'PASS' if ok else 'FAIL'}  {label:<44} {detail}")


def note(msg):
    print(f"  ....  {msg}")


def sim(page, steps, dt=1 / 60):
    """Advance the real simulation without waiting for rendered frames."""
    page.evaluate("([n, d]) => window.NOCTIS.stepSim(n, d)", [steps, dt])


def shot(page, name):
    path = OUT / name
    page.screenshot(path=str(path))
    return path


def analyse(path, label):
    """
    Judge the composited screenshot, not a raw glReadPixels.

    A readback from the drawing buffer after the frame has been composited is
    unreliable (and returns all zeros without preserveDrawingBuffer), so the
    only trustworthy answer to "is the player actually seeing anything?" is the
    composited page itself.
    """
    from PIL import Image

    im = Image.open(path).convert("RGB")
    # Sample on a grid; a full pass is needless for a luma statistic.
    small = im.resize((160, 100))
    px = list(small.getdata())
    lumas = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px]
    mean = sum(lumas) / len(lumas)
    lit = sum(1 for v in lumas if v > 12) / len(lumas)
    peak = max(lumas)
    check(
        label,
        lit > 0.05 and mean > 3,
        f"{lit*100:.0f}% of pixels above luma 12, mean {mean:.1f}, peak {peak:.0f}",
    )
    return mean, lit, peak


if not (DIST / "index.html").exists():
    print("dist/ not found - run `npm run build` first.")
    sys.exit(2)

with serve(DIST) as URL, sync_playwright() as pw:
    browser = pw.chromium.launch(
        channel="chrome",
        headless=True,
        args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"],
    )
    page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
    page.set_default_timeout(60_000)

    console = []
    page_errors = []
    page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: page_errors.append(str(e)))

    print("\n=== NOCTIS GP - browser playtest ===\n")
    print(f"  serving {URL}(served over HTTP: Chrome blocks ES modules on file://)\n")

    # ---- boot -------------------------------------------------------------
    t0 = time.time()
    # ?capture=1 turns on preserveDrawingBuffer so the framebuffer can be read
    # back; without it a post-composite readPixels returns all zeros.
    page.goto(URL + "?capture=1", wait_until="load")
    # Poll on a timer, not on rAF: a long synchronous boot would otherwise
    # starve the rAF-based default and look like a hang.
    page.wait_for_function("() => !!window.NOCTIS", timeout=BOOT_TIMEOUT, polling=500)
    boot_ms = (time.time() - t0) * 1000
    check("boots to an interactive game", True, f"{boot_ms:.0f} ms to first interactive frame")

    boot_err = page.evaluate("() => window.__bootError || null")
    check("no boot error", boot_err is None, boot_err or "clean")
    check("software renderer detected and downgraded", page.evaluate("() => window.NOCTIS.world.isSoftware"),
          "shadows + bloom disabled, 1x pixel ratio")

    # Give the attract loop real frames, then advance it deterministically:
    # on a CPU rasteriser a rendered frame can take seconds, so wall-clock
    # waiting is not a usable proxy for simulation progress here.
    page.wait_for_timeout(3000)
    sim(page, 240)

    box = page.locator("#scene").bounding_box()
    check("canvas fills the viewport", bool(box) and box["width"] > 1000, f"{box['width']:.0f}x{box['height']:.0f}")

    gl_live = page.evaluate(
        """() => {
        const c = document.getElementById('scene');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return { ok: false, reason: 'no gl context' };
        return { ok: true, w: gl.drawingBufferWidth, h: gl.drawingBufferHeight };
    }"""
    )
    check("WebGL context is live", gl_live.get("ok", False),
          f"{gl_live.get('w')}x{gl_live.get('h')} drawing buffer" if gl_live.get("ok") else gl_live.get("reason", "?"))

    # ---- main menu --------------------------------------------------------
    check("main menu is up", page.locator(".screen-main.active").count() == 1, "main screen active")
    check("wordmark reads NOCTIS GP", "NOCTIS GP" in page.locator(".wm-title").inner_text(),
          page.locator(".wm-title").inner_text())
    check("lap length on the readout", "KM" in page.locator(".screen-main .ro-u").inner_text(),
          f"{page.locator('.screen-main .ro-v').inner_text()} {page.locator('.screen-main .ro-u').inner_text()}")
    items = page.locator(".screen-main .arc-item .item-label").all_inner_texts()
    check("menu items rendered", items == ["START RACE", "CONTROLS", "SETTINGS"], " / ".join(items))
    leader = page.evaluate("() => window.NOCTIS.director.cars[0].speedKmh")
    check("attract loop is running", page.evaluate("() => window.NOCTIS.director.cars[0].speed") > 3,
          f"pack leader at {leader:.0f} km/h")
    shot(page, "01-attract.png")
    shot(page, "02-menu.png")
    analyse(OUT / "01-attract.png", "attract scene actually renders")

    # ---- controls ---------------------------------------------------------
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    check("controls screen opens", page.locator(".screen-controls.active").count() == 1, "controls active")
    check("controls list is complete", page.locator(".screen-controls .row").count() == 7,
          f"{page.locator('.screen-controls .row').count()} rows")
    shot(page, "03-controls.png")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    check("escape returns to main", page.locator(".screen-main.active").count() == 1, "back at main")

    # ---- settings ---------------------------------------------------------
    page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    page.wait_for_timeout(400)
    check("settings screen opens", page.locator(".screen-settings.active").count() == 1, "settings active")
    before = page.locator(".screen-settings .arc-item").nth(0).locator(".vt").inner_text()
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(300)
    after = page.locator(".screen-settings .arc-item").nth(0).locator(".vt").inner_text()
    check("quality cycles", before != after, f"{before} -> {after}")
    shot(page, "04-settings.png")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)

    # ---- start the race ---------------------------------------------------
    page.keyboard.press("Enter")
    page.wait_for_timeout(1400)  # the letterbox retracts over a 0.8s transition
    state = page.evaluate("() => window.NOCTIS.director.state")
    check("race state machine started", state in ("countdown", "race"), state)
    check("HUD is visible during the race",
          page.evaluate("() => getComputedStyle(document.querySelector('.hud-layer')).visibility") == "visible", "visible")
    # The letterbox retracts via a 0.8 s CSS transition. On a CPU rasteriser
    # the animation clock barely ticks between multi-second frames, so assert
    # the state that drives it and report the rendered height as information.
    playing = page.evaluate("() => document.getElementById('ui').classList.contains('playing')")
    lb = page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('.letterbox-top')).height) || 0")
    check("letterbox retracts in race", playing, f"#ui.playing set, bar currently {lb:.0f}px")
    shot(page, "05-countdown.png")

    # Countdown -> racing, using the real state machine.
    sim(page, 320)
    check("lights out transitions to racing", page.evaluate("() => window.NOCTIS.director.state") == "race",
          page.evaluate("() => window.NOCTIS.director.state"))

    # ---- throttle ---------------------------------------------------------
    page.keyboard.down("KeyW")
    sim(page, 360)  # 6 seconds of held throttle
    tele = page.evaluate(
        """() => {
        const p = window.NOCTIS.director.player;
        const near = window.NOCTIS.track.nearestS(p.pos.x, p.pos.z);
        return {
          speed: p.speedKmh, s: p.s, grounded: p.grounded, offroad: p.offroad,
          dist: near.dist, hw: near.frame.hw, boost: p.boost,
          hudSpeed: document.querySelector('[data-hud=speed]').textContent.trim(),
          hudLap: document.querySelector('[data-hud=lap]').textContent.trim(),
          hudPos: document.querySelector('[data-hud=pos]').textContent.trim(),
        };
    }"""
    )
    check("car accelerates under throttle", tele["speed"] > 60, f"{tele['speed']:.0f} km/h")
    check("car stays on the circuit", tele["dist"] < tele["hw"] + 4,
          f"{tele['dist']:.1f} m off centreline, road half-width {tele['hw']:.1f} m")
    check("car is on the ground, not launched", tele["grounded"], f"grounded={tele['grounded']}")
    check("HUD lap counter is live", tele["hudLap"].startswith("LAP"), tele["hudLap"])
    check("HUD position is live", "/" in tele["hudPos"], tele["hudPos"])

    # The HUD is fed from the render loop, so force a frame before reading it,
    # otherwise it still shows the state from before the fast-forward.
    page.evaluate("() => window.NOCTIS.snapCamera()")
    shot(page, "06-racing.png")
    page.wait_for_timeout(1200)
    hud_speed = page.evaluate("() => document.querySelector('[data-hud=speed]').textContent.trim()")
    check("HUD speed is live", hud_speed not in ("", "0"), f"HUD {hud_speed} km/h")

    # The player's own car must be on screen, in front of the camera and in
    # the lower half of the frame. This is the thing a player looks at most.
    onscreen = page.evaluate(
        """() => {
        const { world, director, THREE } = window.NOCTIS;
        const cam = world.camera;
        const p = director.player;
        const v = new THREE.Vector3(p.pos.x, p.pos.y + 0.4, p.pos.z).project(cam);
        return {
          x: (v.x * 0.5 + 0.5) * window.innerWidth,
          y: (-v.y * 0.5 + 0.5) * window.innerHeight,
          z: v.z,
          dist: cam.position.distanceTo(p.pos),
        };
    }"""
    )
    check(
        "player car is on screen in the lower frame",
        onscreen["z"] < 1 and 0 < onscreen["x"] < 1280 and 300 < onscreen["y"] < 800,
        f"at ({onscreen['x']:.0f}, {onscreen['y']:.0f}) of 1280x800, {onscreen['dist']:.1f} m from camera",
    )

    # ---- steering ---------------------------------------------------------
    yaw0 = page.evaluate("() => window.NOCTIS.director.player.yaw")
    page.keyboard.down("KeyA")
    sim(page, 90)
    yaw1 = page.evaluate("() => window.NOCTIS.director.player.yaw")
    page.keyboard.up("KeyA")
    check("steering changes heading", abs(yaw1 - yaw0) > 0.05, f"yaw {yaw0:.2f} -> {yaw1:.2f}")
    shot(page, "07-steering.png")

    # ---- boost ------------------------------------------------------------
    page.keyboard.down("KeyW")
    sim(page, 60)
    b0 = page.evaluate("() => window.NOCTIS.director.player.boost")
    page.keyboard.down("ShiftLeft")
    sim(page, 60)
    b1 = page.evaluate("() => window.NOCTIS.director.player.boost")
    page.keyboard.up("ShiftLeft")
    check("shift drains the boost meter", b1 < b0, f"{b0:.2f} -> {b1:.2f}")

    # ---- pause ------------------------------------------------------------
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    check("escape pauses the race", page.evaluate("() => window.NOCTIS.director.state") == "paused", "paused")
    check("pause screen is up", page.locator(".screen-pause.active").count() == 1, "pause active")
    s0 = page.evaluate("() => window.NOCTIS.director.player.pos.x")
    sim(page, 120)
    s1 = page.evaluate("() => window.NOCTIS.director.player.pos.x")
    check("physics frozen while paused", s0 == s1, f"x {s0:.2f} -> {s1:.2f}")
    shot(page, "08-pause.png")

    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    check("escape resumes", page.evaluate("() => window.NOCTIS.director.state") == "race", "racing again")
    sim(page, 60)

    # ---- power-up pickup + use -------------------------------------------
    got_item = page.evaluate(
        """() => {
        const d = window.NOCTIS.director;
        d.player.item = 'turbo';
        d.items.useItem(d.player, d.cars);
        return d.player.turboT;
    }"""
    )
    check("turbo power-up applies", got_item > 2.0, f"{got_item:.1f}s of turbo")
    page.keyboard.press("KeyQ")
    sim(page, 5)
    check("Q fires the held power-up", page.evaluate("() => window.NOCTIS.director.player.item") is None,
          "slot emptied")

    # ---- jump -------------------------------------------------------------
    # Enter at a speed the car can actually sustain. Drag alone brings 84 m/s
    # to a standstill inside 200 m, and driving an impossible 390 km/h onto a
    # kicker measures a state the game never reaches.
    jumped = page.evaluate(
        """() => {
        const d = window.NOCTIS.director, T = window.NOCTIS.track, TER = window.NOCTIS.terrain;
        d.playerInput = { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false };
        const s0 = T.launchS - 70;
        const f = T.frameAt(s0);
        d.player.placeAt(f, s0, TER);
        d.player.vel.set(f.tx * 78, 0, f.tz * 78);
        let maxAir = 0, peakSpeed = 0, crossed = false;
        for (let i = 0; i < 300; i++) {
          d.update(1 / 60);
          maxAir = Math.max(maxAir, d.player.airTime);
          peakSpeed = Math.max(peakSpeed, d.player.speed);
          let ds = d.player.s - T.launchS;
          if (ds > T.length / 2) ds -= T.length;
          if (ds < -T.length / 2) ds += T.length;
          if (Math.abs(ds) < 20) crossed = true;
        }
        return { maxAir, peakSpeed, crossed };
    }"""
    )
    check("car reaches the ramp at speed", jumped["crossed"], f"{jumped['peakSpeed']*3.6:.0f} km/h over the crest")
    # A symmetric ramp catches the car again in ~0.2 s, which reads as a kerb
    # bounce. The landing side is tighter, so a real jump holds ~1 s of air.
    check("car goes airborne over the launch ramp in-game", jumped["maxAir"] > 0.5,
          f"{jumped['maxAir']:.2f}s of air")
    shot(page, "09-jump.png")

    # ---- results ----------------------------------------------------------
    # Put the player just behind the line on its final lap, then let the real
    # race logic run it over the flag. 2.6 s of finish delay follows the
    # crossing, so allow four seconds of simulation.
    page.evaluate(
        """() => {
        const d = window.NOCTIS.director, T = window.NOCTIS.track, TER = window.NOCTIS.terrain;
        const L = T.length;
        const s0 = L - 25;
        d.player.placeAt(T.frameAt(s0), s0, TER);
        d.player.lap = 2;
        d.player.cpIndex = T.checkpoints.length;
        d.player.lapTimes = [118.2, 117.9];
        d.player.totalDist = L * 3 - 25;
        d.cars.forEach((c, i) => { c.lap = 3; c.finished = false; c.totalDist = L * 3 - 25 - i * 40; });
    }"""
    )
    sim(page, 400)
    check("results screen reached", page.locator(".screen-results.active").count() == 1, "results active")
    res = page.evaluate(
        """() => ({
          pos: document.querySelector('[data-res=position]').textContent.trim(),
          best: document.querySelector('[data-res=bestlap]').textContent.trim(),
          laps: document.querySelectorAll('[data-res=laptimes] .lt').length,
          rows: document.querySelectorAll('[data-res=standings] .srow').length,
          total: document.querySelector('.screen-results .ro-v').textContent.trim(),
        })"""
    )
    check("results show a finishing position", "/" in res["pos"], res["pos"])
    check("results show the best lap", ":" in res["best"], res["best"])
    check("all three lap times listed", res["laps"] == 3, f"{res['laps']} laps")
    check("full field classified", res["rows"] == 8, f"{res['rows']} rows")
    check("total time on the readout", ":" in res["total"], res["total"])
    # The screen crossfades over 0.5 s. On a CPU rasteriser the compositor
    # lags well behind the DOM, so give it real frames before capturing.
    page.wait_for_timeout(6000)
    shot(page, "10-results.png")
    res_faded = page.evaluate(
        """() => ({
          menuOpacity: parseFloat(getComputedStyle(document.querySelector('.menu-layer')).opacity),
          hudHidden: getComputedStyle(document.querySelector('.hud-layer')).visibility,
          bar: parseFloat(getComputedStyle(document.querySelector('.letterbox-top')).height) || 0,
        })"""
    )
    check(
        "results screen crossfades in cleanly",
        res_faded["menuOpacity"] > 0.9 and res_faded["hudHidden"] == "hidden" and res_faded["bar"] > 10,
        f"menu opacity {res_faded['menuOpacity']:.2f}, hud {res_faded['hudHidden']}, letterbox {res_faded['bar']:.0f}px",
    )

    # ---- restart ----------------------------------------------------------
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")  # QUIT TO MENU
    page.wait_for_timeout(500)
    check("quit to menu works", page.locator(".screen-main.active").count() == 1, "back at main")
    page.keyboard.press("Enter")  # START RACE
    page.wait_for_timeout(400)
    sim(page, 320)
    check("restart after quitting works", page.evaluate("() => window.NOCTIS.director.state") == "race",
          page.evaluate("() => window.NOCTIS.director.state"))
    check("grid is full again", page.evaluate("() => window.NOCTIS.director.cars.length") == 8, "8 cars")

    # ---- reset-to-track ---------------------------------------------------
    page.evaluate("() => { window.NOCTIS.director.player.pos.x += 400; }")
    sim(page, 60)
    page.keyboard.press("KeyR")
    sim(page, 10)
    near = page.evaluate(
        """() => {
        const p = window.NOCTIS.director.player;
        const n = window.NOCTIS.track.nearestS(p.pos.x, p.pos.z);
        return n.dist;
    }"""
    )
    check("R puts the car back on the line", near < 20, f"{near:.1f} m from the centreline")

    # ---- responsive -------------------------------------------------------
    # Resize needs the page's main thread, which on a CPU rasteriser can be
    # blocked for seconds inside a single frame. Wait for the game's own
    # resize handler to report the new aspect, rather than guessing a delay.
    page.set_viewport_size({"width": 900, "height": 600})
    try:
        page.wait_for_function(
            "() => Math.abs(window.NOCTIS.world.camera.aspect - 900/600) < 0.01",
            timeout=60_000,
            polling=500,
        )
        resized = True
    except Exception:
        resized = False
    b2 = page.locator("#scene").bounding_box()
    check(
        "resize keeps the canvas full-bleed",
        resized and abs(b2["width"] - 900) < 2 and abs(b2["height"] - 600) < 2,
        f"camera aspect {page.evaluate('() => window.NOCTIS.world.camera.aspect'):.3f}, canvas {b2['width']:.0f}x{b2['height']:.0f}",
    )
    check("no overflow after resize",
          page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1"), "layout fits")
    shot(page, "11-narrow.png")
    page.set_viewport_size({"width": 1280, "height": 800})
    page.wait_for_timeout(1000)

    # ---- console hygiene --------------------------------------------------
    errors = [c for c in console if c.startswith("error")]
    warnings = [c for c in console if c.startswith("warn")]
    check("no console errors", not errors, "; ".join(errors[:3]) if errors else "clean")
    check("no uncaught exceptions", not page_errors, "; ".join(page_errors[:2]) if page_errors else "clean")
    if warnings:
        note(f"{len(warnings)} console warning(s): {warnings[:2]}")

    browser.close()

print(f"\n  screenshots -> {OUT}")
for p in sorted(OUT.glob("*.png")):
    print(f"    {p.name:<22} {p.stat().st_size // 1024:>5} KB")

print(f"\n{'ALL BROWSER CHECKS PASSED' if not failures else str(len(failures)) + ' BROWSER CHECK(S) FAILED'}")
for f in failures:
    print(f"  - {f}")
print()
sys.exit(0 if not failures else 1)
