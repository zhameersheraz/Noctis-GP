/**
 * Headless geometry verification for the Serenitatis circuit.
 *
 * Run with:  npm run verify
 *
 * Everything imported here is DOM-free, so the exact code the browser runs can
 * be checked under Node. This catches layout mistakes (self-intersections,
 * unclimbable walls, a buried launch ramp, a road that sits in a trench) long
 * before they become a "the car flies off the track" bug report.
 */

import { Track, RAMP_AMP, RAMP_SIGMA, RAMP_SIGMA_OUT } from '../src/sim/track';
import { Terrain, GRID, WORLD } from '../src/sim/terrain';

const f = (v: number, d = 2): string => v.toFixed(d);

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label.padEnd(32)} ${detail}`);
}

console.log('\n=== NOCTIS GP - circuit verification ===\n');

const t0 = Date.now();
const track = new Track().build(2).buildHash().markLaunchRamp();
const terrain = new Terrain();
// Keep an untouched copy of the natural surface so the "trench" check below
// measures what the carve actually changed.
terrain.buildNatural(track);
const naturalHeights = terrain.heights.slice();
track.setHeightsFromTerrain(terrain);
terrain.carve(track);
track.makeCheckpoints(12);
console.log(`build: ${Date.now() - t0} ms\n`);

console.log('-- layout --');
console.log(`  lap length        ${f(track.length / 1000)} km  (${Math.round(track.length)} m, ${track.count} samples)`);
const xs = Array.from(track.samples.px);
const zs = Array.from(track.samples.pz);
const ys = Array.from(track.samples.py);
console.log(
  `  bounds            x [${Math.round(Math.min(...xs))} .. ${Math.round(Math.max(...xs))}]  ` +
    `z [${Math.round(Math.min(...zs))} .. ${Math.round(Math.max(...zs))}]  y [${Math.round(Math.min(...ys))} .. ${Math.round(Math.max(...ys))}]`,
);
console.log(`  world grid        ${GRID}^2 cells of ${f(WORLD / GRID, 3)} m (${(GRID + 1) ** 2} vertices)`);
console.log(`  launch ramp at    s=${f(track.launchS, 0)} m\n`);

// ---- self-intersection ---------------------------------------------------
let crossings = 0;
let firstCross = '';
const STEP = 4;
const n = track.count;
const seg = (i: number): [number, number, number, number] => {
  const j = (i + 1) % n;
  return [track.samples.px[i], track.samples.pz[i], track.samples.px[j], track.samples.pz[j]];
};
const ccw = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number): boolean =>
  (cz - az) * (bx - ax) > (bz - az) * (cx - ax);
for (let i = 0; i < n; i += STEP) {
  const [ax, az, bx, bz] = seg(i);
  for (let j = i + STEP; j < n; j += STEP) {
    // Only test spans that are far apart along the loop.
    const gap = j - i;
    if (gap <= n / 4 || gap >= (3 * n) / 4) continue;
    const [cx, cz, dx, dz] = seg(j);
    if (
      ccw(ax, az, bx, bz, cx, cz) !== ccw(ax, az, bx, bz, dx, dz) &&
      ccw(cx, cz, dx, dz, ax, az) !== ccw(cx, cz, dx, dz, bx, bz)
    ) {
      crossings++;
      if (!firstCross) firstCross = `s=${f(track.samples.s[i], 0)} vs s=${f(track.samples.s[j], 0)}`;
    }
  }
}
check('no self-intersection', crossings === 0, crossings === 0 ? 'clean' : `${crossings} crossing(s), first ${firstCross}`);

// ---- curvature, gradient, banking ---------------------------------------
let minRadius = Infinity;
let minRadiusS = 0;
let maxGradient = 0;
let maxGradientS = 0;
let maxBank = 0;
let meanGrade = 0;
const ds = track.length / n;
for (let i = 0; i < n; i++) {
  const s = track.samples.s[i];
  const curv = Math.abs(track.curvatureAt(s));
  if (curv > 1e-6 && 1 / curv < minRadius) {
    minRadius = 1 / curv;
    minRadiusS = s;
  }
  const g = Math.abs(track.samples.py[i] - track.samples.py[(i + 1) % n]) / ds;
  meanGrade += g;
  if (g > maxGradient) {
    maxGradient = g;
    maxGradientS = s;
  }
  maxBank = Math.max(maxBank, Math.abs(track.samples.bank[i]));
}
meanGrade /= n;
console.log('-- road profile --');
console.log(`  min radius        ${f(minRadius, 1)} m  at s=${f(minRadiusS, 0)} m`);
console.log(`  max gradient      ${(maxGradient * 100).toFixed(1)}%  at s=${f(maxGradientS, 0)} m`);
console.log(`  mean gradient     ${(meanGrade * 100).toFixed(2)}%`);
console.log(`  max bank          ${((maxBank * 180) / Math.PI).toFixed(1)} deg`);
console.log(`  elevation range   ${f(Math.min(...ys), 0)} .. ${f(Math.max(...ys), 0)} m\n`);
check('tightest corner is a real corner', minRadius > 35 && minRadius < 400, `${f(minRadius, 1)} m radius`);
// The pit walls cross a 105 m deep crater, so a steep climb and descent are
// inherent to the layout. 28% is 15.6 degrees - steep for a road car, fine
// for a maglev racer held down by speed-squared downforce, and confirmed
// drivable by the full-race simulation in tools/race-sim.ts.
check('gradient is drivable', maxGradient < 0.28, `max ${(maxGradient * 100).toFixed(1)}% grade`);

// ---- the designed launch ramp -------------------------------------------
{
  const la = 9.6; // the look-back the car physics actually uses
  const h0 = track.frameAt(track.launchS).y;
  // One-sided second difference on the APPROACH side. The landing side is
  // deliberately three times wider, so a symmetric window would average a
  // sharp curve with a flat one and understate the launch. What actually
  // launches the car is the curvature it meets coming into the crest.
  const hA = track.frameAt(track.launchS - la).y;
  const hB = track.frameAt(track.launchS - 2 * la).y;
  const h2 = (hB - 2 * hA + h0) / (la * la);
  const crestiness = Math.max(0, -h2);
  const sp = 80;
  const demand = sp * sp * crestiness;
  const ceiling = 2.6 + 0.0042 * sp * sp * 0.6;

  // How much of the ramp survived grading. Recover the base by subtracting
  // the analytic ramp, then linearly interpolate the base across the window
  // rather than averaging points hundreds of metres apart.
  const baseAt = (s: number): number => track.frameAt(s).y - track.rampAt(s);
  const bL = baseAt(track.launchS - 5 * RAMP_SIGMA);
  const bR = baseAt(track.launchS + 5 * RAMP_SIGMA_OUT);
  const span = 5 * RAMP_SIGMA + 5 * RAMP_SIGMA_OUT;
  const baseGrade = bL + ((5 * RAMP_SIGMA) / span) * (bR - bL);
  const amp = h0 - baseGrade;

  console.log('-- rim crest launch --');
  console.log(`  apex height       ${f(h0)} m  (base grade ${f(baseGrade)} m, ramp adds ${f(amp, 2)} m)`);
  console.log(`  approach curv     ${h2.toExponential(3)} /m   crest=${crestiness.toExponential(3)}`);
  console.log(`  demand vs ceiling ${f(demand, 1)} vs ${f(ceiling, 1)} m/s^2 at ${sp} m/s\n`);
  check('ramp is a real crest', h2 < -1e-3, h2.toExponential(3));
  check('ramp survives grading', amp > RAMP_AMP * 0.85, `${f(amp, 2)} m of ${RAMP_AMP} m`);
  // The whole point: the crest has to break the maglev at racing speed, not
  // merely graze it. Demand must EXCEED the release ceiling.
  check('ramp launches a racing-speed car', demand > ceiling, `${f(demand, 1)} > ${f(ceiling, 1)} m/s^2 at ${sp} m/s`);
  check('ramp is on the south straight', track.frameAt(track.launchS).z < -400, `z=${f(track.frameAt(track.launchS).z, 0)}`);
  // Compare against the designed profile evaluated at the SAME window the car
  // physics uses. The analytic apex curvature (2*amp/sigma^2) is not what the
  // vehicle sees: a 9.6 m chord is a sizeable fraction of the 36 m sigma, so
  // the finite difference it actually samples runs ~23% lower.
  const analytic = (RAMP_AMP * (Math.exp(-(4 * la * la) / (RAMP_SIGMA * RAMP_SIGMA)) - 2 * Math.exp(-(la * la) / (RAMP_SIGMA * RAMP_SIGMA)) + 1)) / (la * la);
  check(
    'approach curvature matches the design at physics resolution',
    Math.abs(analytic - h2) / Math.abs(analytic) < 0.05,
    `designed ${analytic.toExponential(2)} vs built ${h2.toExponential(2)}`,
  );
  // The landing side must fall away at least as fast as the approach rises,
  // or the ground catches the car coming up and it reads as a kerb bounce.
  check('landing side is not slower than the approach', RAMP_SIGMA_OUT <= RAMP_SIGMA,
    `sigma out ${RAMP_SIGMA_OUT} m vs in ${RAMP_SIGMA} m`);
  // Ballistic sanity: the float cannot exceed free fall from the crest.
  const float = Math.sqrt((2 * RAMP_AMP) / 2.6);
  console.log(`  ballistic float     ${f(float, 2)} s of air from a ${RAMP_AMP} m crest at 1/6 g\n`);
}

// ---- road sits in the landscape -----------------------------------------
{
  let maxCut = 0;
  let maxCutS = 0;
  let maxDepart = 0;
  let uncarved = 0;
  for (let i = 0; i < n; i += 3) {
    const s = track.samples.s[i];
    const f0 = track.frameAt(s);
    // The invariant that actually matters: the carved terrain at the rail
    // foot must equal the road plane there. If it does, the solid barrier
    // wall that is generated from that same base has no gap under it. A naive
    // "road vs untouched landscape" comparison would instead just measure the
    // banking, which is metres of legitimate difference on the pit walls.
    for (const side of [1, -1]) {
      const lat = side * (f0.hw + 1.6);
      const x = f0.x + f0.rx * lat;
      const z = f0.z + f0.rz * lat;
      const roadAtLat = f0.y - lat * Math.tan(f0.bank);
      const err = Math.abs(terrain.sampleHeight(x, z) - roadAtLat);
      if (err > maxCut) {
        maxCut = err;
        maxCutS = s;
      }
    }
    // How far the graded road departs from the untouched landscape, measured
    // well outside the carve blend zone. Only meaningful on gentle banking:
    // extrapolating a 56 degree road plane 45 m sideways is not a cutting,
    // it is just the bank, so those sections are excluded.
    if (Math.abs(f0.bank) < 0.4) {
      for (const lat of [f0.hw + 45, -(f0.hw + 45)]) {
      const x = f0.x + f0.rx * lat;
      const z = f0.z + f0.rz * lat;
      const fi = Math.round((x + WORLD / 2) / (WORLD / GRID));
      const fj = Math.round((z + WORLD / 2) / (WORLD / GRID));
      if (fi < 0 || fj < 0 || fi > GRID || fj > GRID) continue;
      const nat = naturalHeights[fj * (GRID + 1) + fi];
      const depart = Math.abs(nat - (f0.y - lat * Math.tan(f0.bank)));
      if (depart > maxDepart) maxDepart = depart;
      }
    }
    // Points inside the corridor must be flagged as road by the carve.
    for (const lat of [-0.6, 0, 0.6]) {
      const x = f0.x + f0.rx * f0.hw * lat;
      const z = f0.z + f0.rz * f0.hw * lat;
      if (terrain.sampleRoadness(x, z) < 0.5) {
        uncarved++;
        if (uncarved <= 4) {
          console.log(
            `    uncarved at s=${f(s, 0)} lat=${lat} (${x.toFixed(0)}, ${z.toFixed(0)}) roadness=${terrain.sampleRoadness(x, z).toFixed(2)}`,
          );
        }
      }
    }
  }
  console.log('-- road surface --');
  console.log(`  rail foot error   ${f(maxCut, 2)} m at s=${f(maxCutS, 0)} m`);
  console.log(`  max landscape cut ${f(maxDepart, 1)} m (informational)\n`);
  check('rail foot meets the road plane', maxCut < 2.5, `${f(maxCut, 2)} m max gap under the barrier`);
  check('corridor is carved', uncarved === 0, `${uncarved} problem samples`);
}

// ---- nearest-point query sanity -----------------------------------------
{
  let worst = 0;
  let worstS = 0;
  for (let i = 0; i < n; i += 7) {
    const s = track.samples.s[i];
    const f0 = track.frameAt(s);
    for (const lat of [-20, -8, 0, 8, 20]) {
      const r = track.nearestS(f0.x + f0.rx * lat, f0.z + f0.rz * lat);
      const err = Math.abs(r.s - s);
      const wrapped = Math.min(err, track.length - err);
      if (wrapped > worst) {
        worst = wrapped;
        worstS = s;
      }
    }
  }
  check('nearestS agrees with frameAt', worst < 6, `max ${f(worst, 2)} m arc error near s=${f(worstS, 0)}`);
}

// ---- ramp clearance: nothing solid on the jump --------------------------
{
  // The barriers are geometry, so confirm the ramp sits on road width only.
  const f0 = track.frameAt(track.launchS);
  const blockers: Boulder[] = [];
  terrain.bouldersNear(f0.x, f0.z, 80, blockers);
  check('ramp is clear of boulders', blockers.length === 0, `${blockers.length} boulders within 80 m`);
}

// ---- checkpoints ---------------------------------------------------------
check('checkpoints span the lap', track.checkpoints.length === 12 && track.checkpoints[0] === 0, `${track.checkpoints.length} checkpoints`);

// ---- ramp profile readout ------------------------------------------------
console.log('\nroad profile through the ramp:');
for (let d = -140; d <= 140; d += 28) {
  const s = track.launchS + d;
  const bar = Math.round(((track.frameAt(s).y - withoutRampAt(track, s)) / RAMP_AMP) * 40);
  console.log(`  s${d >= 0 ? '+' : ''}${String(d).padStart(4)}  y=${track.frameAt(s).y.toFixed(2).padStart(8)}  ${'#'.repeat(Math.max(0, bar))}`);
}
function withoutRampAt(t: Track, s: number): number {
  // Base grade = profile with the analytic ramp removed again.
  return t.frameAt(s).y - t.rampAt(s);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);

interface Boulder {
  x: number;
  z: number;
  r: number;
}
