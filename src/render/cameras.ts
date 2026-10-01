/**
 * NOCTIS GP - cameras.
 *
 * Two very different jobs:
 *   ChaseCam      tight behind the car, speed-reactive FOV, impact shake.
 *   CinematicCam  the attract loop. Every shot is defined RELATIVE to the
 *                 focus car's current road frame, so the pack is always in
 *                 shot, the camera banks with the road through the pit, and it
 *                 catches the sun and Earth whenever the road heads their way.
 */

import * as THREE from 'three';
import { damp, clamp } from '../core/util';
import type { CarSim } from '../sim/car';
import type { Terrain } from '../sim/terrain';
import type { Track } from '../sim/track';

export class ChaseCam {
  private readonly cam: THREE.PerspectiveCamera;
  private readonly pos = new THREE.Vector3(0, 5, -10);
  private readonly look = new THREE.Vector3();
  private shake = 0;

  constructor(cam: THREE.PerspectiveCamera) {
    this.cam = cam;
  }

  snap(car: CarSim, terrain: Terrain): void {
    const fwd = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
    this.pos.set(car.pos.x - fwd.x * 9, car.pos.y + 3.5, car.pos.z - fwd.z * 9);
    this.look.copy(car.pos);
    const ground = terrain.sampleHeight(this.pos.x, this.pos.z) + 1.6;
    if (this.pos.y < ground) this.pos.y = ground;
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
  }

  update(dt: number, car: CarSim, terrain: Terrain): void {
    const sp = car.speed;
    const fwd = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
    // Tight chase: the car stays big in frame even at top speed.
    const dist = 7.0 + sp * 0.03;
    const height = 2.7 + sp * 0.012 + (car.grounded ? 0 : Math.min(2.5, car.airTime * 1.6));
    const desired = new THREE.Vector3(car.pos.x - fwd.x * dist, car.pos.y + height, car.pos.z - fwd.z * dist);
    const ground = terrain.sampleHeight(desired.x, desired.z) + 1.4;
    if (desired.y < ground) desired.y = ground;
    this.pos.x = damp(this.pos.x, desired.x, 5.5, dt);
    this.pos.y = damp(this.pos.y, desired.y, 4.0, dt);
    this.pos.z = damp(this.pos.z, desired.z, 5.5, dt);

    const lookTarget = new THREE.Vector3(
      car.pos.x + fwd.x * (9 + sp * 0.1),
      car.pos.y + 1.3 + clamp(car.vel.y * 0.06, -1.5, 3),
      car.pos.z + fwd.z * (9 + sp * 0.1),
    );
    this.look.x = damp(this.look.x, lookTarget.x, 7, dt);
    this.look.y = damp(this.look.y, lookTarget.y, 6, dt);
    this.look.z = damp(this.look.z, lookTarget.z, 7, dt);

    this.shake = Math.max(car.impact * 0.5, this.shake - dt * 1.5);
    const sh = this.shake * this.shake;
    this.cam.position.set(
      this.pos.x + (Math.random() - 0.5) * sh * 0.6,
      this.pos.y + (Math.random() - 0.5) * sh * 0.4,
      this.pos.z + (Math.random() - 0.5) * sh * 0.6,
    );
    this.cam.lookAt(this.look);
    const kick = car.boosting || car.turboing ? 8 : 0;
    this.cam.fov = damp(this.cam.fov, 60 + Math.min(13, sp * 0.16) + kick, kick ? 6 : 3, dt);
    this.cam.updateProjectionMatrix();
  }
}

interface Shot {
  /** Metres behind (-) or ahead (+) of the focus car along the centerline. */
  along: number;
  /** Metres across the road; positive is right of travel. */
  side: number;
  /** Metres above the road surface. */
  up: number;
  /** Metres ahead of the car to aim at; negative looks back at the pack. */
  look: number;
  fov: number;
  /** Seconds to hold before cutting. */
  hold: number;
}

const SHOTS: Shot[] = [
  { along: -10, side: 3.5, up: 2.2, look: 45, fov: 50, hold: 7 },
  { along: -24, side: -10, up: 7.0, look: 22, fov: 46, hold: 6 },
  { along: 16, side: 4.5, up: 1.7, look: -26, fov: 55, hold: 5 },
  { along: -70, side: 16, up: 15, look: 70, fov: 42, hold: 6 },
  { along: -5, side: -2.5, up: 1.35, look: 75, fov: 62, hold: 5 },
  { along: -130, side: 44, up: 60, look: 90, fov: 50, hold: 6 },
  { along: 30, side: -14, up: 9, look: -40, fov: 48, hold: 5 },
  { along: -40, side: 2, up: 3.2, look: 120, fov: 44, hold: 6 },
];

export class CinematicCam {
  private readonly cam: THREE.PerspectiveCamera;
  private readonly track: Track;
  private readonly terrain: Terrain;
  private shot = 0;
  private shotT = 0;
  private readonly pos = new THREE.Vector3(0, 10, 0);
  private readonly look = new THREE.Vector3();
  private started = false;

  constructor(cam: THREE.PerspectiveCamera, track: Track, terrain: Terrain) {
    this.cam = cam;
    this.track = track;
    this.terrain = terrain;
  }

  update(dt: number, focus: CarSim | null): void {
    if (!focus) return;
    let cut = !this.started;
    this.shotT += dt;
    if (this.shotT > SHOTS[this.shot].hold) {
      this.shotT = 0;
      this.shot = (this.shot + 1) % SHOTS.length;
      // Hard cut between shots: a glide would tunnel through the hillsides.
      cut = true;
    }
    const cur = SHOTS[this.shot];

    const fPos = this.track.frameAt(focus.s + cur.along);
    const px = fPos.x + fPos.rx * cur.side;
    const pz = fPos.z + fPos.rz * cur.side;
    const desired = new THREE.Vector3(px, this.terrain.sampleHeight(px, pz) + cur.up, pz);
    const ground = this.terrain.sampleHeight(desired.x, desired.z) + 1.8;
    if (desired.y < ground) desired.y = ground;

    const fLook = this.track.frameAt(focus.s + cur.look);
    const lookTarget = new THREE.Vector3(fLook.x, fLook.y + 2.0, fLook.z);
    // Pull the aim onto the pack itself when looking back at it.
    if (cur.look < 0) lookTarget.lerp(focus.pos.clone().add(new THREE.Vector3(0, 1.5, 0)), 0.7);

    const lambda = cut ? 1000 : 0.9;
    this.pos.x = damp(this.pos.x, desired.x, lambda, dt);
    this.pos.y = damp(this.pos.y, desired.y, lambda, dt);
    this.pos.z = damp(this.pos.z, desired.z, lambda, dt);
    this.look.x = damp(this.look.x, lookTarget.x, lambda, dt);
    this.look.y = damp(this.look.y, lookTarget.y, lambda, dt);
    this.look.z = damp(this.look.z, lookTarget.z, lambda, dt);
    this.started = true;

    // Even the damped in-shot path must never dip under the surface.
    const floor = this.terrain.sampleHeight(this.pos.x, this.pos.z) + 1.2;
    if (this.pos.y < floor) this.pos.y = floor;

    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
    this.cam.fov = damp(this.cam.fov, cur.fov, cut ? 1000 : 1.6, dt);
    this.cam.updateProjectionMatrix();
  }
}
