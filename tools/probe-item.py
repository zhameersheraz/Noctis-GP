"""Why is .tbtn--item reporting a zero-size box?"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from serve import serve  # noqa: E402

DIST = pathlib.Path(__file__).resolve().parent.parent / "dist"
GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]

with serve(DIST) as URL, sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome", headless=True, args=GL)
    ctx = b.new_context(viewport={"width": 844, "height": 390}, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.set_default_timeout(300_000)
    page.goto(URL, wait_until="load")
    page.wait_for_function("() => !!window.NOCTIS", timeout=300_000, polling=500)
    page.evaluate("() => { window.NOCTIS.director.startRace(); window.NOCTIS.menu.showScreen('none'); }")
    page.evaluate("() => window.NOCTIS.stepSim(400)")
    page.wait_for_timeout(1500)

    info = page.evaluate(
        """() => {
        const out = [];
        for (const el of document.querySelectorAll('.touch-layer .tbtn')) {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            out.push({
                cls: el.className,
                label: el.getAttribute('aria-label'),
                w: Math.round(r.width), h: Math.round(r.height),
                x: Math.round(r.x), y: Math.round(r.y),
                display: cs.display, position: cs.position,
                width: cs.width, height: cs.height,
                size: cs.getPropertyValue('--size'),
                disabled: el.disabled,
            });
        }
        const layer = document.querySelector('.touch-layer');
        const lc = getComputedStyle(layer);
        return {
            btns: out,
            layerDisplay: lc.display,
            layerZ: lc.zIndex,
            parent: layer.parentElement ? (layer.parentElement.id || layer.parentElement.className) : null,
        };
    }"""
    )
    print(f"layer display={info['layerDisplay']} z={info['layerZ']} parent={info['parent']!r}\n")
    for x in info["btns"]:
        print(
            f"  {x['label']:<18} cls={x['cls']:<28} box={x['w']}x{x['h']} at ({x['x']},{x['y']}) "
            f"display={x['display']:<8} css={x['width']}x{x['height']} --size={x['size']!r} disabled={x['disabled']}"
        )
    b.close()
