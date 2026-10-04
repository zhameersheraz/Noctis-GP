/**
 * NOCTIS GP - menu and HUD.
 *
 * Owns every DOM node inside #ui. The game talks to it through the small
 * `MenuApi` surface and never touches the DOM itself, which keeps the
 * simulation completely independent of presentation.
 *
 * Layout idea: menu items ride on an arc dial whose pivot sits just off the
 * right edge; the dial rotates so the selected item lands on a fixed needle.
 * A large digital readout sits bottom-left and reflects whichever item is
 * under the needle. In race, all of it fades out behind letterbox bars and the
 * HUD takes over.
 */

import type { HudState, ItemKind, MinimapData, ResultsData, Settings } from '../sim/types';

const LS_KEY = 'noctis-settings';
const QUALITIES: Settings['quality'][] = ['HIGH', 'MEDIUM', 'LOW'];
const STEP = 10; // degrees between dial items
const TLM_PX_PER_M = 0.55;

/** Shown on every menu screen. Keep in sync with package.json `author`. */
export const AUTHOR = 'zham';

function mk(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function fmtTime(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '--:--.--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cc = Math.floor((s * 100) % 100);
  return `${m}:${String(sec).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}

const ITEM_LABEL: Record<Exclude<ItemKind, null>, string> = {
  banana: 'BANANA',
  rocket: 'ROCKET',
  shield: 'SHIELD',
  turbo: 'TURBO',
};

export interface MenuHooks {
  onStartRace?(): void;
  onResume?(): void;
  onRestart?(): void;
  onQuitToMenu?(): void;
  onSettingChanged?(s: Settings): void;
  getSettings?(): Settings;
  getRaceInfo?(): { trackKm: number | null };
}

interface Readout {
  v: string;
  u?: string;
  l?: string;
}

interface MenuItem {
  label: string;
  action?(): void;
  value?: boolean;
  get?(): string;
  cycle?(dir: number): void;
  ro?(): Readout;
}

interface ScreenConfig {
  sub: string;
  footer: string;
  items: MenuItem[];
  rows?: [string, string][];
  note?: string;
  /** When set, the readout ignores the selection (the finish time is the point). */
  roFixed?(): Readout;
}

export interface Menu {
  showScreen(name: string): void;
  showCountdown(text: string | null): void;
  showNotice(text: string, ms?: number): void;
  updateHud(state: HudState): void;
  setMinimap(data: MinimapData | null): void;
  setResults(data: ResultsData): void;
  setTelemetry(dist: number, speedKmh: number, wrapLength: number): void;
  currentScreen(): string;
  isPlaying(): boolean;
  destroy(): void;
}

export function createMenu(hooks: MenuHooks = {}): Menu {
  const fire = (name: keyof MenuHooks, ...a: unknown[]): void => {
    const fn = hooks[name] as ((...x: unknown[]) => void) | undefined;
    if (typeof fn !== 'function') return;
    try {
      fn(...a);
    } catch (e) {
      // A broken hook must never take the UI down with it.
      console.warn('[noctis] hook', String(name), 'threw:', e);
    }
  };

  // ---- settings ---------------------------------------------------------
  const normalize = (s: Partial<Settings> | null | undefined): Settings => {
    const q = s?.quality;
    return {
      quality: q === 'LOW' || q === 'MEDIUM' || q === 'HIGH' ? q : 'HIGH',
      sound: typeof s?.sound === 'boolean' ? s.sound : true,
    };
  };

  let settings: Settings;
  if (typeof hooks.getSettings === 'function') {
    settings = normalize(hooks.getSettings());
  } else {
    try {
      settings = normalize(JSON.parse(localStorage.getItem(LS_KEY) || 'null'));
    } catch {
      settings = { quality: 'HIGH', sound: true };
    }
  }

  const persist = (): void => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings));
    } catch {
      /* private browsing: settings just do not survive the session */
    }
    fire('onSettingChanged', { ...settings });
  };
  const cycleQuality = (dir: number): void => {
    const i = QUALITIES.indexOf(settings.quality);
    settings.quality = QUALITIES[(i + dir + QUALITIES.length) % QUALITIES.length];
    persist();
    refreshValues();
  };
  const toggleSound = (): void => {
    settings.sound = !settings.sound;
    persist();
    refreshValues();
  };

  // ---- tiny UI sounds (synthesized, no assets) --------------------------
  let audioCtx: AudioContext | null = null;
  const ensureAudio = (): AudioContext | null => {
    if (!audioCtx) {
      const w = window as typeof window & { webkitAudioContext?: typeof AudioContext };
      const AC = window.AudioContext ?? w.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  };
  const blip = (kind: 'nav' | 'confirm'): void => {
    if (!settings.sound) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    if (kind === 'confirm') {
      osc.frequency.setValueAtTime(900, t0);
      osc.frequency.exponentialRampToValueAtTime(1400, t0 + 0.08);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.04, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.095);
      osc.start(t0);
      osc.stop(t0 + 0.12);
    } else {
      osc.frequency.setValueAtTime(2100, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.035, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
      osc.start(t0);
      osc.stop(t0 + 0.07);
    }
  };

  // ---- screen definitions ----------------------------------------------
  const ESC_RO: Readout = { v: 'ESC', l: 'BACK' };
  const pad2 = (n: number): string => String(n).padStart(2, '0');

  const screens: Record<string, ScreenConfig> = {
    main: {
      sub: 'LUNAR NIGHT GRAND PRIX',
      footer: '↑↓ SELECT   ENTER CONFIRM',
      items: [
        {
          label: 'START RACE',
          action: () => fire('onStartRace'),
          ro: () =>
            lastResults && lastResults.bestLap != null && isFinite(lastResults.bestLap)
              ? { v: fmtTime(lastResults.bestLap), l: 'BEST LAP THIS SESSION' }
              : {
                  v: raceInfo.trackKm != null ? raceInfo.trackKm.toFixed(2) : '-',
                  u: 'KM',
                  l: 'SERENITATIS CIRCUIT',
                },
        },
        { label: 'CONTROLS', action: () => openScreen('controls', 'main'), ro: () => ({ v: '07', l: 'MAPPED INPUTS' }) },
        { label: 'SETTINGS', action: () => openScreen('settings', 'main'), ro: () => ({ v: settings.quality, l: 'RENDER QUALITY' }) },
      ],
    },
    controls: {
      sub: 'PILOT BRIEFING',
      footer: 'ESC BACK',
      rows: [
        ['THROTTLE / BRAKE', 'W · S  /  ↑ ↓'],
        ['STEER', 'A · D  /  ← →'],
        ['BOOST', 'SHIFT'],
        ['HANDBRAKE', 'SPACE'],
        ['USE POWER-UP', 'Q / E'],
        ['RESET CAR', 'R'],
        ['PAUSE', 'ESC'],
      ],
      note: 'POWER-UPS — EIGHT BOXES PER ROW ON THE RACING LINE · BANANA / ROCKET / SHIELD / TURBO',
      items: [{ label: 'BACK', action: goBack, ro: () => ESC_RO }],
    },
    settings: {
      sub: 'GARAGE',
      footer: '↑↓ SELECT   ‹ › ADJUST   ESC BACK',
      items: [
        { label: 'QUALITY', value: true, get: () => settings.quality, cycle: cycleQuality, ro: () => ({ v: settings.quality, l: 'RENDER QUALITY' }) },
        { label: 'SOUND', value: true, get: () => (settings.sound ? 'ON' : 'OFF'), cycle: toggleSound, ro: () => ({ v: settings.sound ? 'ON' : 'OFF', l: 'AUDIO' }) },
        { label: 'BACK', action: goBack, ro: () => ESC_RO },
      ],
    },
    pause: {
      sub: 'PIT STOP',
      footer: '↑↓ SELECT   ENTER CONFIRM   ESC RESUME',
      items: [
        {
          label: 'RESUME',
          // The menu has to dismiss itself, not just resume the director.
          // The Escape key path in main.ts hides the screen explicitly, so
          // without this a player who taps RESUME (or clicks it with a mouse)
          // gets a live race running behind a still-visible pause overlay.
          action: () => {
            fire('onResume');
            showScreen('none');
          },
          ro: () => ({ v: fmtTime(lastHud.clock), l: 'RACE TIME' }),
        },
        { label: 'RESTART RACE', action: () => fire('onRestart'), ro: () => ({ v: pad2(lastHud.lapsTotal || 3), l: 'LAPS' }) },
        { label: 'CONTROLS', action: () => openScreen('controls', 'pause'), ro: () => ({ v: '07', l: 'MAPPED INPUTS' }) },
        { label: 'SETTINGS', action: () => openScreen('settings', 'pause'), ro: () => ({ v: settings.quality, l: 'RENDER QUALITY' }) },
        { label: 'QUIT TO MENU', action: quitToMenu, ro: () => ({ v: 'MENU', l: 'EXIT RACE' }) },
      ],
    },
    results: {
      sub: 'RUN COMPLETE',
      footer: '↑↓ SELECT   ENTER CONFIRM',
      roFixed: () => ({ v: fmtTime(lastResults?.totalTime), l: 'TOTAL TIME' }),
      items: [
        { label: 'RACE AGAIN', action: raceAgain },
        { label: 'QUIT TO MENU', action: quitToMenu },
      ],
    },
  };

  const raceInfo: { trackKm: number | null } = (() => {
    try {
      const r = hooks.getRaceInfo?.();
      if (r && r.trackKm != null && isFinite(r.trackKm)) return { trackKm: r.trackKm };
    } catch {
      /* fall through */
    }
    return { trackKm: null };
  })();

  let lastHud: HudState = {};
  let lastResults: ResultsData | null = null;

  // ---- DOM --------------------------------------------------------------
  const ui = document.getElementById('ui') ?? (() => {
    const d = mk('div');
    d.id = 'ui';
    document.body.appendChild(d);
    return d;
  })();

  ui.appendChild(mk('div', 'letterbox letterbox-top'));
  ui.appendChild(mk('div', 'letterbox letterbox-bottom'));

  const menuLayer = mk('div', 'menu-layer');
  ui.appendChild(menuLayer);

  const screenEls: Record<string, HTMLElement> = {};
  const valueEls: Record<string, (HTMLElement | undefined)[]> = {};
  const selIndex: Record<string, number> = {};

  function buildTicks(dial: HTMLElement, n: number): void {
    const last = (n - 1) * STEP;
    for (let a = -STEP; a <= last + STEP; a += STEP / 2) {
      const major = a % STEP === 0 && a >= 0 && a <= last;
      const t = mk('i', `tick${major ? ' major' : ''}`);
      // The tick sits on the ring with its outer end flush with the dial
      // circle. 180 degrees is the leftmost point, where the needle lives, and
      // items run downward from it.
      t.style.transform = `rotate(${180 - a}deg) translateX(calc(var(--dial-r) - 100%))`;
      dial.appendChild(t);
    }
  }

  function buildScreen(name: string): void {
    const cfg = screens[name];
    const sec = mk('section', `screen screen-${name}`);
    sec.dataset.screen = name;
    sec.appendChild(mk('div', 'needle'));

    const ro = mk('div', 'readout');
    const roNum = mk('div', 'ro-num');
    roNum.appendChild(mk('span', 'ro-v'));
    roNum.appendChild(mk('span', 'ro-u'));
    ro.appendChild(roNum);
    ro.appendChild(mk('div', 'ro-l'));
    sec.appendChild(ro);

    if (name === 'results') {
      const body = mk('div', 'results-body');
      const grid = mk('div', 'stat-grid');
      const sPos = mk('div', 'stat');
      sPos.innerHTML = '<span class="k">POSITION</span><span class="v" data-res="position">-</span>';
      const sBest = mk('div', 'stat');
      sBest.innerHTML = '<span class="k">BEST LAP</span><span class="v" data-res="bestlap">-</span>';
      grid.append(sPos, sBest);
      body.appendChild(grid);
      const laps = mk('div', 'lap-times');
      laps.dataset.res = 'laptimes';
      body.appendChild(laps);
      const standings = mk('div', 'standings');
      standings.dataset.res = 'standings';
      body.appendChild(standings);
      sec.appendChild(body);
    } else if (cfg.rows) {
      const rows = mk('div', 'rows');
      for (const [k, v] of cfg.rows) {
        const r = mk('div', 'row');
        const kk = mk('span', 'k');
        kk.textContent = k;
        const vv = mk('span', 'v');
        vv.textContent = v;
        r.append(kk, vv);
        rows.appendChild(r);
      }
      if (cfg.note) {
        const note = mk('div', 'note');
        note.textContent = cfg.note;
        rows.appendChild(note);
      }
      sec.appendChild(rows);
    }

    const dial = mk('div', 'dial');
    buildTicks(dial, cfg.items.length);

    valueEls[name] = [];
    cfg.items.forEach((it, i) => {
      const angle = i * STEP;
      const btn = mk('button', `arc-item${it.value ? ' item-value' : ''}`);
      (btn as HTMLButtonElement).type = 'button';
      btn.dataset.angle = String(angle);
      const line = mk('span', 'arc-line');
      const label = mk('span', 'item-label');
      label.textContent = it.label;
      line.appendChild(label);
      if (it.value) {
        const val = mk('span', 'item-val');
        const lc = mk('span', 'chev');
        lc.textContent = '\u2039';
        const vt = mk('span', 'vt');
        vt.textContent = it.get?.() ?? '';
        const rc = mk('span', 'chev');
        rc.textContent = '\u203a';
        val.append(lc, vt, rc);
        line.appendChild(val);
        valueEls[name][i] = vt;
      }
      btn.addEventListener('mouseenter', () => {
        if (active !== name) return;
        if ((selIndex[name] ?? 0) !== i) blip('nav');
        setSelected(name, i);
      });
      btn.addEventListener('click', () => {
        if (active !== name) return;
        setSelected(name, i);
        confirmSelected();
        btn.blur(); // so Space cannot re-trigger the click
      });
      btn.appendChild(line);
      dial.appendChild(btn);
    });

    sec.appendChild(dial);
    menuLayer.appendChild(sec);
    screenEls[name] = sec;
    selIndex[name] = 0;
  }

  for (const name of ['main', 'controls', 'settings', 'pause', 'results']) buildScreen(name);

  const wm = mk('div', 'wordmark');
  wm.innerHTML =
    '<svg class="wm-gauge" viewBox="0 0 20 20" aria-hidden="true">' +
    '<circle class="ring" cx="10" cy="10" r="8.1"/>' +
    '<line class="hand" x1="10" y1="10" x2="14.7" y2="5.6"/>' +
    '<circle class="hub" cx="10" cy="10" r="1.3"/>' +
    '</svg>' +
    '<span class="wm-title">NOCTIS GP</span>' +
    '<span class="wm-sub"></span>';
  menuLayer.appendChild(wm);
  const wmSub = wm.querySelector('.wm-sub') as HTMLElement;
  const footer = mk('div', 'footer');
  menuLayer.appendChild(footer);

  // Author credit. Bottom-right, at the same weight as the footer hint, so it
  // is present without competing with anything the player needs to read.
  const credit = mk('div', 'credit');
  credit.textContent = `NOCTIS GP — BUILT BY ${AUTHOR}`;
  menuLayer.appendChild(credit);

  // Inspiration credit, shown on the front screen only.
  const attrib = mk('div', 'attrib');
  attrib.innerHTML =
    'Visual design inspired by <a href="https://nrjx43j36adhu.ok.kimi.link" target="_blank" rel="noopener noreferrer">NOCTIS&nbsp;GP</a>';
  menuLayer.appendChild(attrib);

  // ---- HUD --------------------------------------------------------------
  const hud = mk('div', 'hud-layer');
  hud.innerHTML = `
    <div class="hud-top">
      <div class="pos" data-hud="pos">1/8</div>
      <div class="hud-clock" data-hud="clock">0:00.00</div>
      <div class="lap" data-hud="lap">LAP 1/3</div>
    </div>
    <div class="hud-standings" data-hud="standings"></div>
    <div class="hud-progress"><div class="hud-progress-fill" data-hud="progress"></div></div>
    <div class="hud-item hidden" data-hud="itemwrap">
      <canvas class="hud-item-glyph" data-hud="itemglyph"></canvas>
      <div class="hud-item-key">Q</div>
      <div class="hud-item-name" data-hud="itemname">-</div>
    </div>
    <div class="hud-speed">
      <div class="hud-speed-row">
        <div class="hud-speed-val" data-hud="speed">0</div>
        <div class="hud-speed-unit">KM/H</div>
      </div>
      <div class="hud-boost" data-hud="boostwrap"><div class="hud-boost-fill" data-hud="boost"></div></div>
    </div>
    <div class="hud-bottomleft">
      <canvas class="minimap" data-hud="minimap"></canvas>
      <div class="hud-hints" data-hud="hints">
        <span><b>SHIFT</b> BOOST</span><span><b>Q·E</b> ITEM</span><span><b>SPACE</b> HANDBRAKE</span><span><b>R</b> RESET</span>
      </div>
    </div>`;
  ui.appendChild(hud);

  const hudEls: Record<string, HTMLElement> = {};
  hud.querySelectorAll<HTMLElement>('[data-hud]').forEach((e) => {
    hudEls[e.dataset.hud as string] = e;
  });

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const MM = 150;
  const mmCanvas = hudEls.minimap as HTMLCanvasElement;
  mmCanvas.width = MM * dpr;
  mmCanvas.height = MM * dpr;
  const mmCtx = mmCanvas.getContext('2d');
  const trackCanvas = document.createElement('canvas');
  trackCanvas.width = MM * dpr;
  trackCanvas.height = MM * dpr;
  const trackCtx = trackCanvas.getContext('2d');
  let mmTransform: { px(x: number): number; pz(z: number): number } | null = null;
  let mmTrackRef: [number, number][] | null = null;

  const noticeLayer = mk('div', 'notice-layer');
  const cdEl = mk('div', 'center-notice countdown');
  const alertEl = mk('div', 'center-notice alert');
  noticeLayer.append(cdEl, alertEl);
  ui.appendChild(noticeLayer);

  // ---- telemetry tape ---------------------------------------------------
  const tlm = mk('canvas', 'telemetry') as HTMLCanvasElement;
  menuLayer.appendChild(tlm);
  const tlmCtx = tlm.getContext('2d');
  const TLM = { acc: 0, raw: 0, has: false, speed: 0, w: 0, h: 0 };

  function drawTelemetry(): void {
    const c = tlmCtx;
    const w = TLM.w;
    const h = TLM.h;
    if (!c || !w || !h) return;
    c.save();
    c.scale(dpr, dpr);
    c.clearRect(0, 0, w, h);
    const baseX = w - 26;
    const midY = h / 2;
    // Distance tape: minor tick 20 m, medium 100 m, labelled every 200 m.
    const span = h / TLM_PX_PER_M;
    const v0 = Math.floor((TLM.acc - span / 2) / 20) * 20;
    const v1 = TLM.acc + span / 2;
    c.lineWidth = 1;
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    for (let v = v0; v <= v1; v += 20) {
      const y = midY - (v - TLM.acc) * TLM_PX_PER_M;
      const major = v % 200 === 0;
      const mid = v % 100 === 0;
      c.strokeStyle = major || mid ? 'rgba(226,238,250,0.42)' : 'rgba(226,238,250,0.2)';
      c.beginPath();
      c.moveTo(baseX - (major ? 14 : mid ? 10 : 6), y + 0.5);
      c.lineTo(baseX, y + 0.5);
      c.stroke();
      if (major && v >= 0) {
        c.font = '9px "Geist Mono", ui-monospace, monospace';
        c.fillStyle = 'rgba(226,238,250,0.5)';
        c.fillText((v / 1000).toFixed(1), baseX - 18, y + 0.5);
      }
    }
    c.strokeStyle = 'rgba(226,238,250,0.3)';
    c.beginPath();
    c.moveTo(baseX + 0.5, 0);
    c.lineTo(baseX + 0.5, h);
    c.stroke();
    // Speed band on the outer edge, 0..320 km/h from the bottom.
    const k = Math.max(0, Math.min(1, TLM.speed / 320));
    c.fillStyle = 'rgba(226,238,250,0.14)';
    c.fillRect(w - 2, 0, 2, h);
    c.fillStyle = '#9fd4ff';
    c.fillRect(w - 2, h - k * h, 2, k * h);
    c.strokeStyle = '#9fd4ff';
    c.beginPath();
    c.moveTo(0, midY + 0.5);
    c.lineTo(baseX + 8, midY + 0.5);
    c.stroke();
    c.font = '300 17px "Geist Mono", ui-monospace, monospace';
    c.textAlign = 'right';
    c.fillText(String(Math.max(0, Math.round(TLM.speed))), baseX - 10, midY - 14);
    c.font = '8px "Geist Mono", ui-monospace, monospace';
    c.fillStyle = 'rgba(226,238,250,0.45)';
    c.fillText('KM/H', baseX - 10, midY + 14);
    // Dissolve both ends of the tape.
    c.globalCompositeOperation = 'destination-in';
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.12, 'rgba(0,0,0,1)');
    g.addColorStop(0.88, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.restore();
  }

  function sizeTelemetry(): void {
    const r = tlm.getBoundingClientRect();
    TLM.w = r.width;
    TLM.h = r.height;
    tlm.width = Math.max(1, Math.round(r.width * dpr));
    tlm.height = Math.max(1, Math.round(r.height * dpr));
    drawTelemetry();
  }

  // The tape accumulates rather than snapping, so it never jumps when the
  // focus car's arc position wraps at the line.
  function setTelemetry(dist: number, speedKmh: number, wrapLength: number): void {
    if (wrapLength && TLM.has) {
      let d = dist - TLM.raw;
      if (d > wrapLength / 2) d -= wrapLength;
      if (d < -wrapLength / 2) d += wrapLength;
      TLM.acc += d;
    } else {
      TLM.acc = dist || 0;
    }
    TLM.raw = dist || 0;
    TLM.has = true;
    TLM.speed = speedKmh || 0;
    if (active !== 'none') drawTelemetry();
  }

  // ---- selection --------------------------------------------------------
  function setSelected(name: string, idx: number): void {
    selIndex[name] = idx;
    const sec = screenEls[name];
    if (!sec) return;
    // Rotate the dial so item idx lands on the needle; labels stay level.
    const phi = idx * STEP;
    (sec.querySelector('.dial') as HTMLElement).style.transform = `rotate(${phi}deg)`;
    sec.querySelectorAll<HTMLElement>('.arc-item').forEach((b, i) => {
      const a = 180 - Number(b.dataset.angle);
      b.style.transform = `rotate(${a}deg) translateX(var(--dial-r)) rotate(${-a - phi}deg)`;
      b.classList.toggle('selected', i === idx);
    });
    sec.querySelectorAll('.tick.major').forEach((t, i) => t.classList.toggle('on', i === idx));
    updateReadout(name);
  }

  function updateReadout(name: string): void {
    const cfg = screens[name];
    const sec = screenEls[name];
    if (!cfg || !sec) return;
    let r: Readout | null = null;
    if (cfg.roFixed) r = cfg.roFixed();
    else {
      const it = cfg.items[selIndex[name] ?? 0];
      if (it?.ro) r = it.ro();
    }
    if (!r) return;
    const vEl = sec.querySelector('.ro-v') as HTMLElement;
    const changed = vEl.textContent !== String(r.v);
    vEl.textContent = r.v;
    (sec.querySelector('.ro-u') as HTMLElement).textContent = r.u ?? '';
    (sec.querySelector('.ro-l') as HTMLElement).textContent = r.l ?? '';
    if (changed) {
      const num = sec.querySelector('.ro-num') as HTMLElement;
      num.classList.remove('pulse');
      void num.offsetWidth; // reflow to restart the animation
      num.classList.add('pulse');
    }
  }

  function confirmSelected(): void {
    const items = screens[active]?.items ?? [];
    const it = items[selIndex[active] ?? 0];
    if (!it) return;
    blip('confirm');
    if (it.value) it.cycle?.(1);
    else it.action?.();
  }

  function moveSelection(delta: number): void {
    const items = screens[active]?.items ?? [];
    if (!items.length) return;
    const idx = (((selIndex[active] ?? 0) + delta) % items.length + items.length) % items.length;
    setSelected(active, idx);
    blip('nav');
  }

  function cycleSelected(dir: number): void {
    const items = screens[active]?.items ?? [];
    const it = items[selIndex[active] ?? 0];
    if (it?.value) {
      it.cycle?.(dir);
      blip('nav');
    }
  }

  function refreshValues(): void {
    for (const name of Object.keys(valueEls)) {
      const arr = valueEls[name];
      screens[name].items.forEach((it, i) => {
        if (it.value && arr[i]) arr[i].textContent = it.get?.() ?? '';
      });
    }
    for (const name of Object.keys(screenEls)) updateReadout(name);
  }

  // ---- screen switching -------------------------------------------------
  let active = 'main';
  let navReturn = 'main';
  let hintsTimer: number | null = null;

  function triggerStagger(sec: HTMLElement): void {
    const dial = sec.querySelector('.dial') as HTMLElement | null;
    if (!dial) return;
    dial.querySelectorAll<HTMLElement>('.tick').forEach((t, i) => {
      t.style.animationDelay = `${(i * 0.02).toFixed(3)}s`;
    });
    dial.querySelectorAll<HTMLElement>('.arc-line').forEach((l, i) => {
      l.style.animationDelay = `${(0.08 + i * 0.065).toFixed(3)}s`;
    });
    dial.classList.remove('stagger');
    void dial.offsetWidth;
    dial.classList.add('stagger');
  }

  function goBack(): void {
    if (active === 'controls' || active === 'settings') showScreen(navReturn || 'main');
    else if (active === 'pause') {
      fire('onResume');
      showScreen('none');
    }
  }

  function openScreen(name: string, returnTo: string): void {
    navReturn = returnTo;
    showScreen(name);
  }

  function quitToMenu(): void {
    showCountdown(null); // quitting mid-countdown must not leave a stuck numeral
    fire('onQuitToMenu');
    showScreen('main');
  }

  function raceAgain(): void {
    if (typeof hooks.onRestart === 'function') fire('onRestart');
    else fire('onStartRace');
  }

  function showScreen(name: string): void {
    if (name !== 'none' && !screens[name]) name = 'main';
    active = name;
    ui.classList.toggle('playing', name === 'none');

    if (name === 'none') {
      for (const s of Object.values(screenEls)) s.classList.remove('active');
      attrib.classList.remove('show');
      hud.classList.remove('hidden');
      hudEls.hints.classList.remove('faded');
      if (hintsTimer !== null) clearTimeout(hintsTimer);
      hintsTimer = window.setTimeout(() => hudEls.hints.classList.add('faded'), 8000);
    } else {
      if (hintsTimer !== null) clearTimeout(hintsTimer);
      hudEls.hints.classList.remove('faded');
      attrib.classList.toggle('show', name === 'main');
      wmSub.textContent = screens[name].sub ?? '';
      footer.textContent = screens[name].footer ?? '';
      for (const [key, el] of Object.entries(screenEls)) {
        if (key === name) {
          el.classList.add('active');
          setSelected(name, 0);
          triggerStagger(el);
        } else {
          el.classList.remove('active');
        }
      }
    }
  }

  // ---- center notices ---------------------------------------------------
  function pop(el: HTMLElement): void {
    el.style.transition = 'none';
    el.classList.remove('show');
    void el.offsetWidth;
    el.style.transition = '';
    el.classList.add('show');
  }
  function showCountdown(text: string | null): void {
    if (text == null) {
      cdEl.classList.remove('show');
      return;
    }
    cdEl.textContent = text;
    cdEl.classList.toggle('go', text.toUpperCase() === 'GO');
    pop(cdEl);
  }
  let noticeTimer: number | null = null;
  function showNotice(text: string, ms = 1400): void {
    alertEl.textContent = text;
    pop(alertEl);
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => alertEl.classList.remove('show'), ms);
  }

  // ---- results ----------------------------------------------------------
  function setResults(data: ResultsData): void {
    lastResults = data;
    const sec = screenEls.results;
    (sec.querySelector('[data-res="position"]') as HTMLElement).textContent =
      data.position != null ? `${data.position} / ${data.total}` : '-';
    (sec.querySelector('[data-res="bestlap"]') as HTMLElement).textContent =
      data.bestLap != null && isFinite(data.bestLap) ? fmtTime(data.bestLap) : '-';

    const lapsWrap = sec.querySelector('[data-res="laptimes"]') as HTMLElement;
    lapsWrap.innerHTML = '';
    (data.laps ?? []).forEach((lt, i) => {
      const c = mk('div', 'lt');
      const k = mk('span', 'k');
      k.textContent = `LAP ${i + 1}`;
      const v = mk('span', 'v');
      v.textContent = fmtTime(lt);
      c.append(k, v);
      lapsWrap.appendChild(c);
    });

    const stWrap = sec.querySelector('[data-res="standings"]') as HTMLElement;
    stWrap.innerHTML = '';
    (data.standings ?? []).forEach((s, i) => {
      const row = mk('div', `srow${s.isPlayer ? ' player' : ''}`);
      const pos = mk('span', 'pos');
      pos.textContent = String(i + 1);
      const name = mk('span', 'name');
      name.textContent = s.name;
      const time = mk('span', 'time');
      if (s.time != null) time.textContent = fmtTime(s.time);
      else if (s.gap != null) time.textContent = `+${Number(s.gap).toFixed(2)}`;
      else time.textContent = '-';
      row.append(pos, name, time);
      stWrap.appendChild(row);
    });
  }

  // ---- power-up glyph ---------------------------------------------------
  const glyphCanvas = hudEls.itemglyph as HTMLCanvasElement;
  const GMM = 48;
  glyphCanvas.width = GMM * dpr;
  glyphCanvas.height = GMM * dpr;
  const gCtx = glyphCanvas.getContext('2d');
  let curItem: ItemKind = null;
  function drawGlyph(type: Exclude<ItemKind, null>): void {
    const c = gCtx;
    if (!c) return;
    const s = GMM * dpr;
    const m = s / 96;
    c.clearRect(0, 0, s, s);
    c.save();
    c.scale(m, m);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (type === 'banana') {
      c.strokeStyle = '#ffe14d';
      c.lineWidth = 10;
      c.beginPath();
      c.arc(48, 44, 26, Math.PI * 0.15, Math.PI * 1.15);
      c.stroke();
      c.fillStyle = '#ffe14d';
      c.beginPath();
      c.arc(30, 68, 5, 0, Math.PI * 2);
      c.fill();
    } else if (type === 'rocket') {
      c.fillStyle = '#ff5544';
      c.beginPath();
      c.moveTo(58, 20);
      c.lineTo(44, 52);
      c.lineTo(64, 56);
      c.closePath();
      c.fill();
      c.fillStyle = '#eef5fc';
      c.fillRect(40, 50, 12, 22);
      c.fillStyle = '#72adf7';
      c.beginPath();
      c.moveTo(42, 74);
      c.lineTo(48, 88);
      c.lineTo(54, 74);
      c.closePath();
      c.fill();
    } else if (type === 'shield') {
      c.strokeStyle = '#66ccff';
      c.lineWidth = 7;
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        const x = 48 + Math.cos(a) * 26;
        const y = 48 + Math.sin(a) * 26;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.closePath();
      c.stroke();
    } else if (type === 'turbo') {
      c.strokeStyle = '#8fffd0';
      c.lineWidth = 9;
      for (let k = 0; k < 2; k++) {
        const x = 26 + k * 22;
        c.beginPath();
        c.moveTo(x, 30);
        c.lineTo(x + 20, 48);
        c.lineTo(x, 66);
        c.stroke();
      }
    }
    c.restore();
  }

  let rollTimer: number | null = null;
  function setHudItem(type: ItemKind): void {
    if (type === curItem) return;
    const wasEmpty = !curItem;
    curItem = type;
    const wrap = hudEls.itemwrap;
    if (rollTimer !== null) {
      clearInterval(rollTimer);
      rollTimer = null;
    }
    if (!type) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden', 'pop');
    void wrap.offsetWidth;
    if (wasEmpty) {
      // Slot-machine roll, then settle on the real item.
      const pool = Object.keys(ITEM_LABEL) as Exclude<ItemKind, null>[];
      let ticks = 0;
      hudEls.itemname.textContent = '\u00b7 \u00b7 \u00b7';
      drawGlyph(pool[Math.floor(Math.random() * pool.length)]);
      rollTimer = window.setInterval(() => {
        ticks++;
        if (ticks >= 9 || curItem !== type) {
          if (rollTimer !== null) clearInterval(rollTimer);
          rollTimer = null;
          if (curItem === type) {
            drawGlyph(type);
            hudEls.itemname.textContent = ITEM_LABEL[type] ?? '-';
            wrap.classList.remove('pop');
            void wrap.offsetWidth;
            wrap.classList.add('pop');
          }
          return;
        }
        drawGlyph(pool[ticks % pool.length]);
      }, 75);
    } else {
      drawGlyph(type);
      hudEls.itemname.textContent = ITEM_LABEL[type] ?? '-';
      wrap.classList.add('pop');
    }
  }

  // ---- HUD feed ---------------------------------------------------------
  function updateHud(s: HudState): void {
    Object.assign(lastHud, s);
    if (s.visible === false) hud.classList.add('hidden');
    else hud.classList.remove('hidden');

    if (s.speedKmh != null) hudEls.speed.textContent = String(Math.max(0, Math.round(s.speedKmh)));
    if (s.clock != null) hudEls.clock.textContent = fmtTime(s.clock);
    if (s.position != null && s.total != null) hudEls.pos.textContent = `${s.position}/${s.total}`;
    if (s.lap != null && s.lapsTotal != null) hudEls.lap.textContent = `LAP ${s.lap}/${s.lapsTotal}`;
    if (s.item !== undefined) setHudItem(s.item);
    if (s.standings) {
      hudEls.standings.style.display = s.standings.length ? '' : 'none';
      hudEls.standings.innerHTML = s.standings
        .map(
          (r, i) =>
            `<div class="stand-row${r.me ? ' me' : ''}"><span class="pos">${i + 1}</span>` +
            `<i style="background:${r.color}"></i><span>${escapeHtml(r.name)}</span>` +
            `<span class="lapinfo">${r.finished ? 'FIN' : 'L' + r.lap}</span></div>`,
        )
        .join('');
    }
    if (s.raceProgress != null) {
      hudEls.progress.style.height = `${(Math.max(0, Math.min(1, s.raceProgress)) * 100).toFixed(1)}%`;
    }
    if (s.boost != null) {
      const b = Math.max(0, Math.min(1, s.boost));
      hudEls.boost.style.transform = `scaleX(${b.toFixed(3)})`;
      hudEls.boostwrap.classList.toggle('empty', b <= 0.001);
    }
  }

  // ---- minimap ----------------------------------------------------------
  function buildTransform(points: [number, number][]): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const pad = 16 * dpr;
    const w = MM * dpr;
    const h = MM * dpr;
    const spanX = maxX - minX || 1;
    const spanZ = maxZ - minZ || 1;
    const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanZ);
    const offX = (w - spanX * scale) / 2;
    const offZ = (h - spanZ * scale) / 2;
    mmTransform = {
      px: (x) => offX + (x - minX) * scale,
      // Flip Z so "forward" reads as up on the map.
      pz: (z) => h - (offZ + (z - minZ) * scale),
    };
  }

  /**
   * Render the circuit outline once into an offscreen canvas, then blit it
   * each frame under the car dots.
   *
   * The guard here used to be `if (!mmTransform)` - but mmTransform is only
   * assigned by buildTransform, on the very next line. So this returned
   * immediately, the outline was never drawn, mmTransform stayed null, and
   * setMinimap then bailed out before drawing the cars either. The minimap
   * rendered nothing at all, for the entire life of the project.
   */
  function cacheTrack(track: [number, number][]): void {
    if (!trackCtx || !track.length) return;
    buildTransform(track);
    const tf = mmTransform;
    if (!tf) return;
    const c = trackCtx;
    c.clearRect(0, 0, trackCanvas.width, trackCanvas.height);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    // Dark casing under the line so the circuit reads over bright regolith.
    c.strokeStyle = 'rgba(4, 8, 16, 0.55)';
    c.lineWidth = 5 * dpr;
    c.beginPath();
    track.forEach(([x, z], i) => {
      const px = tf.px(x);
      const py = tf.pz(z);
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    });
    c.closePath(); // it is a circuit
    c.stroke();
    c.strokeStyle = 'rgba(226,238,250,0.5)';
    c.lineWidth = 2 * dpr;
    c.stroke();

    // Start/finish tick, drawn square across the road.
    const a = track[0];
    const b = track[1] ?? track[0];
    const ax = tf.px(a[0]);
    const ay = tf.pz(a[1]);
    const bx = tf.px(b[0]);
    const by = tf.pz(b[1]);
    const ang = Math.atan2(by - ay, bx - ax) + Math.PI / 2;
    const len = 7 * dpr;
    c.strokeStyle = 'rgba(159, 212, 255, 0.95)';
    c.lineWidth = 2.5 * dpr;
    c.beginPath();
    c.moveTo(ax + Math.cos(ang) * len, ay + Math.sin(ang) * len);
    c.lineTo(ax - Math.cos(ang) * len, ay - Math.sin(ang) * len);
    c.stroke();
  }

  function setMinimap(data: MinimapData | null): void {
    if (!data || !mmCtx) return;
    const { track, cars } = data;
    if (track && track.length && track !== mmTrackRef) {
      mmTrackRef = track;
      cacheTrack(track);
    } else if (!mmTransform && cars.length) {
      buildTransform(cars.map((c) => [c.x, c.z] as [number, number]));
    }
    mmCtx.clearRect(0, 0, mmCanvas.width, mmCanvas.height);
    if (trackCanvas.width) mmCtx.drawImage(trackCanvas, 0, 0);
    const tf = mmTransform;
    if (!tf) return;

    // Rivals first, so the player marker always sits on top of the pack.
    for (const car of cars) {
      if (car.isPlayer) continue;
      mmCtx.beginPath();
      mmCtx.fillStyle = car.color || '#eef5fc';
      mmCtx.arc(tf.px(car.x), tf.pz(car.z), 2.6 * dpr, 0, Math.PI * 2);
      mmCtx.fill();
    }
    const me = cars.find((c) => c.isPlayer);
    if (me) {
      const x = tf.px(me.x);
      const y = tf.pz(me.z);
      mmCtx.beginPath();
      mmCtx.strokeStyle = 'rgba(159, 212, 255, 0.6)';
      mmCtx.lineWidth = 1.5 * dpr;
      mmCtx.arc(x, y, 6.5 * dpr, 0, Math.PI * 2);
      mmCtx.stroke();
      mmCtx.beginPath();
      mmCtx.fillStyle = '#9fd4ff';
      mmCtx.moveTo(x, y - 5 * dpr);
      mmCtx.lineTo(x + 5 * dpr, y);
      mmCtx.lineTo(x, y + 5 * dpr);
      mmCtx.lineTo(x - 5 * dpr, y);
      mmCtx.closePath();
      mmCtx.fill();
    }
  }

  // ---- keyboard ---------------------------------------------------------
  function onKey(e: KeyboardEvent): void {
    // Gameplay input is owned by the game loop; the menu only reacts when a
    // screen is actually up.
    if (active === 'none') return;
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        moveSelection(-1);
        break;
      case 'ArrowDown':
      case 's':
      case 'S':
        moveSelection(1);
        break;
      case 'ArrowLeft':
        cycleSelected(-1);
        break;
      case 'ArrowRight':
        cycleSelected(1);
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        confirmSelected();
        break;
      case 'Escape':
        goBack();
        break;
      default:
        handled = false;
    }
    if (handled) {
      // Consume the key so it cannot leak into gameplay.
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function firstGesture(): void {
    ensureAudio();
    window.removeEventListener('pointerdown', firstGesture);
    window.removeEventListener('keydown', firstGesture);
  }

  window.addEventListener('keydown', onKey);
  window.addEventListener('pointerdown', firstGesture);
  window.addEventListener('keydown', firstGesture);
  window.addEventListener('resize', sizeTelemetry);

  refreshValues();
  showScreen('main');
  sizeTelemetry();

  return {
    showScreen,
    showCountdown,
    showNotice,
    updateHud,
    setMinimap,
    setResults,
    setTelemetry,
    currentScreen: () => active,
    isPlaying: () => active === 'none',
    destroy() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', firstGesture);
      window.removeEventListener('keydown', firstGesture);
      window.removeEventListener('resize', sizeTelemetry);
      if (hintsTimer !== null) clearTimeout(hintsTimer);
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      if (rollTimer !== null) clearInterval(rollTimer);
      void audioCtx?.close();
      ui.innerHTML = '';
    },
  };
}

/** Names are data, not markup: never interpolate them into innerHTML raw. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
