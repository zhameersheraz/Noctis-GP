/**
 * NOCTIS GP - bootstrap.
 *
 * Order of operations matters here:
 *   1. build the track, then mark the launch ramp on it,
 *   2. build the terrain around that ramp,
 *   3. grade the road onto the terrain and carve it in,
 *   4. only then build any geometry, because every mesh samples the same
 *      heightfield the physics does.
 *
 * The loop keeps three concerns separate: RaceDirector owns the rules, this
 * file owns the frame (input, presentation, render), and the Menu owns the
 * DOM.
 */

import * as THREE from 'three';

import { clamp } from './core/util';
import { Track } from './sim/track';
import { Terrain } from './sim/terrain';
import { RaceDirector, LAPS, CAR_COUNT } from './sim/race';
import { CarSim } from './sim/car';
import { makeShieldMesh } from './sim/items';
import type { DriveInput, Settings, SimEnv } from './sim/types';
import { RaceAudio } from './audio/raceAudio';
import { World, QUALITY } from './render/world';
import { createSky } from './render/sky';
import { ChaseCam, CinematicCam } from './render/cameras';
import { Dust } from './render/dust';
import { makeCarMesh, makeNameTag } from './render/carMesh';
import { createMenu } from './ui/menu';
import { createTouchControls } from './ui/touch';
import type { Livery } from './core/liveries';

const SETTINGS_KEY = 'noctis-settings';
const params = new URLSearchParams(location.search);

// ---- loading overlay ------------------------------------------------------
const loader = document.createElement('div');
loader.className = 'loader';
loader.textContent = 'INITIALIZING';
document.body.appendChild(loader);
const setLoad = (t: string): void => {
  loader.textContent = t;
};
const yieldFrame = (): Promise<void> => new Promise((r) => setTimeout(r, 16));

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      quality: raw.quality === 'LOW' || raw.quality === 'MEDIUM' ? raw.quality : 'HIGH',
      sound: typeof raw.sound === 'boolean' ? raw.sound : true,
    };
  } catch {
    return { quality: 'HIGH', sound: true };
  }
}

async function boot(): Promise<void> {
  const settings = loadSettings();
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('#scene canvas missing from index.html');

  // A WebGL2 check up front gives a readable message instead of a blank page.
  if (!canvas.getContext('webgl2') && !canvas.getContext('webgl')) {
    throw new Error('This browser cannot create a WebGL context.');
  }

  const world = new World(canvas, QUALITY[settings.quality], {
    preserveDrawingBuffer: params.get('capture') === '1',
  });
  if (world.isSoftware) {
    setLoad('NO GPU DETECTED - REDUCED EFFECTS');
  }

  // ---- world --------------------------------------------------------------
  setLoad('SURVEYING SERENITATIS');
  await yieldFrame();

  const track = new Track().build(2).buildHash().markLaunchRamp();
  const terrain = new Terrain();
  terrain.buildNatural(track);
  await yieldFrame();

  setLoad('GRADING THE CIRCUIT');
  track.setHeightsFromTerrain(terrain);
  terrain.carve(track);
  await yieldFrame();

  setLoad('SINTERING THE REGOLITH');
  world.scene.add(terrain.buildMesh());
  await yieldFrame();
  world.scene.add(track.buildMeshes(terrain));
  terrain.buildBoulders(world.scene, track);
  await yieldFrame();

  setLoad('RAISING THE SKY');
  const sky = createSky(world.scene, world.renderer);
  world.buildEnvironment(sky.sunDirection);

  const audio = new RaceAudio();
  audio.setEnabled(settings.sound);
  const dust = new Dust(world.scene);
  dust.setPixelRatio(world.pixelRatio);

  // ---- race director ------------------------------------------------------
  const env: SimEnv = {
    scene: world.scene,
    camera: world.camera,
    terrain,
    track,
    audio,
    dust,
    autopilot: params.get('demo') === '1',
    menu: null,
    markBloom: (root) => world.markBloom(root),
  };

  /**
   * Car factory. The director asks for a car; we hand back one that also has
   * its mesh, shield bubble and name tag, all flagged onto the bloom layer.
   */
  const carFactory = (livery: Livery, isPlayer: boolean, name: string): CarSim => {
    const mesh = makeCarMesh(livery, isPlayer);
    world.scene.add(mesh);
    world.markBloom(mesh);
    const sim = new CarSim(mesh, { name, color: livery.color, isPlayer });
    const shield = makeShieldMesh();
    mesh.add(shield);
    sim.shieldMesh = shield;
    if (!isPlayer) {
      const tag = makeNameTag(livery.name, livery.color);
      mesh.add(tag);
      sim.tag = tag;
    }
    return sim;
  };

  const chase = new ChaseCam(world.camera);
  const cine = new CinematicCam(world.camera, track, terrain);

  let minimapTrack: [number, number][] | null = null;

  const director = new RaceDirector(
    env,
    {
      onCountdown: (t) => menu?.showCountdown(t),
      onNotice: (t, ms) => menu?.showNotice(t, ms),
      onResults: (d) => {
        menu?.setResults(d);
        menu?.updateHud({ visible: false });
        menu?.showScreen('results');
      },
    },
    carFactory,
  );
  chase.snap(director.player, terrain);

  {
    const pts: [number, number][] = [];
    const step = Math.max(1, Math.floor(track.count / 220));
    for (let i = 0; i < track.count; i += step) pts.push([track.samples.px[i], track.samples.pz[i]]);
    minimapTrack = pts;
  }

  // ---- menu ---------------------------------------------------------------
  const menu = createMenu({
    onStartRace: () => {
      director.startRace();
      chase.snap(director.player, terrain);
      menu.showScreen('none');
    },
    onResume: () => director.resume(),
    onRestart: () => {
      director.startRace();
      chase.snap(director.player, terrain);
      menu.showScreen('none');
    },
    onQuitToMenu: () => {
      director.quitToMenu();
      menu.updateHud({ visible: false });
      menu.showScreen('main');
    },
    onSettingChanged: (s) => {
      settings.quality = s.quality;
      settings.sound = s.sound;
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        /* private browsing: fine, settings just do not persist */
      }
      audio.setEnabled(s.sound);
      world.applyQuality(s.quality);
      dust.setPixelRatio(world.pixelRatio);
    },
    getSettings: () => settings,
    getRaceInfo: () => ({ trackKm: track.length / 1000 }),
  });
  env.menu = menu;
  director.items.setAiUsePolicy((car) => !car.isPlayer || env.autopilot);

  // ---- input --------------------------------------------------------------
  const keys: Record<string, boolean> = {};
  const INPUT_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'ShiftLeft', 'ShiftRight', 'Space', 'KeyR', 'KeyQ', 'KeyE', 'Escape',
  ]);
  window.addEventListener(
    'keydown',
    (e) => {
      if (INPUT_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      keys[e.code] = true;
      if (e.code === 'Escape') {
        if (director.state === 'race' || director.state === 'countdown') {
          director.pause();
          menu.showScreen('pause');
        } else if (director.state === 'paused') {
          director.resume();
          menu.showScreen('none');
        }
      }
      if (e.code === 'KeyR' && director.state === 'race') director.resetPlayer();
    },
    { passive: false },
  );
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
  });

  // Analog steering so a tap is a correction and a hold is full lock.
  let steerAnalog = 0;
  const input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
  function readInput(dt: number): DriveInput {
    input.throttle = keys.KeyW || keys.ArrowUp ? 1 : 0;
    input.brake = keys.KeyS || keys.ArrowDown ? 1 : 0;
    // A positive sim yaw turns the car toward screen-LEFT from the chase
    // camera, so A/Left is positive and D/Right negative.
    const target = (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
    const rate = target !== 0 && Math.sign(target) !== Math.sign(steerAnalog) ? 9 : target !== 0 ? 5.5 : 9;
    const d = target - steerAnalog;
    steerAnalog += Math.sign(d) * Math.min(Math.abs(d), rate * dt);
    input.steer = clamp(steerAnalog, -1, 1);
    input.handbrake = !!keys.Space;
    input.boost = !!(keys.ShiftLeft || keys.ShiftRight);
    // Touch is merged on top, never instead: a player with a keyboard and a
    // touchscreen can use both at once.
    return touch.applyTo(input);
  }

  // ---- touch controls -----------------------------------------------------
  // Owns its own DOM and knows nothing about the game. It only reports which
  // controls are held, which is why the same code path works for mouse, pen
  // and finger.
  const touch = createTouchControls({
    onPause: () => {
      if (director.state === 'race' || director.state === 'countdown') {
        director.pause();
        menu.showScreen('pause');
      } else if (director.state === 'paused') {
        director.resume();
        menu.showScreen('none');
      }
    },
  });

  // Portrait phones get a nudge rather than a blocker; the game still runs.
  const uiRoot = document.getElementById('ui') ?? document.body;
  const rotateHint = document.createElement('div');
  rotateHint.className = 'rotate-hint';
  rotateHint.textContent = 'Turn your device sideways for more road';
  uiRoot.appendChild(rotateHint);

  // ---- resize -------------------------------------------------------------
  window.addEventListener('resize', () => world.resize(window.innerWidth, window.innerHeight));

  // ---- diagnostics hooks (used by automated playtests) -------------------
  /**
   * Advance the simulation without waiting for a rendered frame.
   *
   * This runs the SAME input read and the SAME RaceDirector.update the render
   * loop uses, so an automated playtest that drives this is testing the real
   * game, not a shortcut. It exists because on a CPU rasteriser a single
   * frame can take seconds, which makes real-time keyboard testing impossible.
   */
  /**
   * Edge-triggered use-item request, shared by the render loop and stepSim.
   *
   * Defined once because the two call sites had already drifted: the loop
   * learned about touch and stepSim did not, which meant an automated touch
   * test drove the car but could not make it fire a power-up.
   */
  const itemRequested = (): boolean =>
    !!(keys.KeyQ || keys.KeyE) || touch.consumeItemTap();

  function stepSim(steps = 1, dt = 1 / 60): void {
    for (let i = 0; i < steps; i++) {
      const racing = director.state === 'race' || director.state === 'countdown';
      director.playerInput = racing ? readInput(dt) : { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
      director.onItemRequested = racing ? itemRequested : null;
      director.update(dt);
    }
  }

  Object.assign(window as unknown as Record<string, unknown>, {
    __fps: 0,
    __errors: [] as string[],
    __game: director,
    NOCTIS: {
      world,
      track,
      terrain,
      director,
      audio,
      menu,
      sky,
      THREE,
      stepSim,
      keys,
      touch,
      /**
       * Teleport the chase camera onto the car. The camera is damped, so
       * after a simulation fast-forward it would otherwise still be catching
       * up when an automated test looks at it.
       */
      snapCamera: () => chase.snap(director.player, terrain),
    },
  });
  window.addEventListener('error', (e) => {
    (window as unknown as { __errors: string[] }).__errors.push(String(e.message));
  });

  // ---- loop ---------------------------------------------------------------
  const clock = new THREE.Clock();
  let elapsed = 0;
  let fpsT = 0;
  let fpsN = 0;
  const focus = new THREE.Vector3();

  function frame(): void {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, clock.getDelta());
    elapsed += dt;

    const racing = director.state === 'race' || director.state === 'countdown';
    director.playerInput = racing ? readInput(dt) : { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
    // Edge triggered in the director, so this reports the instant a use-item
    // input appears - a key press or a latched touch tap.
    director.onItemRequested = racing ? itemRequested : null;

    director.update(dt);
    sky.update(dt, elapsed);

    // Meshes, dust and name tags follow the simulation every frame.
    const now = performance.now() / 1000;
    for (const c of director.cars) {
      c.syncMesh(dt, now);
      dust.emitFromCar(c, dt, terrain);
      if (c.tag) {
        if (director.state === 'attract') {
          c.tag.material.opacity = 0;
        } else {
          const d = c.mesh ? c.mesh.position.distanceTo(world.camera.position) : 9999;
          // Sprites ignore depth, so a distant car's tag would otherwise float
          // over the HUD as a stray glyph. Fade them out much sooner.
          const near = touch.supported ? 40 : 110;
          const span = touch.supported ? 90 : 340;
          (c.tag.material as THREE.SpriteMaterial).opacity = c === director.player ? 0 : clamp01(1 - (d - near) / span) * 0.95;
        }
      }
    }
    dust.update(dt, terrain);

    for (const pad of track.chevrons) {
      if (!pad.mesh) continue;
      const mat = pad.mesh.material as THREE.Material & { opacity: number };
      if (mat.opacity > 0.95) mat.opacity = Math.max(0.95, mat.opacity - dt * 1.2);
    }

    // ---- camera + HUD ----------------------------------------------------
    if (director.state === 'race' || director.state === 'countdown') {
      chase.update(dt, director.player, terrain);
      pushHud();
    } else {
      // Attract and results run the cinematic camera on the pack leader.
      let lead = director.cars[0];
      for (const c of director.cars) if (c.totalDist > lead.totalDist) lead = c;
      cine.update(dt, lead);
      if (director.state === 'attract') {
        menu.setTelemetry(lead.s, lead.speedKmh, track.length);
      } else {
        menu.setTelemetry(director.player.s, director.player.speedKmh, track.length);
      }
    }

    focus.copy(director.state === 'attract' || director.state === 'results' ? world.camera.position : director.player.pos);
    world.focusShadows(focus, sky.sunDirection);
    world.render();

    fpsN++;
    fpsT += dt;
    if (fpsT >= 1) {
      (window as unknown as { __fps: number }).__fps = Math.round(fpsN / fpsT);
      fpsN = 0;
      fpsT = 0;
    }
  }

  function pushHud(): void {
    const p = director.player;
    menu.updateHud({
      visible: true,
      speedKmh: p.speedKmh,
      lap: p.finished ? LAPS : Math.min(LAPS, p.lap + 1),
      lapsTotal: LAPS,
      position: director.playerPosition,
      total: CAR_COUNT,
      clock: director.clock,
      bestLap: director.bestLap,
      boost: p.boost,
      raceProgress: director.raceProgress,
      drift: p.slip > 0.45,
      item: p.item,
      standings: director.hudStandings(),
    });
    // Keep the on-screen buttons honest about what is usable right now.
    touch.setBoost(p.boost);
    touch.setItem(p.item);
    touch.setPaused(false);
    if (minimapTrack) {
      menu.setMinimap({
        track: minimapTrack,
        cars: director.cars.map((c) => ({
          x: c.pos.x,
          z: c.pos.z,
          isPlayer: c === p,
          color: `#${new THREE.Color(c.color).getHexString()}`,
        })),
      });
    }
  }

  // First frame, then reveal.
  director.update(0.016);
  sky.update(0.016, 0);
  for (const c of director.cars) c.syncMesh(0.016, 0);
  cine.update(0.016, director.cars[0]);
  world.focusShadows(world.camera.position, sky.sunDirection);
  world.render();

  menu.showScreen('main');
  loader.style.opacity = '0';
  setTimeout(() => loader.remove(), 900);

  if (params.get('race') === '1') {
    // Auto-start, for soak testing and automated playtests.
    setTimeout(() => {
      director.startRace();
      chase.snap(director.player, terrain);
      menu.showScreen('none');
    }, 500);
  }

  frame();
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

boot().catch((e: unknown) => {
  console.error(e);
  loader.textContent = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  loader.classList.add('error');
  (window as unknown as { __bootError?: string }).__bootError = String(
    e instanceof Error ? e.stack ?? e.message : e,
  );
});
