"""
Compose the README hero banner.

Renders in Chrome rather than with an image library so the banner uses the
game's own webfont and the same colour tokens as the UI. The artwork is a real
screenshot of the game, not a generated image, so what the README shows is what
a visitor actually gets.
"""

import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @import url('https://cdn.jsdelivr.net/fontsource/fonts/geist-mono@latest/latin-300-normal.woff2');
  @import url('https://cdn.jsdelivr.net/fontsource/fonts/geist-mono@latest/latin-500-normal.woff2');
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1600px; height:640px; overflow:hidden; background:#060b14; }
  .banner { position:relative; width:1600px; height:640px; font-family:"Geist Mono",monospace; }
  .shot { position:absolute; inset:0; background-size:cover; background-position:52% 42%; }
  .scrim-l { position:absolute; inset:0;
    background:
      linear-gradient(100deg, rgba(6,11,20,0.97) 0%, rgba(6,11,20,0.88) 26%, rgba(6,11,20,0.42) 52%, rgba(6,11,20,0) 74%),
      linear-gradient(to top, rgba(6,11,20,0.9) 0%, rgba(6,11,20,0) 34%),
      linear-gradient(to bottom, rgba(6,11,20,0.62) 0%, rgba(6,11,20,0) 18%);
  }
  .inner { position:absolute; left:76px; top:0; height:640px; display:flex; flex-direction:column; justify-content:center; }
  .brand { display:flex; align-items:center; gap:16px; }
  .gauge { width:30px; height:30px; }
  .gauge .ring { fill:none; stroke:rgba(226,238,250,0.42); stroke-width:1.4; }
  .gauge .hand { stroke:#9fd4ff; stroke-width:1.7; stroke-linecap:round; }
  .gauge .hub  { fill:#9fd4ff; }
  h1 { font-size:64px; font-weight:500; letter-spacing:0.30em; color:#eef5fc; text-transform:uppercase;
       line-height:1; text-shadow:0 2px 30px rgba(4,8,16,0.9); }
  .sub { margin-top:16px; font-size:15px; font-weight:400; letter-spacing:0.34em; text-transform:uppercase;
         color:rgba(226,238,250,0.62); }
  .rule { width:64px; height:2px; background:#9fd4ff; margin:30px 0 26px; }
  .facts { display:flex; gap:38px; }
  .fact .k { font-size:10px; letter-spacing:0.3em; text-transform:uppercase; color:rgba(226,238,250,0.34); }
  .fact .v { font-size:20px; font-weight:300; letter-spacing:0.06em; color:#eef5fc; margin-top:8px; }
  .cta { display:inline-flex; align-items:center; gap:14px; margin-top:34px; padding:15px 30px;
         border:1px solid rgba(159,212,255,0.5); border-radius:4px; text-decoration:none;
         font-size:13px; letter-spacing:0.28em; text-transform:uppercase; color:#eef5fc;
         background:rgba(159,212,255,0.10); width:max-content; }
  .cta .arrow { color:#9fd4ff; font-size:15px; }
  .credit { position:absolute; right:44px; bottom:34px; font-size:11px; letter-spacing:0.3em;
            text-transform:uppercase; color:rgba(226,238,250,0.34); }
</style></head>
<body>
  <div class="banner">
    <div class="shot" style="background-image:url('RACE_URL')"></div>
    <div class="scrim-l"></div>
    <div class="inner">
      <div class="brand">
        <svg class="gauge" viewBox="0 0 20 20">
          <circle class="ring" cx="10" cy="10" r="8.1"/>
          <line class="hand" x1="10" y1="10" x2="14.7" y2="5.6"/>
          <circle class="hub" cx="10" cy="10" r="1.3"/>
        </svg>
        <h1>Noctis GP</h1>
      </div>
      <div class="sub">Lunar Night Grand Prix</div>
      <div class="rule"></div>
      <div class="facts">
        <div class="fact"><div class="k">Circuit</div><div class="v">8.88 km</div></div>
        <div class="fact"><div class="k">Field</div><div class="v">8 cars</div></div>
        <div class="fact"><div class="k">Top speed</div><div class="v">313 km/h</div></div>
        <div class="fact"><div class="k">Built with</div><div class="v">Three.js + TS</div></div>
      </div>
      <a class="cta" href="https://zhameersheraz.github.io/Noctis-GP/">Play in browser <span class="arrow">&#8250;</span></a>
    </div>
    <div class="credit">Built by zham &middot; MIT</div>
  </div>
</body></html>
"""


def main() -> int:
    # Prefer the HUD-free frame if the capture produced one; fall back to the
    # normal race shot so the script still works on its own.
    for candidate in ("banner-source.png", "race.png"):
        if (DOCS / candidate).exists():
            source = DOCS / candidate
            break
    else:
        print("no race screenshot found - run tools/capture-artwork.py first")
        return 2

    page_html = HTML.replace("RACE_URL", source.resolve().as_uri())
    tmp = DOCS / "_banner.html"
    tmp.write_text(page_html, encoding="utf-8")

    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(
                channel="chrome", headless=True,
                args=["--hide-scrollbars", "--force-device-scale-factor=1"],
            )
            page = b.new_page(viewport={"width": 1600, "height": 640}, device_scale_factor=1)
            page.goto(tmp.resolve().as_uri(), wait_until="load")
            # Give the webfont a chance to land, or the title falls back.
            try:
                page.wait_for_function("() => document.fonts.status === 'loaded'", timeout=30_000)
            except Exception:
                page.wait_for_timeout(4000)
            page.wait_for_timeout(1500)
            page.screenshot(path=str(DOCS / "banner.png"))
            b.close()
    finally:
        tmp.unlink(missing_ok=True)

    out = DOCS / "banner.png"
    print(f"  banner.png  {out.stat().st_size // 1024} KB  {out.stat().st_size and '1600x640'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
