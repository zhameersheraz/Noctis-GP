/**
 * NOCTIS GP - AI driver.
 *
 * Produces the same DriveInput a human produces and runs against the same
 * CarSim, so there is no "rubber banding" hidden in the physics: the AI is
 * only ever choosing a target speed and a steering angle.
 *
 * Two ideas do most of the work:
 *   - target speed from a corner-speed model that mirrors the vehicle's own
 *     lateral-acceleration budget, so the AI brakes exactly when the physics
 *     says it has to;
 *   - steering from an aim point on the racing line, damped by yaw rate and
 *     lateral velocity so fast rejoins do not oscillate.
 */

import { clamp, clamp01, angleWrap } from '../core/util';
import { GRAVITY, MAGLEV } from './car';
import type { CarSim } from './car';
import type { DriveInput, SimEnv } from './types';

const AI_DT = 1 / 120; // the AI is stepped on the physics substep, not the frame

export class AIController {
  readonly car: CarSim;
  /** Top-speed factor. */
  skill: number;
  /** Corner-speed factor. */
  boldness: number;
  offset = 0;
  private targetOffset = 0;
  private offsetTimer = 0;
  private recoverTimer = 0;
  private passSide = 1;

  /**
   * Catch-up multiplier, set by the race director from the gap to the player.
   * Smoothed here rather than applied raw, so a rival does not visibly change
   * pace every time it crosses the line.
   */
  private bias = 1;
  private biasTarget = 1;

  constructor(car: CarSim, opts: { skill?: number; boldness?: number } = {}) {
    this.car = car;
    this.skill = opts.skill ?? 0.96;
    this.boldness = opts.boldness ?? 0.94;
  }

  /** 1 = drive at normal pace, < 1 = ease off, > 1 = press on. */
  setCatchUp(bias: number): void {
    this.biasTarget = clamp(bias, 0.8, 1.06);
  }

  /** Diagnostics only. */
  debugBias(): number {
    return this.bias;
  }

  computeInput(env: SimEnv, rivals: CarSim[]): DriveInput {
    const car = this.car;
    const track = env.track;
    const sp = car.speed;
    const input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };

    this.bias += (this.biasTarget - this.bias) * 0.02;
    const skill = this.skill * this.bias;
    const bold = this.boldness * this.bias;

    // ---- recovery from being stuck or spun -------------------------------
    if (car.stuckTimer > 1.6) this.recoverTimer = 1.2;
    if (this.recoverTimer > 0) {
      this.recoverTimer -= AI_DT;
      input.throttle = 0.2;
      input.steer = Math.sin(this.recoverTimer * 9) * 0.8;
      if (car.stuckTimer > 3.2) {
        car.resetToTrack(env);
        this.recoverTimer = 0;
      }
      return input;
    }

    // ---- curvature over several lookaheads -------------------------------
    const la1 = 26 + sp * 0.55;
    const f0 = track.frameAt(car.s);
    const h0 = Math.atan2(f0.tx, f0.tz);
    const hA = Math.atan2(track.frameAt(car.s + la1 * 0.5).tx, track.frameAt(car.s + la1 * 0.5).tz);
    const hB = Math.atan2(track.frameAt(car.s + la1).tx, track.frameAt(car.s + la1).tz);
    const hC = Math.atan2(track.frameAt(car.s + la1 * 1.8).tx, track.frameAt(car.s + la1 * 1.8).tz);
    const curv = Math.max(
      Math.abs(angleWrap(hA - h0)) / (la1 * 0.5),
      Math.abs(angleWrap(hB - hA)) / (la1 * 0.5),
      Math.abs(angleWrap(hC - hB)) / (la1 * 0.8),
    );
    const f1 = track.frameAt(car.s + la1);

    // Same lateral budget CarSim.step uses, with a margin, plus a bonus for
    // banking: a steeply banked corner really can be taken faster.
    const bankBonus = 1 + Math.abs(Math.tan(f1.bank)) * 0.55;
    const aLat = (GRAVITY + MAGLEV * sp * sp) * 1.18 * bankBonus * 0.85;
    const vCorner = curv > 1e-4 ? Math.sqrt((aLat * bold) / curv) : 999;
    let vTarget = Math.min(87 * skill, vCorner);

    // ---- traffic ----------------------------------------------------------
    let ahead: CarSim | null = null;
    let aheadGap = Infinity;
    for (const r of rivals) {
      if (r === car) continue;
      const gap = r.totalDist - car.totalDist;
      if (gap > 0 && gap < aheadGap) {
        aheadGap = gap;
        ahead = r;
      }
    }
    const nearSelf = track.nearestS(car.pos.x, car.pos.z);
    const offRoadNow = nearSelf.dist > nearSelf.frame.hw + 3;

    if (offRoadNow) {
      this.targetOffset = 0;
      input.throttle = 0.8;
      // Big slide off-road: point the body into it so grip can bite again.
      const slipAng = angleWrap(Math.atan2(car.vel.x, car.vel.z) - car.yaw);
      if (Math.abs(slipAng) > 0.5 && sp > 14) {
        input.steer = clamp(slipAng * 1.1, -0.85, 0.85);
        input.throttle = 0.35;
        return input;
      }
      // Gentle merge: aim a long way down the centerline, low steering gain.
      const laM = clamp(sp * 1.1, 30, 80);
      const fm = track.frameAt(car.s + laM);
      const err = angleWrap(Math.atan2(fm.x - car.pos.x, fm.z - car.pos.z) - car.yaw);
      input.steer = clamp(err * 1.0 - car.yawVel * 0.45, -0.45, 0.45);
      input.throttle = sp < 40 ? 0.8 : 0.25;
      return input;
    }

    if (ahead && aheadGap < 55) {
      // Pick a side and commit to it for a while, otherwise the AI weaves.
      if (this.passSide === 0) this.passSide = Math.sin(car.s * 0.013 + car.color) > 0 ? 1 : -1;
      this.targetOffset = this.passSide * clamp(9 - aheadGap * 0.08, 5.5, 9);
      if (aheadGap < 26 && sp > ahead.speed) vTarget = Math.min(vTarget, ahead.speed * 0.98);
      if (aheadGap < 30 && car.boost > 0.4 && curv < 0.004) input.boost = true;
    } else {
      this.passSide = 0;
      if (this.offsetTimer <= 0) {
        // Racing line: drift towards the inside of the upcoming turn. The
        // heading angle decreases through a left turn, so the inside is the
        // negative-right side. Kept small in sharp corners, because the
        // inside of this circuit is where the craters are.
        const turn = angleWrap(hC - h0);
        const sharp = clamp01(curv / 0.003);
        this.targetOffset = clamp(turn * 18, -4, 4) * (1 - sharp * 0.75);
        this.offsetTimer = 0.5;
      }
    }
    this.offsetTimer -= AI_DT;
    this.offset += (this.targetOffset - this.offset) * 0.025;

    // ---- side by side: do not drive through each other -------------------
    for (const r of rivals) {
      if (r === car) continue;
      if (Math.abs(r.totalDist - car.totalDist) >= 5.5) continue;
      const lat = (r.pos.x - car.pos.x) * f0.rx + (r.pos.z - car.pos.z) * f0.rz;
      if (Math.abs(lat) < 4.2) {
        this.offset -= Math.sign(lat || 1) * 0.35;
        vTarget = Math.min(vTarget, sp + 2);
      }
    }

    // ---- aim point on the line -------------------------------------------
    const look = track.frameAt(car.s + la1 * 0.8);
    const off = clamp(this.offset, -look.hw + 3, look.hw - 3);
    const aimAng = Math.atan2(look.x + look.rx * off - car.pos.x, look.z + look.rz * off - car.pos.z);
    let err = angleWrap(aimAng - car.yaw);
    // If the car is pointing away from the track, force a strong correction.
    if (Math.sin(car.yaw) * f0.tx + Math.cos(car.yaw) * f0.tz < -0.2) err += Math.sign(err || 1) * 0.8;
    const latVel = car.vel.x * f0.rx + car.vel.z * f0.rz; // m/s across the road
    const slipDamp = clamp(latVel * 0.045, -0.55, 0.55);
    input.steer = clamp(err * 1.35 - car.yawVel * 0.55 - slipDamp, -1, 1);

    // ---- throttle / brake -------------------------------------------------
    if (sp < vTarget * 0.985) {
      input.throttle = 1;
      if (sp < vTarget * 0.8 && car.boost > 0.55 && curv < 0.0035) input.boost = true;
    } else if (sp > vTarget * 1.04) {
      input.brake = clamp01((sp - vTarget) / 18);
    } else {
      input.throttle = 0.55;
    }

    // Handbrake only into genuinely tight corners, carrying too much speed.
    if (curv > 0.021 && sp > vTarget * 1.12 && sp > 22) {
      input.handbrake = true;
      input.brake = Math.max(input.brake, 0.35);
    }
    return input;
  }
}
