/**
 * Headless full-race verification.
 *
 *   npm run verify:race
 *
 * Drives the real RaceDirector with the real Terrain, Track, CarSim,
 * AIController and ItemField - no rendering, no DOM, no browser - and asserts
 * that a full three-lap race is actually completable and behaves.
 *
 * This is the check that catches the bugs geometry review cannot: an AI that
 * cannot get round the pit, a jump that traps the car, a checkpoint rule that
 * silently never fires, an item that soft-locks a driver.
 */

import * as THREE from 'three';
import { Track } from '../src/sim/track';
import { Terrain } from '../src/sim/terrain';
import { RaceDirector, LAPS, CAR_COUNT } from '../src/sim/race';
import { AIController } from '../src/sim/ai';
import { RaceAudio } from '../src/audio/raceAudio';
import { Dust } from '../src/render/dust';
import type { SimEnv, ResultsData } from '../src/sim/types';

const f = (v: number, d = 2): string => v.toFixed(d);

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label.padEnd(36)} ${detail}`);
}

console.log('\n=== NOCTIS GP - full race verification ===\n');

// ---- world ---------------------------------------------------------------
const track = new Track().build(2).buildHash().markLaunchRamp();
const terrain = new Terrain();
terrain.buildNatural(track);
track.setHeightsFromTerrain(terrain);
terrain.carve(track);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 90000);
const audio = new RaceAudio();
const dust = new Dust(scene);
const env: SimEnv = { scene, camera, terrain, track, audio, dust, autopilot: true, menu: null };

let results: ResultsData | null = null;
const notices: string[] = [];
const director = new RaceDirector(env, {
  onResults: (d) => {
    results = d;
    resultBox.value = d;
  },
  onNotice: (t) => notices.push(t),
  onStateChange: (s) => {
    if (s === 'race') console.log('  lights out\n');
  },
});
// TS narrows `results` to null inside this scope; keep a boxed view for the
// assertions further down, which run after the loop.
const resultBox: { value: ResultsData | null } = { value: null };

// ---- start ---------------------------------------------------------------
director.startRace();
const grid = director.grid();
check('grid has a full field', grid.length === CAR_COUNT, `${grid.length} cars`);
check('player starts at the back', grid.filter((g) => g.isPlayer).length === 1, grid.filter((g) => g.isPlayer).map((g) => `${g.name} P${grid.indexOf(g) + 1}`).join());

// ---- run the race --------------------------------------------------------
const DT = 1 / 60;
const MAX_SECONDS = 600;
let t = 0;
let maxSpeed = 0;
let maxAir = 0;
let airEvents = 0;
let wasAir = false;
let offRoadFrames = 0;
let totalFrames = 0;
let maxOffroadDist = 0;
let rampJumps = 0;
let nan = false;

const startL = track.length;

while (t < MAX_SECONDS && !results) {
  director.update(DT);
  t += DT;
  totalFrames++;

  for (const c of director.cars) {
    if (!Number.isFinite(c.pos.x + c.pos.y + c.pos.z + c.vel.x + c.vel.y + c.vel.z)) nan = true;
    if (c.isPlayer) {
      maxSpeed = Math.max(maxSpeed, c.speed);
      maxAir = Math.max(maxAir, c.airTime);
      if (c.airTime > 0.3 && !wasAir) {
        airEvents++;
        // Was this jump the designed ramp?
        const d = Math.abs(c.s - track.launchS);
        const wrapped = Math.min(d, startL - d);
        if (wrapped < 60) rampJumps++;
      }
      wasAir = c.airTime > 0.3;
      if (c.offroad > 0.5) offRoadFrames++;
      const near = track.nearestS(c.pos.x, c.pos.z);
      maxOffroadDist = Math.max(maxOffroadDist, near.dist - near.frame.hw);
    }
  }
  if (results) break;
}

const p = director.player;
const order = director.order;
const winner = order[0];

console.log('  --- field ---');
for (let i = 0; i < order.length; i++) {
  const c = order[i];
  const t = c.finished ? `${f(c.finishTime)}s` : `lap ${c.lap + 1}, DNF`;
  const best = c.lapTimes.length ? ` best ${f(Math.min(...c.lapTimes))}s` : '';
  console.log(
    `  ${String(i + 1).padStart(2)}. ${c.name.padEnd(6)} ${String(t).padStart(14)}${best.padEnd(14)} laps=[${c.lapTimes.map((x) => f(x, 1)).join(', ')}]`,
  );
}

console.log('\n  --- telemetry ---');
console.log(`  race duration    ${f(t, 1)} s of simulated time`);
console.log(`  player top speed ${f(maxSpeed * 3.6, 1)} km/h (${f(maxSpeed, 1)} m/s)`);
console.log(`  longest airtime  ${f(maxAir, 2)} s, ${airEvents} jump${airEvents === 1 ? '' : 's'}`);
console.log(`  ramp jumps taken ${rampJumps}`);
console.log(`  off-road frames  ${offRoadFrames} (${((offRoadFrames / totalFrames) * 100).toFixed(1)}% of the race)`);
console.log(`  furthest off     ${f(maxOffroadDist, 1)} m beyond the white line`);
console.log(`  player laps      ${p.lapTimes.length} times: [${p.lapTimes.map((x) => f(x, 1)).join(', ')}]`);
console.log(`  best lap         ${director.bestLap === null ? 'n/a' : `${f(director.bestLap)} s`}`);
console.log(`  checkpoints      final cpIndex ${p.cpIndex} of ${track.checkpoints.length}\n`);

check('race reached the results screen', resultBox.value !== null, resultBox.value ? `classified after ${f(t, 1)}s` : `no result after ${MAX_SECONDS}s`);
check('no NaN in the physics', !nan, nan ? 'car state went non-finite' : 'all finite');
check('winner completed all laps', winner.lap >= LAPS, `${winner.name} finished ${winner.lap} lap(s)`);
check('player completed the race', p.finished, p.finished ? `P${director.playerPosition} in ${f(p.finishTime)}s` : `player stopped on lap ${p.lap + 1}`);
// The flag falls when the player finishes, so cars still circulating are
// classified as running rather than as failures. What must hold is that
// nobody was stranded.
const running = director.cars.filter((c) => !c.finished);
check('nobody is stranded when the flag falls', running.every((c) => c.lap >= LAPS - 1 && c.speed > 5), `${running.length} still running, all on the final lap and moving`);
check('classification covers the whole field', (resultBox.value?.standings.length ?? 0) === CAR_COUNT, `${resultBox.value?.standings.length ?? 0}/${CAR_COUNT} classified`);
check('lap times are recorded', p.lapTimes.length === LAPS, `${p.lapTimes.length} lap times`);

const laps = p.lapTimes;
if (laps.length === LAPS) {
  const fastest = Math.min(...laps);
  const slowest = Math.max(...laps);
  const spread = slowest - fastest;
  check('lap times are plausible', fastest > 60 && slowest < 400, `${f(fastest, 1)}s to ${f(slowest, 1)}s`);
  check('lap times are consistent', spread < fastest * 0.5, `${f(spread, 1)}s spread over ${LAPS} laps`);
} else {
  check('lap times are plausible', false, `only ${laps.length} laps completed`);
}

check('car reaches racing speed', maxSpeed > 45, `${f(maxSpeed * 3.6, 1)} km/h top speed`);
check('AI stays on the circuit', maxOffroadDist < 60, `furthest ${f(maxOffroadDist, 1)} m off the white line`);
check('AI rarely leaves the road', offRoadFrames / totalFrames < 0.25, `${((offRoadFrames / totalFrames) * 100).toFixed(1)}% of frames off-road`);
check('the launch ramp is usable', airEvents >= 1, `${airEvents} airborne moments, ${rampJumps} of them on the ramp`);
check('no missed-checkpoint spam', notices.filter((n) => n === 'MISSED CHECKPOINT').length < 6, `${notices.filter((n) => n === 'MISSED CHECKPOINT').length} notices`);

// ---- field spread --------------------------------------------------------
{
  const finishes = director.cars.filter((c) => c.finished).map((c) => c.finishTime);
  if (finishes.length > 1) {
    const spread = Math.max(...finishes) - Math.min(...finishes);
    // A field finishing within a few seconds of each other means the AI
    // skill spread is doing something; a field finishing minutes apart means
    // some cars are getting stuck somewhere.
    check('field finishes together', spread < 90, `${f(spread, 1)}s between first and last`);
  } else {
    check('field finishes together', false, 'not enough finishers to judge');
  }
}

// ---- attract mode sanity -------------------------------------------------
{
  director.quitToMenu();
  let attractOk = true;
  let furthest = 0;
  const startS = director.cars.map((c) => c.s);
  for (let i = 0; i < 600; i++) {
    director.update(DT);
    for (const c of director.cars) {
      if (!Number.isFinite(c.pos.x + c.pos.y + c.pos.z)) attractOk = false;
      const near = track.nearestS(c.pos.x, c.pos.z);
      if (near.dist > near.frame.hw + 30) attractOk = false;
    }
  }
  for (let i = 0; i < director.cars.length; i++) {
    let d = director.cars[i].s - startS[i];
    if (d > track.length / 2) d -= track.length;
    if (d < -track.length / 2) d += track.length;
    furthest = Math.max(furthest, d);
  }
  check('attract mode is stable', attractOk, 'AI circulate the circuit for 10 s without straying');
  // The attract pack has to be genuinely DRIVING: the cinematic camera is
  // framing it in motion, so a frozen pack is a visible bug.
  check('attract pack is actually driving', furthest > 100,
        `leader covered ${f(furthest, 0)} m of road in 10 s`);
}

// ---- restart determinism -------------------------------------------------
{
  director.startRace();
  const g2 = director.grid();
  const sameGrid =
    g2.length === grid.length && g2.every((c, i) => Math.abs(c.s - grid[i].s) < 0.01 && c.name === grid[i].name);
  check('restart produces the same grid', sameGrid, `${g2.length} cars re-grided`);
  for (let i = 0; i < 300; i++) director.update(DT);
  check('cars leave the grid', director.cars.every((c) => c.speed > 1), `min speed ${f(Math.min(...director.cars.map((c) => c.speed)), 1)} m/s`);
}

// ---- full-distance run: can EVERY car actually cover three laps? ---------
// The race above ends when the player finishes, so it only proves the front
// of the field can complete the distance. This run keeps going until all
// eight cars have taken the flag.
{
  const env2: SimEnv = { scene: new THREE.Scene(), camera, terrain, track, audio: new RaceAudio(), dust: new Dust(new THREE.Scene()), autopilot: true, menu: null };
  const full = new RaceDirector(env2);
  full.classifyOnPlayerFinish = false;
  full.startRace();
  let elapsed = 0;
  while (elapsed < 900 && !full.cars.every((c) => c.finished)) {
    full.update(DT);
    elapsed += DT;
  }
  const stragglers = full.cars.filter((c) => !c.finished);
  console.log('\n  --- full distance ---');
  console.log(`  elapsed           ${f(elapsed, 1)} s`);
  console.log(`  finished          ${CAR_COUNT - stragglers.length}/${CAR_COUNT}`);
  console.log(`  slowest car       ${f(Math.max(...full.cars.map((c) => c.finishTime || Infinity)), 1)} s`);
  console.log(`  spread            ${f(Math.max(...full.cars.map((c) => c.finishTime)) - Math.min(...full.cars.map((c) => c.finishTime)), 1)} s\n`);
  check('every car completes three laps', stragglers.length === 0, stragglers.length ? `${stragglers.map((c) => c.name).join(', ')} did not finish` : `all ${CAR_COUNT} took the flag`);
  check('full field finishes within a race distance', elapsed < 700, `${f(elapsed, 1)} s of racing`);
}

// ---- catch-up: does a weak player keep the pack in sight? -----------------
// A raw difficulty setting is the wrong lever, so the shipped system is
// catch-up instead. This measures it: run the same weak player with it on and
// off, and require the gap to the leader to actually shrink.
{
  const trial = (catchUp: boolean, skill: number): { maxGap: number; finish: number } => {
    const d = new RaceDirector({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000),
      terrain,
      track,
      audio: new RaceAudio(),
      dust: new Dust(new THREE.Scene()),
      autopilot: true,
      menu: null,
    });
    d.catchUp = catchUp;
    d.classifyOnPlayerFinish = false;
    d.startRace();
    // A "beginner" is modelled honestly: the same driver logic, driven worse.
    const pa = d.player.ai as AIController;
    pa.skill = skill;
    pa.boldness = skill;
    let maxGap = 0;
    // 700 s, not 400: a car at 88% pace needs ~400 s just for three laps, so a
    // shorter budget measures the clock rather than the catch-up.
    for (let i = 0; i < 60 * 700; i++) {
      // Neutralise power-ups for this trial. Rockets, bananas and stuns are
      // random, and a single stun can cost more than the whole catch-up
      // effect, which makes the measurement useless.
      for (const c of d.cars) c.item = null;
      d.update(1 / 60);
      let lead = -Infinity;
      for (const c of d.cars) if (c !== d.player) lead = Math.max(lead, c.totalDist);
      if (Number.isFinite(lead)) maxGap = Math.max(maxGap, lead - d.player.totalDist);
      if (d.cars.every((c) => c.finished)) break;
    }
    const me = d.player;
    return { maxGap, finish: me.finished ? me.finishTime : Infinity };
  };

  const off = trial(false, 0.88);
  const on = trial(true, 0.88);
  console.log('\n  --- catch-up (player driving at 88% of normal pace) ---');
  console.log(`    catch-up OFF   worst gap to the leader ${f(off.maxGap, 0)} m`);
  console.log(`    catch-up ON    worst gap to the leader ${f(on.maxGap, 0)} m`);
  console.log(`    player finished: ${on.finish === Infinity ? 'DNF' : f(on.finish, 1) + 's'}\n`);

  check('catch-up actually changes the race', Math.abs(off.maxGap - on.maxGap) > 100,
        `gap moves ${f(off.maxGap - on.maxGap, 0)} m`);
  check('catch-up keeps a weak player in touch', on.maxGap < 900 && on.maxGap < off.maxGap * 0.6,
        `worst gap ${f(on.maxGap, 0)} m vs ${f(off.maxGap, 0)} m without it`);
  check('a weak player still finishes', on.finish !== Infinity, `${f(on.finish, 1)}s`);
  // A rival ahead must still be able to win: catch-up is a hand, not a magnet.
  const winner = ((): string => {
    const d = new RaceDirector({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000),
      terrain, track, audio: new RaceAudio(), dust: new Dust(new THREE.Scene()),
      autopilot: true, menu: null,
    });
    d.catchUp = true;
    d.classifyOnPlayerFinish = false;
    d.startRace();
    for (let i = 0; i < 60 * 600; i++) {
      for (const c of d.cars) c.item = null;
      d.update(1 / 60);
      if (d.cars.every((c) => c.finished)) break;
    }
    return d.order[0].name;
  })();
  check('catch-up does not hand the race to the player', winner !== 'YOU', `winner was ${winner}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
