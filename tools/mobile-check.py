"""
Mobile playtest: emulates a real touch device and drives the game with touch.

    python tools/mobile-check.py

Why this is not just a desktop test with a smaller window:

  * A real multi-touch press is dispatched over CDP (Input.dispatchTouchEvent
    with two touch points), because steering while holding the throttle is the
    single most common thing a player does. Playwright's touchscreen API only
    does single taps, which cannot catch the classic "both buttons fight" bug.
  * The controls must NOT exist on a desktop pointer, or they cover the HUD.
  * The menu has to be operable with no keyboard at all, which is the only way
    a phone player can ever start a race.
"""

import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from serve import serve  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
OUT = ROOT / "playtest"
OUT.mkdir(exist_ok=True)

failures = []


def check(label, ok, detail=""):
    if not ok:
        failures.append(label)
    print(f"  {'PASS' if ok else 'FAIL'}  {label:<44} {detail}")


def touch_xy(page, cls, index=0):
    """Centre of a control, in CSS pixels.

    Uses querySelectorAll rather than Playwright's `>> nth=` chaining: this
    runs inside page.evaluate, where that syntax is not understood.
    """
    return page.evaluate(
        """([sel, i]) => {
        const els = document.querySelectorAll(sel);
        const el = els[i];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    }""",
        [cls, index],
    )


def press(cdp, points):
    """points: list of {x, y}. Sends a real multi-touch event."""
    cdp.send(
        "Input.dispatchTouchEvent",
        {
            "type": "touchStart",
            "touchPoints": [{"x": p["x"], "y": p["y"], "id": i} for i, p in enumerate(points)],
        },
    )


def move(cdp, points):
    cdp.send(
        "Input.dispatchTouchEvent",
        {"type": "touchMove", "touchPoints": [{"x": p["x"], "y": p["y"], "id": i} for i, p in enumerate(points)]},
    )


def release(cdp):
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def release_one(cdp, p, point_id):
    """Lift a single finger by its id.

    CDP's touchEnd takes the points being RELEASED, not the ones remaining, so
    a touchMove with a reduced list does not simulate lifting a finger. The
    id matters too: press() assigns them in list order, so the id has to be
    passed in rather than assumed.
    """
    cdp.send(
        "Input.dispatchTouchEvent",
        {"type": "touchEnd", "touchPoints": [{"x": p["x"], "y": p["y"], "id": point_id}]},
    )


if not (DIST / "index.html").exists():
    print("dist/ not found - run `npm run build` first")
    sys.exit(2)

GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"]

print("\n=== NOCTIS GP - mobile touch verification ===\n")

with serve(DIST) as URL, sync_playwright() as pw:
    # ---------------- 1. desktop must NOT show touch controls ---------------
    print("-- desktop regression --")
    d = pw.chromium.launch(channel="chrome", headless=True, args=GL_ARGS)
    dp = d.new_page(viewport={"width": 1440, "height": 900})
    dp.set_default_timeout(120_000)
    dp.goto(URL, wait_until="load")
    dp.wait_for_function("() => !!window.NOCTIS", timeout=300_000, polling=500)
    dp.keyboard.press("Enter")
    dp.wait_for_timeout(1500)
    hidden = dp.evaluate("() => getComputedStyle(document.querySelector('.touch-layer')).display")
    check("touch controls hidden on desktop", hidden == "none", f"display: {hidden}")
    # The countdown is 4.45 s of SIMULATED time; on a CPU rasteriser that is
    # ~90 rendered frames, so advance it directly rather than waiting.
    dp.evaluate("() => window.NOCTIS.stepSim(400)")
    dp.wait_for_function("() => window.NOCTIS.director.state === 'race'", timeout=60_000, polling=300)
    dp.keyboard.down("KeyW")
    dp.evaluate("() => window.NOCTIS.stepSim(300)")
    speed = dp.evaluate("() => window.NOCTIS.director.player.speedKmh")
    check("keyboard still drives the car", speed > 40, f"{speed:.0f} km/h")
    d.close()

    # ---------------- 2. phone landscape -----------------------------------
    print("\n-- phone landscape (touch) --")
    b = pw.chromium.launch(channel="chrome", headless=True, args=GL_ARGS)
    ctx = b.new_context(
        viewport={"width": 844, "height": 390},  # iPhone 14 landscape-ish
        has_touch=True,
        is_mobile=True,
        device_scale_factor=2,
    )
    page = ctx.new_page()
    page.set_default_timeout(300_000)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(URL, wait_until="load")
    page.wait_for_function("() => !!window.NOCTIS", timeout=300_000, polling=500)

    check("touch detected", page.evaluate("() => window.NOCTIS.touch.supported"), "navigator reports touch")
    check("html.has-touch set", page.evaluate("() => document.documentElement.classList.contains('has-touch')"), "class applied")

    # Inspiration credit: present and visible on the front screen, and gone
    # once racing, so it never sits over the HUD.
    # The credit fades in over 0.5 s. On a CPU rasteriser the animation clock
    # barely ticks, so wait for the transition rather than sampling it
    # mid-flight - a value near zero here means the compositor is stalled,
    # not that the element is broken.
    try:
        page.wait_for_function(
            "() => parseFloat(getComputedStyle(document.querySelector('.attrib')).opacity) > 0.5",
            timeout=30_000,
            polling=300,
        )
        faded_in = True
    except Exception:
        faded_in = False
    attrib = page.evaluate(
        """() => {
        const el = document.querySelector('.attrib');
        if (!el) return { missing: true };
        const r = el.getBoundingClientRect();
        return {
            text: el.textContent.trim(),
            shown: el.classList.contains('show'),
            opacity: parseFloat(getComputedStyle(el).opacity),
            inView: r.right <= innerWidth && r.bottom <= innerHeight,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            vp: { w: innerWidth, h: innerHeight },
            href: el.querySelector('a')?.href ?? null,
        };
    }"""
    )
    check(
        "inspiration credit shown on the front screen",
        (not attrib.get("missing")) and attrib["shown"] and faded_in and attrib["inView"],
        f"text={attrib.get('text', 'MISSING')!r} opacity={attrib.get('opacity'):.2f} rect={attrib.get('rect')}",
    )

    # --- menu must be usable with no keyboard ---
    before = page.locator(".screen-main.active").count()
    page.tap(".screen-main .arc-line >> nth=0")
    page.wait_for_timeout(800)
    started = page.evaluate("() => window.NOCTIS.director.state")
    check("menu is tappable (no keyboard needed)", started in ("countdown", "race"), f"state {started}, main screen was {before}")
    check("HUD visible in race", page.evaluate("() => getComputedStyle(document.querySelector('.hud-layer')).visibility") == "visible", "visible")
    check(
        "inspiration credit hidden while racing",
        not page.evaluate("() => document.querySelector('.attrib').classList.contains('show')"),
        "not over the HUD",
    )

    page.evaluate("() => window.NOCTIS.stepSim(400)")
    page.wait_for_function("() => window.NOCTIS.director.state === 'race'", timeout=60_000, polling=300)
    page.wait_for_timeout(800)

    shown = page.evaluate("() => getComputedStyle(document.querySelector('.touch-layer')).display")
    check("touch controls shown while racing", shown == "block", f"display: {shown}")

    # The minimap is easy to ship broken and hard to notice: it is a small
    # faint outline in the corner. Assert it actually has ink on it, rather
    # than just existing in the DOM.
    mm = page.evaluate(
        """() => {
        const c = document.querySelector('[data-hud=minimap]');
        const r = c.getBoundingClientRect();
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 24) lit++;
        return { w: Math.round(r.width), h: Math.round(r.height), lit, total: d.length / 4 };
    }"""
    )
    check(
        "minimap actually renders the circuit",
        mm["lit"] > mm["total"] * 0.01,
        f"{mm['lit']}/{mm['total']} pixels drawn in a {mm['w']}x{mm['h']} box",
    )

    # Every control must be big enough for a thumb and inside the viewport.
    geometry = page.evaluate(
        """() => {
        const out = {};
        for (const el of document.querySelectorAll('.tbtn')) {
            const r = el.getBoundingClientRect();
            out[el.getAttribute('aria-label')] = {
                w: Math.round(r.width), h: Math.round(r.height),
                inView: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
            };
        }
        return out;
    }"""
    )
    small = {k: v for k, v in geometry.items() if v["w"] < 44 or v["h"] < 44}
    offscreen = [k for k, v in geometry.items() if not v["inView"]]
    check("all controls meet the 44px touch target", not small, f"{len(geometry)} controls, smallest {min(v['w'] for v in geometry.values())}px")
    check("all controls inside the viewport", not offscreen, "none clipped" if not offscreen else str(offscreen))

    # --- multi-touch: steer left WHILE accelerating -----------------------
    cdp = ctx.new_cdp_session(page)
    go = touch_xy(page, ".tbtn--go")
    left = touch_xy(page, ".tbtn--steer", 0)
    check("throttle button found", bool(go), f"{go['w']:.0f}x{go['h']:.0f} at ({go['x']:.0f},{go['y']:.0f})" if go else "missing")
    check("steer-left button found", bool(left), "" if left else "missing")

    # press() assigns ids in list order: 0 = throttle, 1 = steer-left
    press(cdp, [go, left])
    page.evaluate("() => window.NOCTIS.stepSim(90)")
    both = page.evaluate("() => ({ ...window.NOCTIS.touch.held })")
    check("multi-touch registers BOTH controls", both["throttle"] and both["left"],
          f"throttle={both['throttle']} left={both['left']}")

    yaw0 = page.evaluate("() => window.NOCTIS.director.player.yaw")
    page.evaluate("() => window.NOCTIS.stepSim(60)")
    yaw1 = page.evaluate("() => window.NOCTIS.director.player.yaw")
    sp1 = page.evaluate("() => window.NOCTIS.director.player.speedKmh")
    check("car steers while accelerating", abs(yaw1 - yaw0) > 0.05, f"yaw {yaw0:.2f} -> {yaw1:.2f}")
    check("car accelerates while steering", sp1 > 25, f"{sp1:.0f} km/h")

    # --- release only the steering thumb; throttle must survive ------------
    release_one(cdp, left, 1)
    page.evaluate("() => window.NOCTIS.stepSim(20)")
    after = page.evaluate("() => ({ ...window.NOCTIS.touch.held })")
    check(
        "lifting one thumb does not cancel the other",
        after["throttle"] and not after["left"],
        f"throttle={after['throttle']} left={after['left']}",
    )

    # Lift the throttle by its own id. An empty touchEnd does NOT end the
    # remaining touches, and leaving one alive makes every later press look
    # like a move of it rather than a new contact - which silently broke the
    # item button test until this was fixed.
    release_one(cdp, go, 0)
    page.evaluate("() => window.NOCTIS.stepSim(20)")
    off = page.evaluate("() => ({ ...window.NOCTIS.touch.held })")
    check("releasing all clears every control", not any(off.values()), str(off))

    # --- the page must not scroll or rubber-band under the thumbs ----------
    scrollable = page.evaluate(
        "() => document.documentElement.scrollHeight <= window.innerHeight + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1"
    )
    check("no page scrolling on a phone", scrollable, "layout fits the viewport")

    # --- pause button: there is no Esc key on a phone ---------------------
    pause = touch_xy(page, ".tbtn--pause")
    press(cdp, [pause])
    release_one(cdp, pause, 0)
    page.wait_for_timeout(700)
    check("on-screen pause works", page.evaluate("() => window.NOCTIS.director.state") == "paused", "paused")
    check("pause menu shown", page.locator(".screen-pause.active").count() == 1, "pause screen")
    page.screenshot(path=str(OUT / "15-mobile-pause.png"))

    # resume by tapping RESUME on the menu
    page.tap(".screen-pause .arc-line >> nth=0")
    page.wait_for_timeout(900)
    check("resume by tapping the menu", page.evaluate("() => window.NOCTIS.director.state") == "race", "racing")
    # The menu has to dismiss itself too, otherwise the race resumes behind a
    # pause overlay and the touch controls stay hidden.
    check(
        "pause menu is dismissed on resume",
        page.locator(".screen-pause.active").count() == 0
        and page.evaluate("() => document.getElementById('ui').classList.contains('playing')"),
        "menu closed, #ui.playing restored",
    )

    # --- item button fires a latched tap ---------------------------------
    # The button enables itself from the HUD, which only ticks once per
    # rendered frame, so set it explicitly rather than waiting on it.
    page.evaluate(
        "() => { const d = window.NOCTIS.director; d.player.item = 'turbo'; window.NOCTIS.touch.setItem('turbo'); }"
    )
    page.wait_for_timeout(400)
    item = touch_xy(page, ".tbtn--item")
    enabled = page.evaluate("() => !document.querySelector('.tbtn--item').disabled")
    check("item button enables when carrying one", enabled, "enabled")
    press(cdp, [item])
    diag = page.evaluate(
        """([x, y]) => {
        const el = document.elementFromPoint(x, y);
        const btn = document.querySelector('.tbtn--item');
        const r = btn.getBoundingClientRect();
        const cs = getComputedStyle(btn);
        return {
            hit: el ? (el.className || el.tagName) + '' : 'null',
            hitIsBtn: el === btn || (el && btn.contains(el)),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            pointerEvents: cs.pointerEvents,
            visibility: cs.visibility,
            display: cs.display,
            layerZ: getComputedStyle(document.querySelector('.touch-layer')).zIndex,
        };
    }""",
        [item["x"], item["y"]],
    )
    page.evaluate("() => window.NOCTIS.stepSim(4)")
    release_one(cdp, item, 0)
    fired = page.evaluate("() => window.NOCTIS.director.player.turboT > 0")
    check(
        "item button fires on a quick tap",
        fired,
        f"hit={diag['hit']!r} isBtn={diag['hitIsBtn']} rect={diag['rect']} "
        f"pe={diag['pointerEvents']} vis={diag['visibility']} turboT="
        f"{page.evaluate('() => window.NOCTIS.director.player.turboT.toFixed(2)')}s",
    )

    # a tap that starts and ends inside one frame must still register
    page.evaluate(
        "() => { const d = window.NOCTIS.director; d.player.item = 'shield'; window.NOCTIS.touch.setItem('shield'); }"
    )
    page.wait_for_timeout(300)
    item2 = touch_xy(page, ".tbtn--item")
    press(cdp, [item2])
    release_one(cdp, item2, 0)  # no frame rendered in between
    page.evaluate("() => window.NOCTIS.stepSim(4)")
    check(
        "sub-frame tap is not swallowed",
        page.evaluate("() => window.NOCTIS.director.player.shieldT > 0"),
        "shield applied",
    )

    # --- boost button dims when the meter is empty -----------------------
    page.evaluate("() => { window.NOCTIS.director.player.boost = 0; window.NOCTIS.touch.setBoost(0); }")
    page.wait_for_timeout(300)
    check(
        "boost button disables at zero",
        page.evaluate("() => document.querySelector('.tbtn--boost').disabled"),
        "disabled",
    )

    page.screenshot(path=str(OUT / "16-mobile-race.png"))
    real = [e for e in errors if "favicon" not in e.lower()]
    check("no console errors on mobile", not real, "; ".join(real[:2]) if real else "clean")
    b.close()

    # ---------------- 3. portrait ------------------------------------------
    print("\n-- phone portrait --")
    b2 = pw.chromium.launch(channel="chrome", headless=True, args=GL_ARGS)
    ctx2 = b2.new_context(
        viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2
    )
    p2 = ctx2.new_page()
    p2.set_default_timeout(300_000)
    p2.goto(URL, wait_until="load")
    p2.wait_for_function("() => !!window.NOCTIS", timeout=300_000, polling=500)
    p2.wait_for_timeout(1500)
    # The menu is what a phone player sees first; it must fit.
    fits = p2.evaluate(
        """() => {
        const r = document.querySelector('.screen-main .arc-line').getBoundingClientRect();
        const ro = document.querySelector('.readout').getBoundingClientRect();
        return { itemRight: r.right, w: innerWidth, roLeft: ro.left, roRight: ro.right };
    }"""
    )
    check("menu fits portrait width", fits["itemRight"] <= fits["w"] and fits["roRight"] <= fits["w"],
          f"item ends at {fits['itemRight']:.0f} of {fits['w']}")
    p2.screenshot(path=str(OUT / "17-mobile-portrait-menu.png"))
    p2.tap(".screen-main .arc-line >> nth=0")
    p2.wait_for_timeout(2500)
    hint = p2.evaluate("() => getComputedStyle(document.querySelector('.rotate-hint')).display")
    check("portrait rotate hint appears", hint == "block", f"display: {hint}")
    stillPlays = p2.evaluate("() => window.NOCTIS.director.state")
    check("game still runs in portrait", stillPlays in ("countdown", "race"), f"state {stillPlays}")
    p2.screenshot(path=str(OUT / "18-mobile-portrait-race.png"))
    b2.close()

print("\n  screenshots ->", OUT)
print(f"\n{'ALL MOBILE CHECKS PASSED' if not failures else str(len(failures)) + ' MOBILE CHECK(S) FAILED'}")
for f in failures:
    print(f"  - {f}")
print()
sys.exit(0 if not failures else 1)
