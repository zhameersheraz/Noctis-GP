/**
 * NOCTIS GP - race director.
 *
 * Owns every rule in the game: the state machine, the fixed-step physics
 * clock, car-to-car contact, checkpoint and lap accounting, boost pads,
 * standings and the results classification.
 *
 * Deliberately free of DOM, cameras, dust emission and menu wiring, so the
 * exact code the browser runs can also be driven headlessly by
 * tools/race-sim.ts. Presentation reads this object's public state each
 * frame; it never writes to it.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/util';
import { LIVERIES } from '../core/liveries';
import type { Livery } from '../core/liveries';
import { CarSim } from './car';
import { AIController } from './ai';
import { ItemField } from './items';
import { NEUTRAL_INPUT } from './types';
import type { DriveInput, ItemKind, ResultsData, SimEnv, StandingRow } from './types';

export const LAPS = 3;
export const CAR_COUNT = 8;
export const CHECKPOINTS = 12;
const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 6;

/**
 * Catch-up tuning.
 *
 * A raw difficulty setting is the wrong tool for an arcade racer: the thing
 * that strands a new player is not that the AI is quick, it is that the pack
 * disappears over the horizon and there is nothing left to race. So instead of
 * making everyone slower, rivals close and open the gap by a few percent based
 * on where they are relative to the player.
 *
 * Deliberately asymmetric. Easing (10%) is stronger than pushing (3%), which
 * means a struggling player is helped more than a dominant one is punished,
 * and a car ahead of you can still win the race.
 */
const CATCHUP_RANGE = 700; // metres of gap before the effect is at full strength
const CATCHUP_EASE = 0.16;
const CATCHUP_PUSH = 0.05;

/**
 * How a car is built. The browser passes a factory that also creates the mesh,
 * shield and name tag; the headless verifier passes nothing and gets bare
 * simulation objects. This is the seam that keeps the rules render-agnostic.
 */
export type CarFactory = (livery: Livery, isPlayer: boolean, name: string) => CarSim;

export type RaceState = 'attract' | 'countdown' | 'race' | 'paused' | 'results';

export interface GridRow {
  name: string;
  color: string;
  isPlayer: boolean;
  x: number;
  z: number;
  s: number;
  lap: number;
  finished: boolean;
}

/** Optional presentation hook, used by main.ts to drive the menu. */
export interface RaceEvents {
  onCountdown?(text: string | null): void;
  onNotice?(text: string, ms: number): void;
  onResults?(data: ResultsData): void;
  onStateChange?(state: RaceState): void;
}

export class RaceDirector {
  readonly env: SimEnv;
  readonly items: ItemField;
  readonly cars: CarSim[] = [];
  player!: CarSim;

  state: RaceState = 'attract';
  clock = 0;
  bestLap: number | null = null;
  order: CarSim[] = [];
  playerInput: DriveInput = { ...NEUTRAL_INPUT };

  countdownT = 0;
  private prevCountdown = 0;
  private acc = 0;
  private standingsT = 0;
  private wrongWayT = 0;
  private noticeT = 0;
  private finishDelay = 0;
  private usedItemPrev = false;
  private events: RaceEvents = {};

  /**
   * Set each frame by the presenter. Return true on the frame the use-item key
   * goes down; the director edge-detects against the RETURN VALUE, never
   * against the existence of this function.
   */
  onItemRequested: (() => boolean) | null = null;

  /**
   * In a normal race the chequered flag falls when the PLAYER crosses the
   * line, and everyone still out on track is classified as running. The
   * verifier turns this off so it can prove that every car really can cover
   * the full three laps, rather than only the ones ahead of the player.
   */
  classifyOnPlayerFinish = true;

  /** Rival catch-up. Disabled by the verifier to measure its effect. */
  catchUp = true;

  private readonly carFactory: CarFactory;

  constructor(env: SimEnv, events: RaceEvents = {}, carFactory?: CarFactory) {
    this.env = env;
    this.events = events;
    this.carFactory = carFactory ?? ((livery, isPlayer, name) => new CarSim(null, { name, color: livery.color, isPlayer }));
    this.items = new ItemField(env);
    env.track.makeCheckpoints(CHECKPOINTS);
    this.spawnAttractPack();
  }

  setEvents(events: RaceEvents): void {
    this.events = events;
  }

  // ---- setup -------------------------------------------------------------

  private clearCars(): void {
    for (const c of this.cars) {
      if (c.mesh) this.env.scene.remove(c.mesh);
      if (c.shieldMesh) this.env.scene.remove(c.shieldMesh);
    }
    this.cars.length = 0;
  }

  private makeCar(livery: Livery, isPlayer: boolean, name?: string): CarSim {
    return this.carFactory(livery, isPlayer, name ?? livery.name);
  }

  /**
   * Attract mode runs two packs of four so the cinematic camera always has
   * traffic to frame, rather than one car on an empty circuit.
   */
  spawnAttractPack(): void {
    this.clearCars();
    const L = this.env.track.length;
    const packGap = 26;
    for (let i = 0; i < CAR_COUNT; i++) {
      const livery = LIVERIES[i];
      const sim = this.makeCar(livery, false);
      const pack = i < 4 ? 0 : 0.5;
      const s = (pack + 0.002) * L + (i % 4) * packGap;
      const f = this.env.track.frameAt(s % L);
      sim.placeAt(f, s % L, this.env.terrain);
      sim.totalDist = s % L;
      // NOT disabled: the attract pack has to actually drive, because the
      // cinematic camera is framing it in motion.
      sim.ai = new AIController(sim, { skill: 0.9 + (i % 4) * 0.035, boldness: 0.9 + (i % 3) * 0.05 });
      this.cars.push(sim);
    }
    this.player = this.cars[0];
  }

  private spawnRaceGrid(): void {
    this.clearCars();
    const L = this.env.track.length;
    const n = LIVERIES.length;
    for (let i = 0; i < n; i++) {
      const isPlayer = i === n - 1; // the player starts at the back
      const livery = LIVERIES[i];
      const sim = this.makeCar(livery, isPlayer, isPlayer ? 'YOU' : livery.name);
      const row = Math.floor(i / 2);
      const col = i % 2;
      const s = L - 16 - row * 7.5;
      const f = this.env.track.frameAt(s);
      const lat = col === 0 ? -4.2 : 4.2;
      sim.placeAt({ ...f, x: f.x + f.rx * lat, z: f.z + f.rz * lat }, s, this.env.terrain);
      sim.totalDist = s - L;
      sim.disabled = true;
      sim.idling = true;
      sim.ai = new AIController(sim, { skill: 0.92 + i * 0.013, boldness: 0.92 + ((i * 7) % 5) * 0.035 });
      this.cars.push(sim);
      if (isPlayer) this.player = sim;
    }
  }

  // ---- public API --------------------------------------------------------

  startRace(): void {
    this.env.audio.ensure();
    this.env.audio.duck(false);
    this.spawnRaceGrid();
    this.items.reset();
    this.state = 'countdown';
    this.countdownT = 3.9;
    this.prevCountdown = 4;
    this.clock = 0;
    this.acc = 0;
    this.bestLap = null;
    this.finishDelay = 0;
    this.wrongWayT = 0;
    this.noticeT = 0;
    this.usedItemPrev = false;
    for (const c of this.cars) {
      c.lap = 0;
      c.lapTimes = [];
      c.cpIndex = 0;
      c.finished = false;
      c.boost = 0.62;
      c.lapStart = 0;
      c.item = null;
      c.shieldT = 0;
      c.turboT = 0;
      c.stunT = 0;
      c.wrongWayT = 0;
      c.offRoadT = 0;
      c.stuckTimer = 0;
    }
    this.recomputeOrder();
    this.events.onStateChange?.(this.state);
  }

  pause(): void {
    if (this.state !== 'race' && this.state !== 'countdown') return;
    this.resumeTo = this.state;
    this.state = 'paused';
    this.env.audio.duck(true);
    this.events.onStateChange?.(this.state);
  }

  private resumeTo: RaceState = 'race';

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = this.resumeTo;
    this.env.audio.duck(false);
    this.events.onStateChange?.(this.state);
  }

  quitToMenu(): void {
    this.state = 'attract';
    this.env.audio.duck(true);
    this.spawnAttractPack();
    this.events.onCountdown?.(null);
    this.events.onStateChange?.(this.state);
  }

  resetPlayer(): void {
    if (this.state !== 'race') return;
    this.player.resetToTrack(this.env);
    this.player.disabled = false;
  }

  // ---- per-frame ---------------------------------------------------------

  update(dt: number): void {
    switch (this.state) {
      case 'attract':
        this.simulate(dt, 4);
        break;
      case 'countdown':
        this.updateCountdown(dt);
        break;
      case 'race':
        this.raceStep(dt);
        break;
      case 'results':
        // Slow-motion roll behind the results board.
        this.simulate(dt * 0.35, 4);
        break;
      case 'paused':
        break;
    }
  }

  /** Attract/results: AI only, no race logic. */
  private simulate(dt: number, maxSteps: number): void {
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < maxSteps) {
      for (const c of this.cars) {
        const ai = c.ai as AIController | null;
        c.step(ai ? ai.computeInput(this.env, this.cars) : NEUTRAL_INPUT, FIXED_DT, this.env);
      }
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps >= maxSteps) this.acc = 0; // spiral-of-death guard
  }

  private updateCountdown(dt: number): void {
    this.prevCountdown = Math.ceil(this.countdownT);
    this.countdownT -= dt;
    const now = Math.ceil(this.countdownT);
    if (now !== this.prevCountdown) {
      if (now >= 1 && now <= 3) {
        this.events.onCountdown?.(String(now));
        this.env.audio.countdown(now);
      } else if (now === 0) {
        this.events.onCountdown?.('GO');
        this.env.audio.countdown(0);
      }
    }
    // Hold the grid, but let the idle shimmer animate.
    for (const c of this.cars) {
      c.disabled = true;
      c.throttleViz = 0.05 + 0.03 * Math.sin(performance.now() * 0.01 + c.pos.x);
    }
    if (this.countdownT <= -0.55) {
      this.events.onCountdown?.(null);
      for (const c of this.cars) {
        c.disabled = false;
        c.idling = false;
        c.lapStart = 0;
      }
      this.state = 'race';
      this.clock = 0;
      this.events.onStateChange?.(this.state);
    }
  }

  private raceStep(dt: number): void {
    this.clock += dt;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.physicsSubstep(FIXED_DT);
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps >= MAX_SUBSTEPS) this.acc = 0;

    this.standingsT -= dt;
    if (this.standingsT <= 0) {
      this.standingsT = 0.25;
      this.recomputeOrder();
    }
    const pos = this.order.indexOf(this.player) + 1;

    // Wrong-way warning.
    const f = this.env.track.frameAt(this.player.s);
    const facing = Math.sin(this.player.yaw) * f.tx + Math.cos(this.player.yaw) * f.tz;
    if (facing < -0.3 && this.player.speed > 12) this.wrongWayT += dt;
    else this.wrongWayT = 0;
    this.noticeT -= dt;
    if (this.wrongWayT > 0.8 && this.noticeT <= 0) {
      this.events.onNotice?.('WRONG WAY', 1400);
      this.noticeT = 3;
    }

    // Item use is edge triggered, so holding the key fires exactly once.
    // The callback is INVOKED here: testing the reference itself would be
    // permanently true and the item would never fire at all.
    const useNow = this.onItemRequested ? !!this.onItemRequested() : false;
    if (useNow && !this.usedItemPrev && this.player.item && !this.player.finished) {
      this.items.useItem(this.player, this.cars);
    }
    this.usedItemPrev = useNow;

    this.items.update(dt, this.cars, (car) => this.order.indexOf(car) + 1, true);

    let near: CarSim | null = null;
    let nd = Infinity;
    for (const c of this.cars) {
      if (c === this.player) continue;
      const d = c.pos.distanceTo(this.player.pos);
      if (d < nd) {
        nd = d;
        near = c;
      }
    }
    this.env.audio.updateEngine(this.player, near ? { dist: nd, speed: near.speed } : null, dt);
    if (this.player.boosting && !this.wasBoosting) this.env.audio.whoosh();
    this.wasBoosting = this.player.boosting;

    if (this.player.finished && this.classifyOnPlayerFinish) {
      this.finishDelay -= dt;
      if (this.finishDelay <= 0) this.showResults();
    }
    void pos;
  }

  private wasBoosting = false;

  private physicsSubstep(dt: number): void {
    this.updateCatchUp();
    for (const c of this.cars) {
      let input: DriveInput;
      if (c === this.player && !this.env.autopilot) {
        input = c.disabled ? NEUTRAL_INPUT : this.playerInput;
      } else {
        const ai = c.ai as AIController | null;
        input = c.disabled || !ai ? NEUTRAL_INPUT : ai.computeInput(this.env, this.cars);
      }
      c.step(input, dt, this.env);
    }

    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        this.contact(this.cars[i], this.cars[j]);
      }
    }

    for (const c of this.cars) this.raceLogic(c);

    // Recovery: an AI that ends up facing the wrong way, off in the boulder
    // field, or wedged, is put back on the line rather than left stranded.
    for (const c of this.cars) {
      if (!c.ai || c.finished) continue;
      const f = this.env.track.frameAt(c.s);
      const facing = Math.sin(c.yaw) * f.tx + Math.cos(c.yaw) * f.tz;
      if (facing < -0.2 && c.speed > 8) c.wrongWayT += dt;
      else c.wrongWayT = 0;
      const nearSelf = this.env.track.nearestS(c.pos.x, c.pos.z);
      if (nearSelf.dist > nearSelf.frame.hw + 3) c.offRoadT += dt;
      else c.offRoadT = 0;
      if (c.wrongWayT > 4 || c.stuckTimer > 5 || c.offRoadT > 6) {
        c.resetToTrack(this.env);
        c.lastS = c.s;
        this.recomputeOrder();
      }
    }
  }

  /**
   * Give every rival a small pace adjustment from its gap to the player.
   *
   * Computed on arc distance, not raw coordinates, so a rival a lap behind is
   * correctly treated as "behind" rather than "ahead and far away".
   */
  private updateCatchUp(): void {
    if (!this.catchUp) return;
    const p = this.player;
    const L = this.env.track.length;
    for (const c of this.cars) {
      if (c === p || c.finished) continue;
      const ai = c.ai as AIController | null;
      if (!ai) continue;
      let gap = c.totalDist - p.totalDist;
      if (gap > L / 2) gap -= L;
      if (gap < -L / 2) gap += L;
      const t = Math.min(Math.abs(gap) / CATCHUP_RANGE, 1);
      ai.setCatchUp(gap > 0 ? 1 - CATCHUP_EASE * t : 1 + CATCHUP_PUSH * t);
    }
  }

  /**
   * Two contact circles per car, one at the nose and one at the tail, so a
   * 5.4 m car cannot pass through another the way a single small circle allows.
   */
  private contact(a: CarSim, b: CarSim): void {
    const OFF = 1.5;
    const R2 = 2.4;
    const ax = Math.sin(a.yaw) * OFF;
    const az = Math.cos(a.yaw) * OFF;
    const bx = Math.sin(b.yaw) * OFF;
    const bz = Math.cos(b.yaw) * OFF;
    for (const oa of [-1, 1]) {
      for (const ob of [-1, 1]) {
        const pax = a.pos.x + ax * oa;
        const paz = a.pos.z + az * oa;
        const pbx = b.pos.x + bx * ob;
        const pbz = b.pos.z + bz * ob;
        const dx = pbx - pax;
        const dz = pbz - paz;
        const d = Math.hypot(dx, dz);
        if (d >= R2 || d < 1e-3 || Math.abs(a.pos.y - b.pos.y) >= 1.6) continue;
        const nx = dx / d;
        const nz = dz / d;
        const push = (R2 - d) * 0.5;
        a.pos.x -= nx * push;
        a.pos.z -= nz * push;
        b.pos.x += nx * push;
        b.pos.z += nz * push;
        const rel = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
        if (rel < 0) {
          const imp = rel * 0.55;
          a.vel.x += nx * imp;
          a.vel.z += nz * imp;
          b.vel.x -= nx * imp;
          b.vel.z -= nz * imp;
          const hit = Math.min(0.5, -rel / 25);
          a.impact = Math.max(a.impact, hit);
          b.impact = Math.max(b.impact, hit);
        }
      }
    }
  }

  private raceLogic(c: CarSim): void {
    const track = this.env.track;
    const L = track.length;

    // Signed arc progress, wrapping across the line.
    let ds = c.s - c.lastS;
    if (ds > L / 2) ds -= L;
    if (ds < -L / 2) ds += L;
    if (Math.abs(ds) > 200) ds = 0; // ignore projection teleports
    c.totalDist += ds;

    if (ds > 0 && !c.finished) {
      const cps = track.checkpoints;
      const next = cps[c.cpIndex % cps.length];
      const nearSelf = track.nearestS(c.pos.x, c.pos.z);
      const onCorridor = nearSelf.dist < nearSelf.frame.hw + 9;
      let crossed: boolean;
      if (c.lastS <= c.s) crossed = next > c.lastS && next <= c.s;
      else crossed = next > c.lastS || next <= c.s; // wrapped the line

      if (crossed && onCorridor) {
        c.cpIndex++;
        if (c === this.player) this.env.audio.checkpoint();
      }

      if (c.lastS > L * 0.75 && c.s < L * 0.25 && onCorridor) {
        if (c.totalDist < L * 0.5) {
          // Opening crossing. The grid sits just behind the line, so the very
          // first pass STARTS lap 1: arm the checkpoints and sync the clock.
          c.cpIndex = 1;
          c.lapStart = this.clock;
        } else if (c.cpIndex >= cps.length) {
          c.lap++;
          const lapT = this.clock - c.lapStart;
          c.lapStart = this.clock;
          c.lapTimes.push(lapT);
          c.cpIndex = 1; // checkpoint 0 sits on the line, already passed
          if (c === this.player) {
            if (this.bestLap === null || lapT < this.bestLap) this.bestLap = lapT;
            this.env.audio.checkpoint();
          }
          if (c.lap >= LAPS && !c.finished) {
            c.finished = true;
            c.finishTime = this.clock;
            if (c === this.player) {
              this.finishDelay = 2.6;
              this.env.audio.finish();
              this.events.onNotice?.('FINISH', 2200);
            }
          }
        } else if (c === this.player && this.noticeT <= 0) {
          this.events.onNotice?.('MISSED CHECKPOINT', 1500);
          this.noticeT = 3;
        }
      }
    }
    c.lastS = c.s;

    this.applyBoostPads(c);
  }

  private applyBoostPads(c: CarSim): void {
    const track = this.env.track;
    const L = track.length;
    if (c.boost < 0.999) {
      for (const pad of track.chevrons) {
        let d = Math.abs(c.s - pad.s);
        if (d > L - d) d = L - d;
        if (d >= 7 || !c.grounded) continue;
        const dx = c.pos.x - pad.x;
        const dz = c.pos.z - pad.z;
        if (dx * dx + dz * dz >= 64) continue;
        if (c.padCooldown === pad.s) continue;
        c.boost = Math.min(1, c.boost + 0.5);
        c.boostFlash = 1;
        c.padCooldown = pad.s;
        if (c === this.player) this.env.audio.boostPad();
        if (pad.mesh) (pad.mesh.material as THREE.Material & { opacity: number }).opacity = 1.4;
      }
    }
    // Pads re-arm once the car is well past them.
    for (const pad of track.chevrons) {
      let d = Math.abs(c.s - pad.s);
      if (d > L - d) d = L - d;
      if (d > 30 && c.padCooldown === pad.s) c.padCooldown = -1;
    }
  }

  private recomputeOrder(): void {
    this.order = this.cars.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.totalDist - a.totalDist;
    });
  }

  private showResults(): void {
    this.state = 'results';
    this.recomputeOrder();
    const leaderT = this.order[0].finishTime || this.clock;
    this.events.onResults?.({
      position: this.order.indexOf(this.player) + 1,
      total: this.cars.length,
      totalTime: this.player.finishTime,
      bestLap: this.bestLap,
      laps: this.player.lapTimes,
      standings: this.order.map((c) => ({
        name: c.name,
        time: c.finished ? c.finishTime : null,
        gap: c.finished ? c.finishTime - leaderT : null,
        isPlayer: c === this.player,
      })),
    });
    this.events.onStateChange?.(this.state);
  }

  // ---- read-only views for the presenter ---------------------------------

  get playerPosition(): number {
    return this.order.indexOf(this.player) + 1;
  }

  get raceProgress(): number {
    return clamp01((this.player.totalDist + this.env.track.length) / (this.env.track.length * LAPS));
  }

  hudStandings(): StandingRow[] {
    return this.order.map((c) => ({
      name: c.name,
      color: '#' + new THREE.Color(c.color).getHexString(),
      lap: Math.min(LAPS, c.lap + (c.finished ? 0 : 1)),
      me: c === this.player,
      finished: c.finished,
    }));
  }

  get playerItem(): ItemKind {
    return this.player.item;
  }

  /** Debug/verification hook: the current grid, for headless assertions. */
  grid(): GridRow[] {
    return this.cars.map((c) => ({
      name: c.name,
      color: '#' + new THREE.Color(c.color).getHexString(),
      isPlayer: c.isPlayer,
      x: +c.pos.x.toFixed(2),
      z: +c.pos.z.toFixed(2),
      s: +c.s.toFixed(1),
      lap: c.lap,
      finished: c.finished,
    }));
  }
}
