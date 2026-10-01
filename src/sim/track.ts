/**
 * NOCTIS GP - circuit definition, arc-length sampling and trackside geometry.
 *
 * The road surface is not a separate mesh: it is carved into the terrain
 * heightfield (see terrain.ts), so this module owns the centerline, the
 * banking/width profile, the spatial index used by the vehicle physics, and
 * everything emissive along the edges.
 *
 * Side convention used throughout:
 *   `dSigned` > 0 means "right of the direction of travel"
 *   road height = centerline height - dSigned * tan(bank)
 * so a NEGATIVE bank raises the right edge, which is what a left-hand corner
 * needs. This circuit runs counter-clockwise, so almost every corner is left.
 */

import * as THREE from 'three';
import { TAU, clamp, lerp } from '../core/util';

const DEG = Math.PI / 180;

interface ControlPoint {
  x: number;
  z: number;
  /** Banking in degrees. Negative raises the right (outer) edge. */
  bank: number;
  /** Road half-width in metres. */
  hw: number;
}

interface RawSample {
  x: number;
  z: number;
  bank: number;
  hw: number;
}

/** Closed circuit, counter-clockwise, s = 0 on the start/finish line. */
const CONTROL: ControlPoint[] = [
  { x: 60, z: 1140, bank: -6, hw: 14 }, //  0  start/finish - north plain, heading west
  { x: -450, z: 1120, bank: -4, hw: 14 }, //  1  north plain
  { x: -860, z: 1035, bank: -8, hw: 14 }, //  2  approach to the fast left
  { x: -1080, z: 950, bank: -22, hw: 15 }, //  3  T1 - banked left, out on the plain
  { x: -1290, z: 640, bank: -38, hw: 16 }, //  4  down into the pit
  { x: -1420, z: 230, bank: -56, hw: 16 }, //  5  THE PIT - steepest bank, on the floor of crater A
  { x: -1330, z: -300, bank: -46, hw: 16 }, //  6  pit exit
  { x: -1050, z: -640, bank: -28, hw: 15 }, //  7  climbing back out
  { x: -760, z: -720, bank: -14, hw: 15 }, //  8  rille entry
  { x: -430, z: -700, bank: -2, hw: 14 }, //  9  south straight begins
  { x: -60, z: -640, bank: 4, hw: 13 }, // 10  rim-crest approach
  { x: 330, z: -690, bank: 8, hw: 13 }, // 11  RIM CREST LAUNCH
  { x: 760, z: -880, bank: 20, hw: 14 }, // 12  T-right
  { x: 1120, z: -1010, bank: 26, hw: 14 }, // 13  banked right sweeper
  { x: 1450, z: -780, bank: 10, hw: 14 }, // 14  east flank begins
  { x: 1590, z: -400, bank: 22, hw: 14 }, // 15  terminator climb
  { x: 1560, z: 30, bank: 10, hw: 14 }, // 16  heading north
  { x: 1420, z: 430, bank: -4, hw: 15 }, // 17  hairpin approach
  { x: 1180, z: 760, bank: -12, hw: 15 }, // 18  hairpin entry, on the crater B rim
  { x: 950, z: 1330, bank: -8, hw: 16 }, // 19  hairpin wrap, north of crater B
  { x: 600, z: 1310, bank: -8, hw: 16 }, // 20  hairpin wrap, west
  { x: 330, z: 1180, bank: -5, hw: 15 }, // 21  hairpin exit onto the grid straight
];

/**
 * The designed launch ramp sits on the south straight. It is anchored to a
 * world position rather than an arc length, so editing the control ring can
 * never silently move it off the racing surface.
 */
export const LAUNCH_ANCHOR = { x: 330, z: -690 };
/**
 * Peak height of the launch kicker, metres.
 *
 * Sized so a car carrying AI-racing speed (~80 m/s) fully releases the
 * maglev at the crest rather than just skimming it: the downward demand at
 * the apex must exceed gravity plus the speed-squared downforce the car can
 * generate, which at 80 m/s needs curvature around 3.5e-3 /m.
 */
export const RAMP_AMP = 3.0;
/** Approach half-width, metres. Curvature at the apex = 2 * amp / sigma^2. */
export const RAMP_SIGMA = 36;
/**
 * Landing half-width, metres. Deliberately shorter than the approach.
 *
 * The ramp is a KICKER. Airtime is set by how much height the car has to
 * fall back through, and how sharply it leaves the surface, so amplitude buys
 * float and a tight approach sigma buys launch - a single parameter buys
 * both. The landing side only has to drop away faster than the approach
 * rises, or the ground catches the car on the way up and the whole thing
 * reads as a kerb bounce: an earlier symmetric version managed only 0.2 s of
 * air that way.
 *
 * Both halves are plain Gaussians so the shape decays to nothing with no
 * plateau edges. An open-ended rising profile that stayed high for hundreds
 * of metres had to be cut off somewhere, and that cut showed up as a 160%
 * cliff in the road gradient.
 */
export const RAMP_SIGMA_OUT = 24;
/** The erosion pass below must not flatten the designed ramp away. */
const RAMP_PROTECT = 200;
/** Road profile smoothing: three box passes of this radius (in samples). */
const PROFILE_SMOOTH_RADIUS = 50;
const PROFILE_SMOOTH_PASSES = 3;

export interface TrackSamples {
  px: Float32Array;
  pz: Float32Array;
  py: Float32Array;
  bank: Float32Array;
  hw: Float32Array;
  s: Float32Array;
}

export interface TrackFrame {
  x: number;
  y: number;
  z: number;
  /** Unit tangent (direction of travel). */
  tx: number;
  tz: number;
  /** Unit right vector, i.e. perpendicular-right of travel. */
  rx: number;
  rz: number;
  bank: number;
  hw: number;
}

export interface NearestResult {
  s: number;
  idx: number;
  dist: number;
  dSigned: number;
  frame: TrackFrame;
}

export interface BoostPad {
  s: number;
  x: number;
  z: number;
  mesh: THREE.Mesh | null;
}

export class Track {
  samples!: TrackSamples;
  length = 0;
  count = 0;
  checkpoints: number[] = [];
  readonly group = new THREE.Group();
  readonly chevrons: BoostPad[] = [];
  gantryFrame: TrackFrame | null = null;

  private readonly hash = new Map<string, number[]>();
  private readonly hashCell = 40;

  /** Closed centripetal-ish Catmull-Rom over the control ring. */
  private eval(u: number): RawSample {
    const n = CONTROL.length;
    const fu = (((u % 1) + 1) % 1) * n;
    const i1 = Math.floor(fu) % n;
    const t = fu - Math.floor(fu);
    const i0 = (i1 - 1 + n) % n;
    const i2 = (i1 + 1) % n;
    const i3 = (i1 + 2) % n;
    const p0 = CONTROL[i0];
    const p1 = CONTROL[i1];
    const p2 = CONTROL[i2];
    const p3 = CONTROL[i3];
    return {
      x: crEval(p0.x, p1.x, p2.x, p3.x, t),
      z: crEval(p0.z, p1.z, p2.z, p3.z, t),
      bank: crEval(p0.bank, p1.bank, p2.bank, p3.bank, t),
      hw: crEval(p0.hw, p1.hw, p2.hw, p3.hw, t),
    };
  }

  /** Resample the spline to uniform arc length so `s` is a true distance. */
  build(ds = 2): this {
    const N = 6000;
    const pts: RawSample[] = new Array(N + 1);
    for (let i = 0; i <= N; i++) pts[i] = this.eval(i / N);

    const cum = new Float64Array(N + 1);
    for (let i = 1; i <= N; i++) {
      cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    }
    const len = cum[N];
    if (!(len > 0)) throw new Error('Track.build: spline collapsed to zero length');
    const count = Math.max(8, Math.round(len / ds));

    const out: TrackSamples = {
      px: new Float32Array(count),
      pz: new Float32Array(count),
      py: new Float32Array(count),
      bank: new Float32Array(count),
      hw: new Float32Array(count),
      s: new Float32Array(count),
    };

    let seg = 1;
    for (let k = 0; k < count; k++) {
      const target = (k / count) * len;
      while (seg < N && cum[seg] < target) seg++;
      const t0 = cum[seg - 1];
      const t1 = cum[seg];
      const f = t1 > t0 ? clamp((target - t0) / (t1 - t0), 0, 1) : 0;
      const a = pts[seg - 1];
      const b = pts[seg];
      out.px[k] = lerp(a.x, b.x, f);
      out.pz[k] = lerp(a.z, b.z, f);
      out.bank[k] = lerp(a.bank, b.bank, f) * DEG;
      out.hw[k] = lerp(a.hw, b.hw, f);
      out.s[k] = target;
    }

    this.samples = out;
    this.length = len;
    this.count = count;
    return this;
  }

  /** Uniform grid over every second sample, for nearest-point lookups. */
  buildHash(): this {
    const cell = this.hashCell;
    this.hash.clear();
    const { px, pz } = this.samples;
    for (let i = 0; i < this.count; i += 2) {
      const key = `${Math.floor(px[i] / cell)},${Math.floor(pz[i] / cell)}`;
      const arr = this.hash.get(key);
      if (arr) arr.push(i);
      else this.hash.set(key, [i]);
    }
    return this;
  }

  /** Road frame at arc length `s` (wraps around the lap). */
  frameAt(s: number): TrackFrame {
    const L = this.length;
    const n = this.count;
    let wrapped = s % L;
    if (wrapped < 0) wrapped += L;
    const f = (wrapped / L) * n;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    const t = f - Math.floor(f);
    const { px, pz, py, bank, hw } = this.samples;
    let tx = px[j] - px[i];
    let tz = pz[j] - pz[i];
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-6) {
      // Degenerate tangent (should never happen on a closed loop): fall back
      // to the previous segment rather than emitting NaNs into the physics.
      const k = (i - 1 + n) % n;
      tx = px[i] - px[k];
      tz = pz[i] - pz[k];
    }
    const norm = Math.hypot(tx, tz) || 1;
    tx /= norm;
    tz /= norm;
    return {
      x: lerp(px[i], px[j], t),
      y: lerp(py[i], py[j], t),
      z: lerp(pz[i], pz[j], t),
      tx,
      tz,
      rx: tz,
      rz: -tx,
      bank: lerp(bank[i], bank[j], t),
      hw: lerp(hw[i], hw[j], t),
    };
  }

  /** Nearest point on the centerline to a world position. */
  nearestS(x: number, z: number): NearestResult {
    const cell = this.hashCell;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let best = Infinity;
    let bestI = 0;
    for (let radius = 1; radius <= 24 && best === Infinity; radius++) {
      for (let ox = -radius; ox <= radius; ox++) {
        for (let oz = -radius; oz <= radius; oz++) {
          if (radius > 1 && Math.max(Math.abs(ox), Math.abs(oz)) !== radius) continue;
          const arr = this.hash.get(`${cx + ox},${cz + oz}`);
          if (!arr) continue;
          for (let k = 0; k < arr.length; k++) {
            const i = arr[k];
            const d = (this.samples.px[i] - x) ** 2 + (this.samples.pz[i] - z) ** 2;
            if (d < best) {
              best = d;
              bestI = i;
            }
          }
        }
      }
    }
    if (best === Infinity) bestI = 0; // far outside the world: use sample 0

    // Refine against the segments around the coarse winner.
    const n = this.count;
    const ds = this.length / n;
    let bestS = this.samples.s[bestI];
    let bestDist = Infinity;
    let bestSide = 1;
    let segI = bestI;
    const W = 8;
    for (let w = -W; w <= W; w++) {
      const i = (bestI + w + n) % n;
      const j = (i + 1) % n;
      const ax = this.samples.px[i];
      const az = this.samples.pz[i];
      const ex = this.samples.px[j] - ax;
      const ez = this.samples.pz[j] - az;
      const el2 = ex * ex + ez * ez || 1e-6;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / el2, 0, 1);
      const qx = ax + ex * t;
      const qz = az + ez * t;
      const d = Math.hypot(x - qx, z - qz);
      if (d < bestDist) {
        bestDist = d;
        bestS = this.samples.s[i] + t * ds;
        if (bestS >= this.length) bestS -= this.length;
        bestSide = Math.sign((x - qx) * ez - (z - qz) * ex) || 1;
        segI = i;
      }
    }
    return { s: bestS, idx: segI, dist: bestDist, dSigned: bestDist * bestSide, frame: this.frameAt(bestS) };
  }

  /** Arc position of the designed launch ramp, resolved by markLaunchRamp(). */
  launchS = -1;
  launchFrame: RidgeFrame | null = null;

  /**
   * Resolve the arc position of the launch ramp and the frame it is built on.
   * Call after build()/buildHash() and before buildNatural().
   */
  markLaunchRamp(): this {
    const near = this.nearestS(LAUNCH_ANCHOR.x, LAUNCH_ANCHOR.z);
    this.launchS = near.s;
    const f = this.frameAt(near.s);
    const l = Math.hypot(f.tx, f.tz) || 1;
    this.launchFrame = { cx: f.x, cz: f.z, dx: f.tx / l, dz: f.tz / l };
    return this;
  }

  /**
   * Height of the designed kicker at arc length `s` (periodic over the lap).
   *
   * Two Gaussians joined at the apex: a longer approach that crests, and a
   * shorter landing side so the surface falls away from under the car faster
   * than it rose. C1 continuous at the top by construction.
   */
  rampAt(s: number): number {
    if (this.launchS < 0) return 0;
    let d = s - this.launchS;
    if (d > this.length - d) d -= this.length;
    if (d < -this.length - d) d += this.length;
    const sigma = d < 0 ? RAMP_SIGMA : RAMP_SIGMA_OUT;
    if (Math.abs(d) > sigma * 4.5) return 0;
    return RAMP_AMP * Math.exp(-((d / sigma) ** 2));
  }

  /**
   * Grade the road onto the terrain.
   *
   * Raw terrain carries several metres of high-frequency noise - far more than
   * the designed ramp - so simply sampling it produces a profile that throws
   * the car around and completely buries the jump. A real circuit is graded,
   * so the profile is built in four stages:
   *
   *   1. sample the terrain,
   *   2. subtract the designed ramp, so the heavy smoothing cannot eat it,
   *   3. smooth hard, which removes terrain noise but keeps the pit and the
   *      big climbs,
   *   4. add exactly one clean ramp back, then erode any remaining
   *      unintentional crests that would launch the car.
   */
  setHeightsFromTerrain(terrain: { sampleHeight(x: number, z: number): number }): this {
    const n = this.count;
    const { px, pz, py, s: sArr } = this.samples;

    for (let i = 0; i < n; i++) py[i] = terrain.sampleHeight(px[i], pz[i]) - this.rampAt(sArr[i]);

    boxSmoothCircular(py, n, PROFILE_SMOOTH_RADIUS, PROFILE_SMOOTH_PASSES);

    for (let i = 0; i < n; i++) py[i] += this.rampAt(sArr[i]);

    const isProtected = (i: number): boolean => {
      if (this.launchS < 0) return false;
      let d = Math.abs(sArr[i] - this.launchS);
      if (d > this.length - d) d = this.length - d;
      return d < RAMP_PROTECT;
    };

    // Erode convexity: repeatedly clamp any vertex sitting above its
    // neighbours' chord down onto it, until nothing moves. A fixed point
    // rather than a pass count, so the result cannot depend on how smooth the
    // input happened to be on a given build.
    let a: Float32Array = py;
    let b: Float32Array = new Float32Array(n);
    for (let pass = 0; pass < 8000; pass++) {
      b.set(a);
      let maxDelta = 0;
      for (let i = 0; i < n; i++) {
        if (isProtected(i)) continue;
        const chord = (a[(i - 1 + n) % n] + a[(i + 1) % n]) * 0.5 + 0.001;
        if (b[i] > chord) {
          const d = b[i] - chord;
          b[i] = chord;
          if (d > maxDelta) maxDelta = d;
        }
      }
      const tmp = a;
      a = b;
      b = tmp;
      if (maxDelta < 0.0005) break;
    }
    if (a !== py) py.set(a);

    // One mild concave-only pass to round off valley kinks. Concave-only,
    // because smoothing a convex profile would re-introduce exactly the
    // launches the erosion above just removed.
    {
      const prev = new Float32Array(n);
      prev.set(py);
      for (let i = 0; i < n; i++) {
        if (isProtected(i)) continue;
        py[i] = prev[(i - 1 + n) % n] * 0.125 + prev[i] * 0.75 + prev[(i + 1) % n] * 0.125;
      }
    }
    return this;
  }

  makeCheckpoints(n = 12): number[] {
    this.checkpoints = [];
    for (let i = 0; i < n; i++) this.checkpoints.push((i / n) * this.length);
    return this.checkpoints;
  }

  // ---- trackside geometry -------------------------------------------------

  buildMeshes(terrain: HeightSampler): THREE.Group {
    const n = this.count;
    this.group.clear();
    this.chevrons.length = 0;

    this.buildBarriers(terrain, n);
    this.buildPylons(terrain, n);
    this.buildGantry();
    this.buildStartLine();
    this.buildBoostPads();
    return this.group;
  }

  /**
   * Solid corridor walls: a dark panel plus a glowing top rail. The car is
   * clamped inside them, so the rail is gameplay geometry, not decoration.
   */
  private buildBarriers(terrain: HeightSampler, n: number): void {
    const { px, pz, py, hw, bank: bankArr } = this.samples;

    // Base the wall on the road surface OR the shoulder just outside it.
    // Raw terrain at the rail foot sits inside the carve blend and can slope
    // hard, which would bury the rail inside rims and dunes.
    const baseFor = (side: number): Float32Array => {
      const base = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        let tx = px[j] - px[i];
        let tz = pz[j] - pz[i];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const rx = tz * side;
        const rz = -tx * side;
        const edge = hw[i] + 1.6;
        const roadH = py[i] - side * edge * Math.tan(bankArr[i]);
        let h = roadH;
        for (const off of [0, 1.5, 3]) {
          h = Math.max(h, terrain.sampleHeight(px[i] + rx * (edge + off), pz[i] + rz * (edge + off)));
        }
        base[i] = h;
      }
      for (let pass = 0; pass < 6; pass++) {
        const prev = base.slice();
        for (let i = 0; i < n; i++) {
          base[i] = prev[(i - 1 + n) % n] * 0.25 + prev[i] * 0.5 + prev[(i + 1) % n] * 0.25;
        }
      }
      return base;
    };

    const strip = (side: number, base: Float32Array, yBot: number, yTop: number, w: number): THREE.BufferGeometry => {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 2 * 3);
      const idx: number[] = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        let tx = px[j] - px[i];
        let tz = pz[j] - pz[i];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const rx = tz * side;
        const rz = -tx * side;
        const edge = hw[i] + 1.6;
        for (let k = 0; k < 2; k++) {
          const off = edge + (k === 0 ? -w : w);
          const o = (i * 2 + k) * 3;
          pos[o] = px[i] + rx * off;
          pos[o + 1] = base[i] + (k === 0 ? yBot : yTop);
          pos[o + 2] = pz[i] + rz * off;
        }
        const a = i * 2;
        const b = i * 2 + 1;
        const c = ((i + 1) % n) * 2;
        const d = ((i + 1) % n) * 2 + 1;
        idx.push(a, c, b, b, c, d);
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };

    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x121824,
      roughness: 0.62,
      metalness: 0.35,
      side: THREE.DoubleSide,
    });

    for (const side of [1, -1] as const) {
      const base = baseFor(side);
      const wall = new THREE.Mesh(strip(side, base, -2.4, 1.35, 0), wallMat);
      wall.receiveShadow = true;
      wall.name = side > 0 ? 'wallRight' : 'wallLeft';
      const railColor = side > 0 ? 0x18c8ff : 0xff5230;
      const rail = new THREE.Mesh(
        strip(side, base, 1.32, 1.52, 0.14),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(railColor).multiplyScalar(1.9),
          toneMapped: false,
          side: THREE.DoubleSide,
        }),
      );
      rail.name = side > 0 ? 'railRight' : 'railLeft';
      this.group.add(wall, rail);
    }
  }

  /** Marker pylons alternating sides, with emissive tips. */
  private buildPylons(terrain: HeightSampler, n: number): void {
    const every = Math.max(1, Math.round(150 / 2));
    const count = Math.floor(n / every);
    if (count <= 0) return;

    const pylonGeo = new THREE.CylinderGeometry(0.28, 0.6, 5, 6);
    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6, metalness: 0.4 });
    const tipGeo = new THREE.SphereGeometry(0.5, 8, 6);
    const tipMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x9fd8ff).multiplyScalar(2.2),
      toneMapped: false,
    });
    const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, count);
    const tips = new THREE.InstancedMesh(tipGeo, tipMat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3(1, 1, 1);

    let pc = 0;
    for (let i = 0; i < n && pc < count; i += every) {
      const side = ((i / every) | 0) % 2 === 0 ? 1 : -1;
      const f = this.frameAt(this.samples.s[i]);
      const off = f.hw + 2.6;
      const x = f.x + f.rx * off * side;
      const z = f.z + f.rz * off * side;
      const y = terrain.sampleHeight(x, z);
      v.set(x, y + 2.5, z);
      m.compose(v, q, sc);
      pylons.setMatrixAt(pc, m);
      v.set(x, y + 5.2, z);
      m.compose(v, q, sc);
      tips.setMatrixAt(pc, m);
      pc++;
    }
    pylons.count = pc;
    tips.count = pc;
    pylons.instanceMatrix.needsUpdate = true;
    tips.instanceMatrix.needsUpdate = true;
    pylons.castShadow = true;
    this.group.add(pylons, tips);
  }

  private buildGantry(): void {
    const f0 = this.frameAt(0);
    const yaw0 = Math.atan2(f0.tx, f0.tz);
    const gantry = new THREE.Group();
    gantry.rotation.y = yaw0;
    gantry.position.set(f0.x, f0.y, f0.z);

    // Legs run deep below grade so they meet the ground on banked ground.
    const legGeo = new THREE.BoxGeometry(1.6, 24, 1.6);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x70757d, roughness: 0.5, metalness: 0.7 });
    const span = f0.hw * 2 + 11;
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set((f0.hw + 4.2) * side, 4, 0);
      leg.castShadow = true;
      gantry.add(leg);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(span, 4, 2.6),
      new THREE.MeshStandardMaterial({ color: 0x3c4047, roughness: 0.5, metalness: 0.7 }),
    );
    beam.position.y = 16;
    beam.castShadow = true;
    gantry.add(beam);

    const signCv = document.createElement('canvas');
    signCv.width = 1024;
    signCv.height = 128;
    const c = signCv.getContext('2d');
    if (c) {
      c.fillStyle = '#0a0d14';
      c.fillRect(0, 0, 1024, 128);
      c.fillStyle = '#ffb066';
      c.font = '500 78px "Geist Mono", ui-monospace, monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('NOCTIS GP', 512, 56);
      c.fillStyle = '#7d8898';
      c.font = '500 26px "Geist Mono", ui-monospace, monospace';
      c.fillText('SERENITATIS CIRCUIT', 512, 106);
    }
    const signTex = new THREE.CanvasTexture(signCv);
    signTex.colorSpace = THREE.SRGBColorSpace;
    const signMat = new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide });
    signMat.color.multiplyScalar(1.35);
    signMat.toneMapped = false;
    for (const side of [-1, 1]) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(span - 1.5, 3.2), signMat);
      face.position.set(0, 16, 1.36 * side);
      if (side < 0) face.rotation.y = Math.PI;
      gantry.add(face);
    }
    this.group.add(gantry);
    this.gantryFrame = f0;
  }

  private buildStartLine(): void {
    const f0 = this.gantryFrame;
    if (!f0) return;
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 44;
    const c = cv.getContext('2d');
    if (c) {
      c.fillStyle = '#0a0a0a';
      c.fillRect(0, 0, 256, 44);
      for (let r = 0; r < 3; r++) {
        for (let col = 0; col < 16; col++) {
          if ((r + col) % 2 === 0) {
            c.fillStyle = '#8f949c';
            c.fillRect(col * 16, r * 14 + 1, 16, 14);
          }
        }
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(f0.hw * 2 - 1, 3.4),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    );
    const yaw0 = Math.atan2(f0.tx, f0.tz);
    line.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    line.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), yaw0);
    // Lie flat on the banked surface (road height = y - dSigned * tan(bank)).
    line.rotateOnWorldAxis(new THREE.Vector3(f0.tx, 0, f0.tz).normalize(), -f0.bank);
    line.position.set(f0.x, f0.y + 0.25, f0.z);
    this.group.add(line);
  }

  /** Additive chevron pads on the racing line. */
  private buildBoostPads(): void {
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 128;
    const c = cv.getContext('2d');
    if (c) {
      c.clearRect(0, 0, 128, 128);
      c.strokeStyle = '#8fffd0';
      c.lineWidth = 10;
      for (let k = 0; k < 3; k++) {
        const y = 100 - k * 34;
        c.beginPath();
        c.moveTo(24, y);
        c.lineTo(64, y - 24);
        c.lineTo(104, y);
        c.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(9, 9);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      toneMapped: false,
    });

    const spacing = 640;
    const count = Math.floor(this.length / spacing);
    for (let k = 0; k < count; k++) {
      const s = 320 + k * spacing;
      const f = this.frameAt(s);
      const pad = new THREE.Mesh(geo, mat);
      pad.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
      // +PI: after the flat rotation the canvas "up" points backwards, but the
      // chevrons must point down-track, the way the cars travel.
      pad.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), Math.atan2(f.tx, f.tz) + Math.PI);
      // Lie flat on banked sections (the pit runs up to 56 degrees).
      pad.rotateOnWorldAxis(new THREE.Vector3(f.tx, 0, f.tz).normalize(), -f.bank);
      pad.position.set(f.x, f.y + 0.3, f.z);
      this.group.add(pad);
      this.chevrons.push({ s, x: f.x, z: f.z, mesh: pad });
    }
  }

  /** Signed centerline curvature at `s` (1/m; positive = left turn). */
  curvatureAt(s: number): number {
    const d = 10;
    const h0 = Math.atan2(this.frameAt(s).tx, this.frameAt(s).tz);
    const hA = Math.atan2(this.frameAt(s + d).tx, this.frameAt(s + d).tz);
    const hB = Math.atan2(this.frameAt(s - d).tx, this.frameAt(s - d).tz);
    // Heading DECREASES through a left turn on this circuit, so negate.
    // Central difference over a 2d span, so curvature = -dh/ds.
    const headingChange = wrapPi(hA - h0) + wrapPi(h0 - hB);
    return -headingChange / (2 * d);
  }
}

/** Orientation of the launch ramp, in world XZ. */
export interface RidgeFrame {
  cx: number;
  cz: number;
  /** unit along-track direction in the XZ plane */
  dx: number;
  dz: number;
}

/**
 * In-place box blur over a circular array, repeated `passes` times.
 * Three box passes approximate a Gaussian closely enough for road grading and
 * cost a fraction of a true convolution at these radii.
 */
function boxSmoothCircular(arr: Float32Array, n: number, radius: number, passes: number): void {
  const width = radius * 2 + 1;
  let src: Float32Array = arr;
  let dst: Float32Array = new Float32Array(n);
  for (let p = 0; p < passes; p++) {
    // Running sum, wrapping at both ends of the lap.
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[(k + n) % n];
    for (let i = 0; i < n; i++) {
      dst[i] = sum / width;
      sum += src[(i + radius + 1) % n] - src[(i - radius + n) % n];
    }
    const tmp = src;
    src = dst;
    dst = tmp === arr ? new Float32Array(n) : tmp;
  }
  if (src !== arr) arr.set(src);
}

function crEval(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= TAU;
  while (x <= -Math.PI) x += TAU;
  return x;
}

export interface HeightSampler {
  sampleHeight(x: number, z: number): number;
}
