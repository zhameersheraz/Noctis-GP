/**
 * NOCTIS GP - arcade power-up field.
 *
 * Rows of item boxes along the racing line, four prank items, homing rockets,
 * dropped hazards, shields and a turbo, plus the explosion rings. Player and AI
 * share exactly the same rules; the only asymmetry is that a human has to
 * press a key to use an item.
 *
 * No DOM is touched here, so the whole field runs unchanged under the
 * headless verifier.
 */

import * as THREE from 'three';
import { clamp, angleWrap, TAU } from '../core/util';
import type { CarSim } from './car';
import type { ItemKind, SimEnv } from './types';

export const ITEM_TYPES: ItemKind[] = ['banana', 'rocket', 'shield', 'turbo'];

/** Box rows, placed by fraction of the lap so they survive layout edits. */
const ROW_FRACTIONS = [0.08, 0.22, 0.36, 0.48, 0.6, 0.72, 0.86, 0.95];
const BOXES_PER_ROW = 8;
const RESPAWN = 8; // seconds
const PEEL_LIFE = 50;
const ROCKET_LIFE = 6.5;

interface Box {
  grp: THREE.Group;
  core: THREE.Mesh;
  s: number;
  x: number;
  y: number;
  z: number;
  active: boolean;
  respawn: number;
  phase: number;
}

interface Peel {
  mesh: THREE.Object3D;
  x: number;
  z: number;
  owner: CarSim;
  arm: number;
  life: number;
}

interface Rocket {
  mesh: THREE.Object3D;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  owner: CarSim;
  life: number;
  age: number;
  target: CarSim | null;
  lastD?: number;
}

interface Fx {
  mesh: THREE.Mesh;
  life: number;
  t: number;
  maxScale: number;
}

export class ItemField {
  readonly group = new THREE.Group();
  private readonly boxes: Box[] = [];
  private readonly peels: Peel[] = [];
  private readonly rockets: Rocket[] = [];
  private readonly fx: Fx[] = [];
  private readonly env: SimEnv;
  private allowAiUse: (car: CarSim) => boolean;

  constructor(env: SimEnv) {
    this.env = env;
    this.allowAiUse = (car) => !car.isPlayer;
    this.buildBoxes();
    this.buildFxPool();
    env.scene.add(this.group);
  }

  setAiUsePolicy(fn: (car: CarSim) => boolean): void {
    this.allowAiUse = fn;
  }

  private buildBoxes(): void {
    const shellGeo = new THREE.IcosahedronGeometry(1.25, 0);
    const shellMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x9fd8ff).multiplyScalar(1.9),
      wireframe: true,
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    });
    const coreGeo = new THREE.OctahedronGeometry(0.55, 0);
    const coreMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xffffff).multiplyScalar(2.2),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });

    for (const frac of ROW_FRACTIONS) {
      const s = frac * this.env.track.length;
      const f = this.env.track.frameAt(s);
      for (let k = 0; k < BOXES_PER_ROW; k++) {
        const lat = -f.hw + 3.4 + (k * (2 * f.hw - 6.8)) / (BOXES_PER_ROW - 1);
        const x = f.x + f.rx * lat;
        const z = f.z + f.rz * lat;
        const y = this.env.terrain.sampleHeight(x, z) + 1.5;
        const grp = new THREE.Group();
        grp.position.set(x, y, z);
        grp.add(new THREE.Mesh(shellGeo, shellMat), new THREE.Mesh(coreGeo, (coreMat as THREE.Material).clone()));
        this.group.add(grp);
        this.boxes.push({
          grp,
          core: grp.children[1] as THREE.Mesh,
          s,
          x,
          y,
          z,
          active: true,
          respawn: 0,
          phase: Math.random() * TAU,
        });
      }
    }
  }

  private buildFxPool(): void {
    const ringGeo = new THREE.RingGeometry(0.55, 0.75, 24);
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0xffd9a0).multiplyScalar(2.0),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const m = new THREE.Mesh(ringGeo, mat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.env.scene.add(m);
      this.fx.push({ mesh: m, life: 0, t: 0, maxScale: 0 });
    }
  }

  private spawnFx(x: number, y: number, z: number, color: number, big: boolean): void {
    const slot = this.fx.find((f) => f.life <= 0);
    if (!slot) return;
    slot.mesh.visible = true;
    slot.mesh.position.set(x, y, z);
    (slot.mesh.material as THREE.MeshBasicMaterial).color.set(color).multiplyScalar(2.2);
    slot.life = slot.t = big ? 0.55 : 0.4;
    slot.maxScale = big ? 16 : 7;
  }

  reset(): void {
    for (const b of this.boxes) {
      b.active = true;
      b.respawn = 0;
      b.grp.visible = true;
      b.grp.scale.setScalar(1);
    }
    for (const p of this.peels) this.env.scene.remove(p.mesh);
    this.peels.length = 0;
    for (const r of this.rockets) this.env.scene.remove(r.mesh);
    this.rockets.length = 0;
  }

  /** Trailing cars get better rolls, which keeps the field bunched up. */
  private rollItem(standingsPos: number): Exclude<ItemKind, null> {
    const behind = standingsPos > 4;
    const w: Record<Exclude<ItemKind, null>, number> = behind
      ? { banana: 0.26, rocket: 0.46, shield: 0.08, turbo: 0.2 }
      : { banana: 0.4, rocket: 0.34, shield: 0.12, turbo: 0.14 };
    let r = Math.random() * (w.banana + w.rocket + w.shield + w.turbo);
    for (const t of ITEM_TYPES) {
      if (t === null) continue;
      r -= w[t];
      if (r <= 0) return t;
    }
    return 'banana';
  }

  giveRandomItem(car: CarSim, standingsPos: number): boolean {
    if (car.item) return false;
    car.item = this.rollItem(standingsPos);
    this.env.audio.itemPickup();
    return true;
  }

  useItem(car: CarSim, cars: CarSim[]): void {
    const it = car.item;
    if (!it) return;
    car.item = null;
    const fwdX = Math.sin(car.yaw);
    const fwdZ = Math.cos(car.yaw);

    if (it === 'banana') {
      const x = car.pos.x - fwdX * 4.5;
      const z = car.pos.z - fwdZ * 4.5;
      const y = this.env.terrain.sampleHeight(x, z) + 0.2;
      const mesh = makePeelMesh();
      mesh.position.set(x, y, z);
      this.env.scene.add(mesh);
      this.peels.push({ mesh, x, z, owner: car, arm: 0.15, life: PEEL_LIFE });
      this.env.audio.splat();
      return;
    }

    if (it === 'rocket') {
      const x = car.pos.x + fwdX * 3;
      const z = car.pos.z + fwdZ * 3;
      const mesh = makeRocketMesh();
      mesh.position.set(x, car.pos.y + 0.6, z);
      mesh.rotation.y = car.yaw;
      this.env.scene.add(mesh);
      const sp = Math.max(95, car.speed + 55);
      // Lock onto the next car ahead ALONG THE TRACK rather than in a cone:
      // arcade-style, so firing while sliding still chases the one in front.
      const L = this.env.track.length;
      let victim: CarSim | null = null;
      let bestGap = 560;
      for (const o of cars) {
        if (o === car || o.finished) continue;
        const gap = (o.s - car.s + L) % L;
        if (gap > 2 && gap < bestGap) {
          bestGap = gap;
          victim = o;
        }
      }
      this.rockets.push({
        mesh,
        x,
        y: car.pos.y + 0.6,
        z,
        vx: fwdX * sp + car.vel.x * 0.3,
        vz: fwdZ * sp + car.vel.z * 0.3,
        owner: car,
        life: ROCKET_LIFE,
        age: 0,
        target: victim,
      });
      this.env.audio.rocketLaunch();
      return;
    }

    if (it === 'shield') {
      car.shieldT = 5.5;
      this.env.audio.shieldUp();
      return;
    }

    if (it === 'turbo') {
      car.turboT = 2.4;
      this.env.audio.turbo();
    }
  }

  private hitCar(car: CarSim, heavy: boolean): boolean {
    if (car.shieldT > 0) {
      car.shieldT = 0; // a shield absorbs exactly one hit
      this.spawnFx(car.pos.x, car.pos.y + 0.5, car.pos.z, 0x66ccff, false);
      this.env.audio.shieldBlock();
      return false;
    }
    car.stunT = heavy ? 1.7 : 1.3;
    car.stunSpin = (Math.random() < 0.5 ? -1 : 1) * (heavy ? 4.6 : 3.6) * (0.8 + Math.random() * 0.4);
    const keep = heavy ? 0.5 : 0.65;
    car.vel.x *= keep;
    car.vel.z *= keep;
    car.impact = 1;
    this.spawnFx(car.pos.x, car.pos.y + 0.4, car.pos.z, 0xffd9a0, heavy);
    if (heavy) {
      for (let i = 0; i < 22; i++) {
        const a = Math.random() * TAU;
        this.env.dust.emit(
          car.pos.x,
          car.pos.y,
          car.pos.z,
          Math.cos(a) * (3 + Math.random() * 6),
          2 + Math.random() * 5,
          Math.sin(a) * (3 + Math.random() * 6),
          0.6 + Math.random() * 0.8,
          0.9 + Math.random() * 0.9,
        );
      }
    }
    this.env.audio.explosion();
    return true;
  }

  update(dt: number, cars: CarSim[], standingsOf: (car: CarSim) => number, pickupsEnabled: boolean): void {
    this.updateBoxes(dt, cars, standingsOf, pickupsEnabled);
    this.updatePeels(dt, cars);
    this.updateRockets(dt, cars);
    this.updateFx(dt);
    this.updateAiUsage(dt, cars);
  }

  private updateBoxes(dt: number, cars: CarSim[], standingsOf: (c: CarSim) => number, enabled: boolean): void {
    for (const b of this.boxes) {
      if (!b.active) {
        b.respawn -= dt;
        if (b.respawn <= 0) {
          b.active = true;
          b.grp.visible = true;
          b.grp.scale.setScalar(0.01);
        }
        continue;
      }
      b.phase += dt;
      b.grp.rotation.y += dt * 1.6;
      b.grp.position.y = b.y + Math.sin(b.phase * 1.8) * 0.28;
      const pop = Math.min(1, b.grp.scale.x + dt * 4);
      if (pop < 1) b.grp.scale.setScalar(pop);
      (b.core.material as THREE.MeshBasicMaterial).opacity = 0.65 + 0.3 * Math.sin(b.phase * 4);

      if (!enabled) continue;
      for (const car of cars) {
        if (car.item) continue;
        const dx = car.pos.x - b.x;
        const dz = car.pos.z - b.z;
        if (dx * dx + dz * dz < 9 && Math.abs(car.pos.y - b.y) < 3.5) {
          this.giveRandomItem(car, standingsOf(car));
          b.active = false;
          b.respawn = RESPAWN;
          b.grp.visible = false;
          this.spawnFx(b.x, b.y, b.z, 0x9fd8ff, false);
          break;
        }
      }
    }
  }

  private updatePeels(dt: number, cars: CarSim[]): void {
    for (let i = this.peels.length - 1; i >= 0; i--) {
      const p = this.peels[i];
      p.life -= dt;
      p.arm -= dt;
      p.mesh.rotation.y += dt * 1.2;
      if (p.life <= 0) {
        this.env.scene.remove(p.mesh);
        this.peels.splice(i, 1);
        continue;
      }
      if (p.arm > 0) continue;
      for (const car of cars) {
        if (car === p.owner) continue;
        // Swept test against the segment covered this frame: at 250 km/h a
        // point test tunnels straight through the hazard.
        const px = car.pos.x - car.vel.x * dt;
        const pz = car.pos.z - car.vel.z * dt;
        const ex = car.pos.x - px;
        const ez = car.pos.z - pz;
        const len2 = ex * ex + ez * ez || 1e-6;
        const t = Math.max(0, Math.min(1, ((p.x - px) * ex + (p.z - pz) * ez) / len2));
        const qx = px + ex * t - p.x;
        const qz = pz + ez * t - p.z;
        if (qx * qx + qz * qz < 3.2 && car.grounded) {
          this.hitCar(car, false);
          this.env.audio.splat();
          this.env.scene.remove(p.mesh);
          this.peels.splice(i, 1);
          break;
        }
      }
    }
  }

  private updateRockets(dt: number, cars: CarSim[]): void {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.life -= dt;
      r.age += dt;

      if (r.age > 0.18) {
        // Homing with lead prediction. If the lock is gone, acquire anyone
        // broadly ahead of the flight path instead of flying on useless.
        if (!r.target || r.target.finished) {
          let best: CarSim | null = null;
          let bestD = 260 * 260;
          const sp0 = Math.hypot(r.vx, r.vz) || 1;
          for (const car of cars) {
            if (car === r.owner) continue;
            const dx = car.pos.x - r.x;
            const dz = car.pos.z - r.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > bestD || d2 < 4) continue;
            if ((dx * r.vx + dz * r.vz) / (Math.sqrt(d2) * sp0) < 0.35) continue;
            bestD = d2;
            best = car;
          }
          r.target = best;
        }

        if (r.target) {
          const sp = Math.hypot(r.vx, r.vz);
          const ddx = r.target.pos.x - r.x;
          const ddz = r.target.pos.z - r.z;
          const dist = Math.hypot(ddx, ddz);
          // Aim ahead of the victim so the intercept works at closing speed.
          const lead = Math.min(0.55, dist / Math.max(sp, 1));
          let ax = r.target.pos.x + r.target.vel.x * lead - r.x;
          let az = r.target.pos.z + r.target.vel.z * lead - r.z;
          // Long range: bias along the road so the chase stays in the corridor
          // instead of cutting across the boulder fields.
          if (dist > 110) {
            const nearSelf = this.env.track.nearestS(r.x, r.z);
            const f2 = this.env.track.frameAt(nearSelf.s + 45);
            const al = Math.hypot(ax, az) || 1;
            const k = clamp((dist - 110) / 220, 0, 0.6);
            ax = (ax / al) * (1 - k) + f2.tx * k;
            az = (az / al) * (1 - k) + f2.tz * k;
          }
          const want = Math.atan2(ax, az);
          const cur = Math.atan2(r.vx, r.vz);
          // Terminal guidance doubles authority so it cannot orbit the target.
          const rate = dist < 30 ? 13 : 5.5;
          const a = cur + clamp(angleWrap(want - cur), -rate * dt, rate * dt);
          // Keep overtaking even if the victim is boosting.
          const spNew = Math.max(95, r.target.speed + 45);
          r.vx = Math.sin(a) * spNew;
          r.vz = Math.cos(a) * spNew;
          // Graze fuse: passed the closest point right beside the victim.
          if (dist < 10 && r.lastD !== undefined && dist > r.lastD + 0.05) {
            this.hitCar(r.target, true);
            r.life = 0;
          }
          r.lastD = dist;
        }
      }

      r.x += r.vx * dt;
      r.z += r.vz * dt;
      // Terrain-following hover, looking slightly ahead so ramps do not clip it.
      const ground = Math.max(
        this.env.terrain.sampleHeight(r.x, r.z),
        this.env.terrain.sampleHeight(r.x + r.vx * 0.12, r.z + r.vz * 0.12),
      );
      const wantY = ground + 0.95 + Math.sin(r.age * 7) * 0.12;
      r.y += clamp(wantY - r.y, -22 * dt, 22 * dt);
      r.mesh.position.set(r.x, r.y, r.z);
      r.mesh.rotation.y = Math.atan2(r.vx, r.vz);
      const flame = r.mesh.userData.flame as THREE.Mesh | undefined;
      if (flame) flame.scale.y = 0.9 + 0.4 * Math.sin(r.age * 60);
      this.env.dust.emit(
        r.x - r.vx * 0.02,
        r.y,
        r.z - r.vz * 0.02,
        (Math.random() - 0.5) * 2,
        0.6 + Math.random(),
        (Math.random() - 0.5) * 2,
        0.35 + Math.random() * 0.3,
        0.35 + Math.random() * 0.25,
      );

      let detonated = r.life <= 0 || r.y <= ground + 0.55;
      if (!detonated) {
        for (const car of cars) {
          if (car === r.owner) continue;
          const dx = car.pos.x - r.x;
          const dz = car.pos.z - r.z;
          // Proximity fuse: skimming the bumper still sets it off.
          if (dx * dx + dz * dz < 20 && Math.abs(car.pos.y - r.y) < 2.6) {
            this.hitCar(car, true);
            detonated = true;
            break;
          }
        }
      }
      if (!detonated) {
        const bs = this.env.terrain.bouldersNear(r.x, r.z, 1, []);
        for (const b of bs) {
          const dx = b.x - r.x;
          const dz = b.z - r.z;
          if (dx * dx + dz * dz < (b.r + 0.5) ** 2) {
            detonated = true;
            this.spawnFx(r.x, r.y, r.z, 0xffd9a0, false);
            break;
          }
        }
      }
      if (detonated) {
        this.spawnFx(r.x, r.y, r.z, 0xffd9a0, true);
        this.env.scene.remove(r.mesh);
        this.rockets.splice(i, 1);
      }
    }
  }

  private updateFx(dt: number): void {
    for (const fx of this.fx) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.mesh.visible = false;
        continue;
      }
      const k = 1 - fx.life / fx.t;
      fx.mesh.scale.setScalar(0.5 + k * fx.maxScale);
      (fx.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.8;
    }
  }

  /** AI item usage. A human player only fires by pressing a key. */
  private updateAiUsage(dt: number, cars: CarSim[]): void {
    for (const car of cars) {
      if (!car.ai || !car.item || !this.allowAiUse(car)) continue;
      car.aiUseCd = Math.max(0, car.aiUseCd - dt);
      if (car.aiUseCd > 0) continue;
      const fwdX = Math.sin(car.yaw);
      const fwdZ = Math.cos(car.yaw);
      let ahead: CarSim | null = null;
      let aheadD = Infinity;
      let behind: CarSim | null = null;
      let behindD = Infinity;
      for (const o of cars) {
        if (o === car) continue;
        const dx = o.pos.x - car.pos.x;
        const dz = o.pos.z - car.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        const dot = (dx * fwdX + dz * fwdZ) / d;
        if (dot > 0.85 && d < aheadD) {
          aheadD = d;
          ahead = o;
        }
        if (dot < -0.7 && d < behindD) {
          behindD = d;
          behind = o;
        }
      }
      if (car.item === 'rocket' && ahead && aheadD < 170) {
        this.useItem(car, cars);
        car.aiUseCd = 2.5;
      } else if (car.item === 'banana' && behind && behindD < 42) {
        this.useItem(car, cars);
        car.aiUseCd = 2.5;
      } else if (car.item === 'shield' && behind && behindD < 75) {
        this.useItem(car, cars);
        car.aiUseCd = 2.5;
      } else if (car.item === 'turbo') {
        const f = this.env.track.frameAt(car.s + 40);
        const turn = Math.abs(angleWrap(Math.atan2(f.tx, f.tz) - car.yaw));
        if (turn < 0.35 && car.speed < 68) {
          this.useItem(car, cars);
          car.aiUseCd = 2.5;
        }
      }
    }
  }
}

function makePeelMesh(): THREE.Group {
  const grp = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe14d).multiplyScalar(1.7), toneMapped: false });
  const peel = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.16, 6, 12, Math.PI * 1.35), mat);
  peel.rotation.x = Math.PI / 2;
  grp.add(peel);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 5), mat);
  tip.position.set(0.35, 0, 0.45);
  grp.add(tip);
  return grp;
}

function makeRocketMesh(): THREE.Group {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.22, 1.1, 8),
    new THREE.MeshStandardMaterial({ color: 0xdde3ea, metalness: 0.8, roughness: 0.3 }),
  );
  body.rotation.x = Math.PI / 2;
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.5, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff5544).multiplyScalar(1.5), toneMapped: false }),
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 0.8;
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.7, 7, 1, true),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xffb066).multiplyScalar(1.8),
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  flame.rotation.x = -Math.PI / 2;
  flame.position.z = -0.85;
  grp.add(body, nose, flame);
  grp.userData.flame = flame;
  return grp;
}

export function makeShieldMesh(): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(2.3, 14, 10),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x66ccff).multiplyScalar(1.3),
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  m.visible = false;
  return m;
}
