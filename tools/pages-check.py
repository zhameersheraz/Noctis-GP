"""
Simulates a GitHub Pages project subpath and checks the game still boots.

GitHub Pages serves a project repo from https://<user>.github.io/<repo>/,
which is a SUBDIRECTORY. Anything using absolute asset paths breaks there.
This serves dist/ one level down and loads it exactly the way Pages would.

Also asserts the author credit is on screen and that git-ignored build output
did not leak into what would be committed.
"""

import pathlib
import shutil
import sys
import tempfile

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from serve import serve  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

failures = []


def check(label, ok, detail=""):
    if not ok:
        failures.append(label)
    print(f"  {'PASS' if ok else 'FAIL'}  {label:<46} {detail}")


if not (DIST / "index.html").exists():
    print("dist/ not found - run `npm run build` first.")
    sys.exit(2)

# Build a fake Pages root: <root>/noctis-gp/  ==  dist/
tmp = pathlib.Path(tempfile.mkdtemp(prefix="pages-sim-"))
pages_root = tmp / "pages"
shutil.copytree(DIST, pages_root / "noctis-gp")
print(f"\n=== GitHub Pages subpath check ===\n")
print(f"  simulating  /noctis-gp/  from  {pages_root}\n")

with serve(pages_root) as BASE, sync_playwright() as pw:
    browser = pw.chromium.launch(
        channel="chrome", headless=True,
        args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    )
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.set_default_timeout(120_000)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + "noctis-gp/", wait_until="load")
    page.wait_for_function("() => !!window.NOCTIS", timeout=300_000, polling=500)
    check("boots from a subpath", True, f"{BASE}noctis-gp/")

    loaded = page.evaluate(
        """() => {
        const s = [...document.querySelectorAll('script[type=module]')].map(x => x.src);
        return { scripts: s, css: [...document.querySelectorAll('link[rel=stylesheet]')].map(x => x.href) };
    }"""
    )
    ok_paths = all("/noctis-gp/assets/" in u for u in loaded["scripts"] + loaded["css"])
    check("assets resolve under the subpath", ok_paths, f"{loaded['scripts'][0].split('/')[-1] if loaded['scripts'] else '?'}")

    # The stylesheet must have actually applied, not 404'd.
    font = page.evaluate("() => getComputedStyle(document.querySelector('.wm-title')).fontFamily")
    check("stylesheet loaded", "Geist" in font or "monospace" in font, font.split(",")[0])

    # Author credit, on screen and in the right place.
    page.wait_for_timeout(2500)
    credit = page.evaluate(
        """() => {
        const el = document.querySelector('.credit');
        if (!el) return { missing: true };
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { text: el.textContent, x: r.x, y: r.y, w: r.width, h: r.height,
                 right: window.innerWidth - (r.x + r.width), visible: cs.visibility !== 'hidden' && cs.opacity !== '0' };
    }"""
    )
    if credit.get("missing"):
        check("author credit is rendered", False, "no .credit element")
    else:
        check("author credit is rendered", credit["visible"] and "zham" in credit["text"], repr(credit["text"]))
        check(
            "credit sits bottom-right without overlapping the footer",
            credit["y"] > 600 and credit["right"] < 200,
            f"at x={credit['x']:.0f} y={credit['y']:.0f}, {credit['right']:.0f}px from the right edge",
        )

    # A rough pixel check that the scene is live in this configuration too.
    page.screenshot(path=str(ROOT / "playtest" / "12-pages-subpath.png"))
    from PIL import Image
    im = Image.open(ROOT / "playtest" / "12-pages-subpath.png").convert("RGB").resize((160, 100))
    lumas = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in im.getdata()]
    mean = sum(lumas) / len(lumas)
    lit = sum(1 for v in lumas if v > 12) / len(lumas)
    check("scene renders from the subpath", lit > 0.05 and mean > 3, f"{lit*100:.0f}% lit, mean luma {mean:.1f}")

    real = [e for e in errors if "favicon" not in e.lower()]
    check("no console errors on Pages paths", not real, "; ".join(real[:2]) if real else "clean")
    browser.close()

shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{'ALL SUBPATH CHECKS PASSED' if not failures else str(len(failures)) + ' CHECK(S) FAILED'}")
for f in failures:
    print(f"  - {f}")
print()
sys.exit(0 if not failures else 1)
