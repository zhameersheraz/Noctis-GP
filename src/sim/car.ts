/**
 * NOCTIS GP - lunar maglev vehicle model.
 *
 * The player and every AI car run this exact simulation; only the source of
 * the DriveInput differs. Nothing here knows about rendering beyond holding a
 * mesh handle to copy state into.
 *
 * Model summary
 *   Gravity       2.6 m/s^2, one sixth of Earth's, so everything is floaty.
 *   Downforce     proportional to speed^2 and released over crests. This is
 *                 the interesting part: the car is held onto the surface by a
 *                 speed-squared force, so it can stick to a 56 degree banking
 *                 at speed, yet genuinely goes ballistic over the launch ramp
 *                 because the required centripetal demand exceeds gravity
 *                 plus whatever downforce the current speed can generate.
 *   Grip          velocity is rotated towards the body heading at a rate set
 *                 by the same lateral-acceleration budget, which is what makes
 *                 the car slide predictably instead of teleporting sideways.
 */

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, angleWrap, smoothstep } from '../core/util';
import { NEUTRAL_INPUT } from './types';
import type { DriveInput, ItemKind, SimEnv } from './types';

export const GRAVITY = 2.6;
export const RIDE_HEIGHT = 0.58;
export const ENGINE_ACCEL = 21.0;
export const BOOST_ACCEL = 17.0;
export const BRAKE_ACCEL = 36.0;
export const DRAG = 0.0026; // per (m/s)^2 -> top speed around 88 m/s
export const MAGLEV = 0.0042; // downforce accel per (m/s)^2
export const AIR_MAGLEV_FADE = 8.0; // metres over which the field weakens
export const TOP_SPEED = 170; // hard safety clamp, m/s

const _n = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class CarSim {
  /**
   * Render handle. Null in headless verification, where the simulation runs
   * with no scene at all - which is the point of keeping the rules here.
   */
  readonly mesh: THREE.Object3D | null;
  name: string;
  isPlayer: boolean;
  color: number;

  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  yawVel = 0;

  grounded = true;
  airTime = 0;
  /** 0..1 boost reservoir. */
  boost = 0.62;
  boosting = false;
  turboing = false;

  item: ItemKind = null;
  shieldT = 0;
  turboT = 0;
  stunT = 0;
  stunSpin = 0;
  shieldMesh: THREE.Object3D | null = null;
  tag: THREE.Sprite | null = null;
  ai: unknown = null;

  wheelRot = 0;
  steerViz = 0;
  throttleViz = 0;
  pitch = 0;
  roll = 0;
  visualPitch = 0;
  visualRoll = 0;
  /** 0..1 how sideways the car is relative to its heading. */
  slip = 0;
  /** 0..1 how far off the road surface the car is. */
  offroad = 0;
  impact = 0;
  boostFlash = 0;
  railScrape = 0;
  braking = false;
  disabled = false;
  /** True while the countdown holds the car on the grid. */
  idling = false;

  // ---- race bookkeeping ---------------------------------------------------
  lap = 0;
  /** Arc position on the centerline. */
  s = 0;
  lastS = 0;
  cpIndex = 0;
  lapTimes: number[] = [];
  lapStart = 0;
  finished = false;
  finishTime = 0;
  /** lap * length + s; the single number the standings sort on. */
  totalDist = 0;
  padCooldown = -1;
  stuckTimer = 0;
  wrongWayT = 0;
  offRoadT = 0;
  aiUseCd = 0;

  private railTouchT = 0;
  private wallHitT = 0;
  private static boulderScratch: { x: number; z: number; r: number }[] = [];

  constructor(mesh: THREE.Object3D | null, opts: { name?: string; color?: number; isPlayer?: boolean } = {}) {
    this.mesh = mesh;
    this.name = opts.name ?? 'DRIVER';
    this.isPlayer = !!opts.isPlayer;
    this.color = opts.color ?? 0xffffff;
  }

  /** Horizontal speed in m/s. */
  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** Speed in km/h, including any vertical component while airborne. */
  get speedKmh(): number {
    return Math.hypot(this.vel.x, this.vel.y, this.vel.z) * 3.6;
  }

  /**
   * Seat the car on the surface at a track frame. On banked road a laterally
   * offset grid slot sits at a different height from the centerline, so the
   * real ground is sampled rather than the frame height.
   */
  placeAt(frame: { x: number; z: number; tx: number; tz: number }, s: number, terrain: SimEnv['terrain']): void {
    const y = terrain.sampleHeight(frame.x, frame.z) + RIDE_HEIGHT;
    this.pos.set(frame.x, y, frame.z);
    this.vel.set(0, 0, 0);
    this.yaw = Math.atan2(frame.tx, frame.tz);
    this.yawVel = 0;
    this.grounded = true;
    this.airTime = 0;
    this.s = s;
    this.lastS = s;
    this.totalDist = s;

    const nrm = terrain.sampleNormal(frame.x, frame.z, _n);
    const fwdX = Math.sin(this.yaw);
    const fwdZ = Math.cos(this.yaw);
    this.visualPitch = Math.asin(clamp(nrm.x * fwdX + nrm.z * fwdZ, -0.7, 0.7));
    this.visualRoll = -Math.asin(clamp(nrm.x * fwdZ - nrm.z * fwdX, -0.7, 0.7));
  }

  /** Put the car back on the racing line, a little behind where it was. */
  resetToTrack(env: SimEnv): void {
    const near = env.track.nearestS(this.pos.x, this.pos.z);
    const back = (near.s - 6 + env.track.length) % env.track.length;
    const f = env.track.frameAt(back);
    this.placeAt(f, back, env.terrain);
    this.lastS = back;
    this.totalDist = Math.floor(this.totalDist / env.track.length) * env.track.length + back;
    this.boost = Math.max(this.boost, 0.3);
    this.stunT = 0;
    this.stuckTimer = 0;
    this.wrongWayT = 0;
    this.offRoadT = 0;
    this.vel.multiplyScalar(0.2);
  }

  step(rawInput: DriveInput, dt: number, env: SimEnv): void {
    const { terrain, track } = env;
    let input: DriveInput = this.disabled ? NEUTRAL_INPUT : rawInput;
    this.braking = input.brake > 0 && this.speed > 2;

    this.turboT = Math.max(0, this.turboT - dt);
    this.shieldT = Math.max(0, this.shieldT - dt);
    this.turboing = this.turboT > 0;

    let stunned = false;
    if (this.stunT > 0) {
      this.stunT -= dt;
      stunned = true;
      input = NEUTRAL_INPUT;
    }

    const groundH = terrain.sampleHeight(this.pos.x, this.pos.z);
    const heightAbove = this.pos.y - groundH - RIDE_HEIGHT;

    const near = track.nearestS(this.pos.x, this.pos.z);
    this.offroad = smoothstep(near.frame.hw - 1.5, near.frame.hw + 13, near.dist);
    const gripMul = lerp(1.0, 0.65, this.offroad);
    this.s = near.s;

    let vx = this.vel.x;
    let vz = this.vel.z;
    const speed = Math.hypot(vx, vz);

    // ---- vertical: gravity plus speed-squared maglev downforce -----------
    // The downforce releases wherever the ground curves away faster than the
    // car can be pulled down, which is exactly what makes the launch ramp
    // work while still pinning the car to the steepest banking.
    const fwdx0 = Math.sin(this.yaw);
    const fwdz0 = Math.cos(this.yaw);
    const lookAhead = clamp(speed * 0.12, 5, 11);
    const hBack = terrain.sampleHeight(this.pos.x - fwdx0 * lookAhead, this.pos.z - fwdz0 * lookAhead);
    const hFwd = terrain.sampleHeight(this.pos.x + fwdx0 * lookAhead, this.pos.z + fwdz0 * lookAhead);
    // Second derivative of the ground along travel: negative over a crest.
    const groundCurv = (hBack - 2 * groundH + hFwd) / (lookAhead * lookAhead);
    const crestiness = Math.max(0, -groundCurv);
    const demand = speed * speed * crestiness;
    const ceiling = GRAVITY * 0.9 + MAGLEV * speed * speed * 0.6;
    const release = 1 - smoothstep(GRAVITY * 0.9, ceiling, demand);
    const maglev = Math.exp(-Math.max(0, heightAbove) / AIR_MAGLEV_FADE) * MAGLEV * speed * speed * release;
    this.vel.y -= (GRAVITY + maglev) * dt;

    if (heightAbove <= 0) {
      const n = terrain.sampleNormal(this.pos.x, this.pos.z, _n);
      this.pos.y = groundH + RIDE_HEIGHT;
      const velN = this.vel.x * n.x + this.vel.y * n.y + this.vel.z * n.z;
      if (velN < 0) {
        const hit = -velN;
        this.vel.x -= velN * n.x;
        this.vel.y -= velN * n.y;
        this.vel.z -= velN * n.z;
        if (hit > 7) this.impact = Math.min(1, (hit - 7) / 14);
      }
      // Pushing out of terrain can otherwise pump vertical speed every frame
      // while grinding along a rising wall, turning a stop into a launch.
      if (this.wallHitT > 0) this.vel.y = Math.min(this.vel.y, 4);
      if (!this.grounded && this.airTime > 0.25) this.impact = Math.max(this.impact, Math.min(0.6, this.airTime * 0.25));
      this.grounded = true;
      this.airTime = 0;
    } else if (heightAbove > 0.35) {
      this.grounded = false;
      this.airTime += dt;
    } else {
      // Hovering in the maglev gap: still effectively driving.
      this.grounded = true;
    }

    vx = this.vel.x;
    vz = this.vel.z;
    const sp = Math.hypot(vx, vz) || 1e-5;

    if (this.grounded) {
      // ---- steering ------------------------------------------------------
      // Same lateral budget the AI reasons about, so the AI can predict it.
      const aLatMax = (GRAVITY + MAGLEV * sp * sp) * 1.3 * gripMul;
      const yawMax = clamp(aLatMax / Math.max(sp, 6), 0.42, input.handbrake ? 2.6 : 1.75);
      // Reversing flips the steering sense, like a real car, and gets a
      // calmer rate so backing out of a wall stays controllable.
      const fwdSpeed0 = this.vel.x * fwdx0 + this.vel.z * fwdz0;
      const revK = fwdSpeed0 < -0.5 ? -0.8 : 1.0;
      let desiredYaw = input.steer * revK * yawMax * (input.handbrake ? 1.35 : 1.0) * (1 - clamp01(sp / 240) * 0.25);
      if (stunned) desiredYaw = this.stunSpin;
      this.yawVel = damp(this.yawVel, desiredYaw, input.handbrake ? 7.0 : 13.0, dt);
      this.yaw = angleWrap(this.yaw + this.yawVel * dt);

      // ---- longitudinal --------------------------------------------------
      _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const fwdSpeed = this.vel.x * _fwd.x + this.vel.z * _fwd.z;
      let accel = 0;
      if (input.throttle > 0) accel += ENGINE_ACCEL * input.throttle;
      if (this.turboing) accel += 26; // turbo is free thrust, no meter cost
      this.boosting = false;
      if (input.boost && this.boost > 0.01 && input.throttle > 0) {
        accel += BOOST_ACCEL;
        this.boost = Math.max(0, this.boost - 0.32 * dt);
        this.boosting = true;
      }
      if (stunned) accel -= 8; // a spin-out scrubs speed
      if (input.brake > 0 && fwdSpeed > -13) accel -= BRAKE_ACCEL * input.brake * (fwdSpeed > 0 ? 1 : 0.75);
      accel -= DRAG * fwdSpeed * Math.abs(fwdSpeed);
      accel -= fwdSpeed * lerp(0.05, 0.55, this.offroad); // regolith drag
      this.vel.x += _fwd.x * accel * dt;
      this.vel.z += _fwd.z * accel * dt;

      // ---- lateral grip: rotate velocity towards the body heading --------
      vx = this.vel.x;
      vz = this.vel.z;
      const vAng = Math.atan2(vx, vz);
      let diff = angleWrap(this.yaw - vAng);
      // While reversing, grip has to align velocity to the car's rear axis;
      // spinning the motion around towards the nose makes reversing impossible.
      if (Math.abs(diff) > Math.PI / 2) diff = angleWrap(diff - Math.PI);
      const gripRate = (aLatMax / Math.max(sp, 6)) * (input.handbrake ? 0.24 : 1.0) * lerp(1, 0.45, this.offroad);
      const rot = clamp(diff, -gripRate * dt, gripRate * dt);
      const c = Math.cos(rot);
      const sn = Math.sin(rot);
      this.vel.x = vx * c + vz * sn;
      this.vel.z = -vx * sn + vz * c;
      this.slip = damp(this.slip, clamp01(Math.abs(diff) * 2.2), 6, dt);

      // Regolith bumpiness, only when genuinely off the road.
      if (this.offroad > 0.15 && sp > 12) {
        const b = (Math.sin(this.pos.x * 0.9) + Math.cos(this.pos.z * 1.1)) * 0.5;
        this.vel.y += b * this.offroad * clamp01(sp / 60) * 3.5 * dt;
      }
    } else {
      // Airborne: floaty, minimal authority. A stunned car keeps its spin.
      this.yawVel = damp(this.yawVel, stunned ? this.stunSpin : input.steer * 0.55, 0.9, dt);
      this.yaw = angleWrap(this.yaw + this.yawVel * dt);
      this.vel.x -= this.vel.x * 0.02 * dt;
      this.vel.z -= this.vel.z * 0.02 * dt;
      this.slip = damp(this.slip, 0, 1.5, dt);
    }

    this.resolveBoulders(env);

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    this.resolveBarriers(env, near, dt);

    this.railScrape = Math.max(0, this.railScrape - dt);
    this.wallHitT = Math.max(0, this.wallHitT - dt);
    // While scraping the rail, cap vertical momentum and reel the car back
    // onto the surface. Grinding scrubs speed, which collapses the speed^2
    // downforce on a banked wall; without this the car separates and glides
    // off the outside of the corner.
    if (this.railTouchT > 0) {
      this.railTouchT -= dt;
      this.vel.y = Math.min(this.vel.y, 5);
      const above = this.pos.y - (terrain.sampleHeight(this.pos.x, this.pos.z) + RIDE_HEIGHT);
      if (above > 0.05) this.vel.y -= 40 * dt;
    }

    // ---- world bounds and safety clamps ----------------------------------
    const lim = 3950;
    if (Math.abs(this.pos.x) > lim) {
      this.pos.x = clamp(this.pos.x, -lim, lim);
      this.vel.x *= -0.3;
    }
    if (Math.abs(this.pos.z) > lim) {
      this.pos.z = clamp(this.pos.z, -lim, lim);
      this.vel.z *= -0.3;
    }
    if (!Number.isFinite(this.pos.x + this.pos.y + this.pos.z + this.vel.x + this.vel.y + this.vel.z)) {
      this.resetToTrack(env);
      return;
    }
    const vv = Math.hypot(this.vel.x, this.vel.z);
    if (vv > TOP_SPEED) {
      const k = TOP_SPEED / vv;
      this.vel.x *= k;
      this.vel.z *= k;
    }

    // ---- visual state -----------------------------------------------------
    this.steerViz = damp(this.steerViz, input.steer, 12, dt);
    this.throttleViz = damp(this.throttleViz, input.throttle, 8, dt);
    this.wheelRot += (vx * _fwd.x + vz * _fwd.z) * dt / 0.52;
    this.impact = Math.max(0, this.impact - dt * 2.2);
    this.boostFlash = Math.max(0, this.boostFlash - dt * 2);

    if (this.grounded) {
      // Sample where the axles actually sit rather than using the surface
      // normal at the centre: the normal lags behind grade breaks at speed
      // and the nose visibly clips into the road.
      const fX = Math.sin(this.yaw);
      const fZ = Math.cos(this.yaw);
      const rX = fZ;
      const rZ = -fX;
      const wb = 1.9;
      const tw = 0.85;
      const hF = terrain.sampleHeight(this.pos.x + fX * wb, this.pos.z + fZ * wb);
      const hB = terrain.sampleHeight(this.pos.x - fX * wb, this.pos.z - fZ * wb);
      const hR = terrain.sampleHeight(this.pos.x + rX * tw, this.pos.z + rZ * tw);
      const hL = terrain.sampleHeight(this.pos.x - rX * tw, this.pos.z - rZ * tw);
      this.visualPitch = damp(this.visualPitch, clamp(-Math.atan2(hF - hB, 2 * wb), -0.75, 0.75), 16, dt);
      this.visualRoll = damp(this.visualRoll, clamp(Math.atan2(hR - hL, 2 * tw), -0.75, 0.75), 16, dt);
    } else {
      this.visualPitch = damp(this.visualPitch, clamp(this.vel.y * 0.02, -0.3, 0.3), 1.2, dt);
      this.visualRoll = damp(this.visualRoll, 0, 1.2, dt);
    }

    if (sp < 1.5 && input.throttle > 0.5) this.stuckTimer += dt;
    else this.stuckTimer = 0;
  }

  private resolveBoulders(env: SimEnv): void {
    const nearby = env.terrain.bouldersNear(this.pos.x, this.pos.z, 3, CarSim.boulderScratch);
    for (let i = 0; i < nearby.length; i++) {
      const b = nearby[i];
      const dx = this.pos.x - b.x;
      const dz = this.pos.z - b.z;
      const d = Math.hypot(dx, dz);
      const minD = b.r * 0.82 + 1.15;
      if (d >= minD || d < 1e-4) continue;
      const nx = dx / d;
      const nz = dz / d;
      this.pos.x = b.x + nx * minD;
      this.pos.z = b.z + nz * minD;
      const vn = this.vel.x * nx + this.vel.z * nz;
      if (vn >= 0) continue;
      this.vel.x -= vn * 1.35 * nx;
      this.vel.z -= vn * 1.35 * nz;
      // Striking a rock while climbing a slope carries a large +vy; a hard
      // stop has to kill it along with the forward motion or the car sails
      // off into lunar orbit.
      if (-vn > 3) {
        if (this.vel.y > 0) this.vel.y = Math.min(this.vel.y * clamp(1 - (-vn - 3) / 9, 0.1, 1), 4);
        this.wallHitT = 0.3;
      }
      this.impact = Math.max(this.impact, Math.min(1, -vn / 22));
    }
  }

  /**
   * The corridor barriers are solid. Only test once the car is close enough
   * that the frame from `nearestS` is the relevant one.
   */
  private resolveBarriers(env: SimEnv, near: { dSigned: number; frame: { hw: number } }, dt: number): void {
    if (Math.abs(near.dSigned) <= near.frame.hw - 8) return;
    const rail = env.track.nearestS(this.pos.x, this.pos.z);
    // The wall face sits at hw + 1.6 and the car is about 1.5 m from its
    // centre to the outer tyre, so the car centre must stop at hw - 0.1.
    const lim = rail.frame.hw - 0.1;
    const lateral = Math.abs(rail.dSigned);
    if (lateral <= lim) return;

    const side = Math.sign(rail.dSigned);
    const rx = rail.frame.rx * side;
    const rz = rail.frame.rz * side;
    const excess = lateral - lim;
    this.pos.x -= rx * excess;
    this.pos.z -= rz * excess;

    const vOut = this.vel.x * rx + this.vel.z * rz;
    this.railTouchT = 0.6;
    // The rail is not frictionless: grinding along it scrubs speed, harder
    // contact scrubs more.
    const grind = 1 - Math.exp(-(0.5 + Math.max(0, vOut) * 0.15) * dt);
    this.vel.x -= this.vel.x * grind;
    this.vel.z -= this.vel.z * grind;
    if (vOut <= 0) return;

    this.vel.x -= rx * vOut * 1.35;
    this.vel.z -= rz * vOut * 1.35;
    this.impact = Math.max(this.impact, Math.min(0.7, vOut / 22));
    if (vOut > 4) this.railScrape = 0.35;
    if (vOut > 3) {
      // A rail strike while climbing must also eat the climb's vertical
      // momentum, or the car launches skyward.
      if (this.vel.y > 0) this.vel.y = Math.min(this.vel.y * clamp(1 - (vOut - 3) / 9, 0.1, 1), 4);
      this.wallHitT = 0.3;
    }
  }

  /** Copy the simulation state onto the render mesh. No-op when headless. */
  syncMesh(_dt: number, elapsed: number): void {
    const m = this.mesh;
    if (!m) return;
    m.position.copy(this.pos);
    m.rotation.set(0, this.yaw, 0);
    m.rotateX(this.visualPitch);
    m.rotateZ(this.visualRoll);

    const data = m.userData as CarVisualParts;
    const wheels = data.wheels;
    if (wheels) {
      for (const w of wheels) {
        w.tire.rotation.x = this.wheelRot;
        w.tire.rotation.z = Math.PI / 2;
        if (w.steerable) w.group.rotation.y = this.steerViz * 0.5;
      }
    }
    const flames = data.flames;
    if (flames) {
      const hot = this.boosting || this.turboing;
      const flick = 0.75 + 0.25 * Math.sin(elapsed * 47.0 + this.pos.x);
      const scale = (0.08 + this.throttleViz * 0.42 + (this.turboing ? 0.25 : 0)) * (hot ? 1.5 : 1.0) * flick;
      for (const f of flames) {
        f.scale.set(1, Math.max(0.04, scale), 1);
        const mat = f.material as THREE.MeshBasicMaterial;
        mat.opacity = clamp01(0.1 + this.throttleViz * 0.55 + (this.turboing ? 0.2 : 0)) * (hot ? 1 : 0.75);
        mat.color.set(this.turboing ? 0x9ffff0 : this.boosting ? 0x8fc8ff : 0x6f9fd0).multiplyScalar(hot ? 1.15 : 0.8);
      }
    }
    const driver = data.driver;
    if (driver) {
      driver.rotation.z = -this.steerViz * 0.35; // leans into the corner
      driver.rotation.x = this.visualPitch * 0.3;
      driver.position.y = 0.5 + Math.sin(elapsed * 2.2 + this.pos.x) * 0.008;
    }
    const under = data.underglow;
    if (under) {
      (under.material as THREE.MeshBasicMaterial).opacity =
        (0.1 + this.throttleViz * 0.1) * (this.grounded ? 1 : 0.4) +
        (this.boosting ? 0.12 : 0) +
        (this.turboing ? 0.18 : 0);
    }
    if (data.brakeMat) data.brakeMat.emissiveIntensity = this.braking ? 3.0 : 0.3;
    if (data.beaconMat) data.beaconMat.emissiveIntensity = 1.5 + Math.abs(Math.sin(elapsed * 5)) * 2.5;

    if (this.shieldMesh) {
      this.shieldMesh.visible = this.shieldT > 0;
      if (this.shieldMesh.visible) {
        const mat = (this.shieldMesh as THREE.Mesh).material as THREE.Material;
        const pulse = 0.25 + 0.12 * Math.sin(elapsed * 6) + (this.shieldT < 1 ? 0.15 * Math.sin(elapsed * 22) : 0);
        mat.opacity = Math.max(0.06, pulse);
      }
    }
  }
}

export interface CarVisualParts {
  wheels?: { group: THREE.Object3D; tire: THREE.Object3D; steerable: boolean }[];
  flames?: THREE.Mesh[];
  driver?: THREE.Object3D;
  underglow?: THREE.Mesh;
  brakeMat?: THREE.MeshStandardMaterial;
  beaconMat?: THREE.MeshStandardMaterial;
  livery?: { name: string; color: number };
}
