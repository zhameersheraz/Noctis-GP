/**
 * NOCTIS GP - ballistic regolith dust.
 *
 * There is no air on the Moon, so the dust a car kicks up does not billow or
 * drift: each grain flies a clean parabola and lands. That makes a single
 * integrate-and-decay pass physically correct and very cheap, which is what
 * lets one shared particle buffer serve all eight cars.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/util';
import type { CarSim } from '../sim/car';
import type { Terrain } from '../sim/terrain';

const MAX = 3200;
const G = 2.6;

export class Dust {
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX);
  private readonly maxLife = new Float32Array(MAX);
  private readonly size = new Float32Array(MAX);
  private head = 0;
  private readonly emitAcc = new Map<CarSim, number>();
  readonly points: THREE.Points;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    geo.setAttribute('aMaxLife', new THREE.BufferAttribute(this.maxLife, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uColor: { value: new THREE.Color(0x7d786f) },
        uPix: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aLife;
        attribute float aMaxLife;
        attribute float aSize;
        uniform float uPix;
        varying float vFade;
        void main() {
          vFade = clamp(aLife / max(aMaxLife, 0.001), 0.0, 1.0);
          vFade = smoothstep(0.0, 0.25, vFade) * vFade;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPix * 200.0 / max(-mv.z, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vFade;
        uniform vec3 uColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25) discard;
          gl_FragColor = vec4(uColor, (1.0 - r * 4.0) * vFade * 0.32);
        }
      `,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  setPixelRatio(pr: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uPix.value = pr;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number): void {
    const i = this.head;
    this.head = (this.head + 1) % MAX;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
  }

  /** Called once per frame per car. */
  emitFromCar(car: CarSim, dt: number, terrain: Terrain): void {
    if (!car.grounded) return;
    const sp = car.speed;
    if (sp < 8) return;
    const intensity = (0.35 + car.slip * 1.4 + car.offroad * 2.2 + car.impact * 3.0) * clamp01(sp / 40);
    let acc = (this.emitAcc.get(car) ?? 0) + intensity * dt * 90;
    this.emitAcc.set(car, acc);
    const fwdX = Math.sin(car.yaw);
    const fwdZ = Math.cos(car.yaw);
    while (acc >= 1) {
      acc -= 1;
      const side = (Math.random() - 0.5) * 2.4;
      const back = -1.8 - Math.random() * 0.8;
      const x = car.pos.x + fwdZ * side + fwdX * back;
      const z = car.pos.z - fwdX * side + fwdZ * back;
      const y = terrain.sampleHeight(x, z) + 0.25;
      const out = (Math.random() - 0.5) * 2;
      this.emit(
        x,
        y,
        z,
        car.vel.x * 0.06 + fwdZ * out * sp * 0.05 + (Math.random() - 0.5) * 1.5,
        0.6 + Math.random() * 1.7 + car.impact * 4,
        car.vel.z * 0.06 - fwdX * out * sp * 0.05 + (Math.random() - 0.5) * 1.5,
        0.3 + Math.random() * 0.55 + car.offroad * 0.5,
        1.1 + Math.random() * 1.5,
      );
    }
    this.emitAcc.set(car, acc);
  }

  update(dt: number, terrain: Terrain): void {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        continue;
      }
      // Vacuum: no drag, just gravity, so grains land where they were thrown.
      this.vel[i * 3 + 1] -= G * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < terrain.sampleHeight(this.pos[i * 3], this.pos[i * 3 + 2])) {
        this.life[i] = 0;
        this.size[i] = 0;
      }
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aLife.needsUpdate = true;
    g.attributes.aMaxLife.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
}
