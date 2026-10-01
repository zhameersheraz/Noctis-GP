/**
 * NOCTIS GP - procedural lunar heightfield for the Serenitatis circuit.
 *
 * One Float32Array of heights is the single source of truth: the render mesh
 * is built from it, the circuit is carved into it, and the vehicle physics
 * samples it bilinearly. The road you see IS the surface you drive on.
 */

import * as THREE from 'three';
import { fbm2, valueNoise2, mulberry32, smoothstep, clamp, lerp } from '../core/util';
import { RAMP_AMP, RAMP_SIGMA, RAMP_SIGMA_OUT } from './track';
import type { RidgeFrame, Track } from './track';

export const WORLD = 8000; // metres, centred on the origin
export const GRID = 1024; // cells per side -> 1025^2 vertices
const CELL = WORLD / GRID;
const HALF = WORLD / 2;
const VERTS = (GRID + 1) * (GRID + 1);

/** How far the launch kicker extends either side of the road, metres. */
const KICKER_HALF_WIDTH = 520;

interface Crater {
  x: number;
  z: number;
  r: number;
  depth: number;
  rim: number;
}

export const CRATERS: Crater[] = [
  { x: -1370, z: 165, r: 820, depth: 105, rim: 30 }, // A - THE PIT
  { x: 820, z: 760, r: 330, depth: 78, rim: 14 }, // B - hairpin rim
  { x: 300, z: 640, r: 330, depth: 62, rim: 16 },
  { x: -260, z: -420, r: 260, depth: 44, rim: 12 },
  { x: 700, z: -280, r: 420, depth: 78, rim: 20 },
  { x: -1520, z: -700, r: 300, depth: 55, rim: 15 },
  { x: 1900, z: 1150, r: 240, depth: 40, rim: 12 },
  { x: -560, z: 1780, r: 350, depth: 60, rim: 16 },
  { x: 640, z: -1900, r: 280, depth: 48, rim: 13 },
  { x: -1620, z: 990, r: 200, depth: 34, rim: 10 },
  { x: 1500, z: 1700, r: 170, depth: 28, rim: 9 },
  { x: -45, z: 180, r: 120, depth: 18, rim: 7 },
  { x: 1320, z: -1330, r: 150, depth: 24, rim: 8 },
  { x: -1180, z: -1450, r: 220, depth: 36, rim: 11 },
];

function craterHeight(x: number, z: number): number {
  let h = 0;
  for (const c of CRATERS) {
    const u = Math.hypot(x - c.x, z - c.z) / c.r;
    if (u < 1) h -= c.depth * (1 - u * u);
    h += c.rim * Math.exp(-(((u - 1) / 0.17) ** 2));
    if (u > 1 && u < 2.2) h -= c.depth * 0.06 * Math.exp(-(((u - 1.5) / 0.5) ** 2));
  }
  return h;
}

/** Re-exported so terrain consumers get the orientation type from one place. */
export type { RidgeFrame };

export class Terrain {
  readonly heights = new Float32Array(VERTS);
  /** 0 = untouched regolith, 1 = road surface. */
  readonly road = new Float32Array(VERTS);
  mesh: THREE.Mesh | null = null;
  boulderMesh: THREE.InstancedMesh | null = null;

  private readonly boulderHash = new Map<string, Boulder[]>();
  private readonly owner = new Int32Array(VERTS);
  private readonly ownerAlong = new Float32Array(VERTS);

  idx(i: number, j: number): number {
    return j * (GRID + 1) + i;
  }

  /**
   * Build the untouched surface. The launch ridge is placed from the live
   * track frame so it is guaranteed to be square across the road.
   */
  buildNatural(track: Track): this {
    const ridge = track.launchFrame;
    if (!ridge) throw new Error('Terrain.buildNatural: call track.markLaunchRamp() first');
    for (let j = 0; j <= GRID; j++) {
      const z = -HALF + j * CELL;
      for (let i = 0; i <= GRID; i++) {
        const x = -HALF + i * CELL;
        this.heights[this.idx(i, j)] = naturalHeight(x, z, ridge);
      }
    }
    return this;
  }

  // ---- physics queries ---------------------------------------------------

  sampleHeight(x: number, z: number): number {
    const fi = (x + HALF) / CELL;
    const fj = (z + HALF) / CELL;
    if (fi < 0 || fj < 0 || fi >= GRID || fj >= GRID) {
      const xi = clamp(Math.floor(fi), 0, GRID);
      const zi = clamp(Math.floor(fj), 0, GRID);
      return this.heights[this.idx(xi, zi)] - 2;
    }
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const fx = fi - i;
    const fz = fj - j;
    const h00 = this.heights[this.idx(i, j)];
    const h10 = this.heights[this.idx(i + 1, j)];
    const h01 = this.heights[this.idx(i, j + 1)];
    const h11 = this.heights[this.idx(i + 1, j + 1)];
    return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
  }

  sampleNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = CELL;
    const hL = this.sampleHeight(x - e, z);
    const hR = this.sampleHeight(x + e, z);
    const hD = this.sampleHeight(x, z - e);
    const hU = this.sampleHeight(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  sampleRoadness(x: number, z: number): number {
    const fi = Math.round((x + HALF) / CELL);
    const fj = Math.round((z + HALF) / CELL);
    if (fi < 0 || fj < 0 || fi > GRID || fj > GRID) return 0;
    return this.road[this.idx(fi, fj)];
  }

  bouldersNear(x: number, z: number, radius: number, out: Boulder[]): Boulder[] {
    out.length = 0;
    const cell = 60;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    const span = Math.ceil((radius + 12) / cell);
    for (let ox = -span; ox <= span; ox++) {
      for (let oz = -span; oz <= span; oz++) {
        const arr = this.boulderHash.get(`${cx + ox},${cz + oz}`);
        if (arr) for (const b of arr) out.push(b);
      }
    }
    return out;
  }

  // ---- carve the circuit into the heightfield ----------------------------

  carve(track: Track): this {
    const { px, pz, py, bank, hw } = track.samples;
    const n = track.count;
    const shoulder = 16;
    // The road must be solid out to just past the barrier rail. A smoothstep
    // alone never reaches exactly 1 before the shoulder, which leaves a
    // residual slice of natural terrain under the rail - and wherever the
    // circuit cuts deep into a crater wall that slice opens a visible gap
    // under the barrier. Holding the blend at a hard 1 through the rail
    // region and only ramping down beyond it removes the gap; the ramp starts
    // with zero slope, so the join stays smooth.
    const railHold = 3.5;
    const reach = 40;
    const cells = Math.ceil(reach / CELL);

    this.owner.fill(-1);
    this.ownerAlong.fill(1e9);

    // Pass 1: each grid vertex adopts the road sample it is most directly
    // behind. Limiting `along` keeps the assignment to a single pass over the
    // centerline instead of a full nearest-point search.
    for (let i = 0; i < n; i++) {
      const cx = px[i];
      const cz = pz[i];
      const j2 = (i + 1) % n;
      let tx = px[j2] - cx;
      let tz = pz[j2] - cz;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const gi = Math.round((cx + HALF) / CELL);
      const gj = Math.round((cz + HALF) / CELL);
      for (let oj = -cells; oj <= cells; oj++) {
        const jj = gj + oj;
        if (jj < 0 || jj > GRID) continue;
        const z = -HALF + jj * CELL;
        for (let oi = -cells; oi <= cells; oi++) {
          const ii = gi + oi;
          if (ii < 0 || ii > GRID) continue;
          const x = -HALF + ii * CELL;
          const along = Math.abs((x - cx) * tx + (z - cz) * tz);
          if (along > 3.2) continue;
          const k = this.idx(ii, jj);
          if (along < this.ownerAlong[k]) {
            this.ownerAlong[k] = along;
            this.owner[k] = i;
          }
        }
      }
    }

    // Pass 2: blend the adopted road surface in, plus a small berm on the
    // shoulder so the road reads as built rather than painted on.
    for (let k = 0; k < VERTS; k++) {
      const i = this.owner[k];
      if (i < 0) continue;
      const ii = k % (GRID + 1);
      const jj = (k - ii) / (GRID + 1);
      const x = -HALF + ii * CELL;
      const z = -HALF + jj * CELL;
      const j2 = (i + 1) % n;
      let tx = px[j2] - px[i];
      let tz = pz[j2] - pz[i];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const dSigned = (x - px[i]) * tz + (z - pz[i]) * -tx;
      const dist = Math.abs(dSigned);
      const halfW = hw[i];
      if (dist > halfW + shoulder + 4) continue;
      const roadH = py[i] - dSigned * Math.tan(bank[i]);
      const blend = dist <= halfW + railHold ? 1 : 1 - smoothstep(halfW + railHold, halfW + shoulder, dist);
      const berm = 0.35 * Math.exp(-(((dist - halfW - 4.5) / 3.0) ** 2)) * smoothstep(halfW + 1, halfW + 3.5, dist);
      this.heights[k] = lerp(this.heights[k], roadH, blend) + berm;
      this.road[k] = blend;
    }
    return this;
  }

  // ---- render mesh -------------------------------------------------------

  buildMesh(): THREE.Mesh {
    const pos = new Float32Array(VERTS * 3);
    const col = new Float32Array(VERTS * 3);
    const uv = new Float32Array(VERTS * 2);
    const aRoad = new Float32Array(VERTS);

    for (let j = 0; j <= GRID; j++) {
      const z = -HALF + j * CELL;
      for (let i = 0; i <= GRID; i++) {
        const x = -HALF + i * CELL;
        const k = this.idx(i, j);
        pos[k * 3] = x;
        pos[k * 3 + 1] = this.heights[k];
        pos[k * 3 + 2] = z;
        uv[k * 2] = (i / GRID) * 110;
        uv[k * 2 + 1] = (j / GRID) * 110;
        const n = valueNoise2(x * 0.011 + 40, z * 0.011 + 7);
        const g = 0.46 + n * 0.1;
        col[k * 3] = g * 1.02;
        col[k * 3 + 1] = g;
        col[k * 3 + 2] = g * 0.97;
        aRoad[k] = this.road[k];
      }
    }

    const indices = new Uint32Array(GRID * GRID * 6);
    let p = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = this.idx(i, j);
        const b = this.idx(i + 1, j);
        const c = this.idx(i, j + 1);
        const d = this.idx(i + 1, j + 1);
        indices[p++] = a;
        indices[p++] = c;
        indices[p++] = b;
        indices[p++] = b;
        indices[p++] = c;
        indices[p++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aRoad', new THREE.BufferAttribute(aRoad, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.97,
      metalness: 0.0,
      map: makeRegolithAlbedo(),
      normalMap: makeRegolithNormal(),
      color: 0xbdb9b1,
    });
    (mat as THREE.MeshStandardMaterial).normalScale = new THREE.Vector2(0.5, 0.5);

    // The road surface is dark tarmac with a little grit; the `aRoad` vertex
    // attribute was written by carve(), so the shader needs no extra textures.
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aRoad;\nvarying float vRoad;\nvarying vec3 vWPos;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvRoad = aRoad;\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying float vRoad;
varying vec3 vWPos;
float rh2(vec2 p){ p = vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))); return fract(sin(p.x+p.y)*43758.5453); }
float rvn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(rh2(i),rh2(i+vec2(1,0)),u.x),mix(rh2(i+vec2(0,1)),rh2(i+vec2(1,1)),u.x),u.y); }`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
{
  vec3 roadCol = vec3(0.055, 0.058, 0.068);
  roadCol *= 0.8 + rvn(vWPos.xz * 1.7) * 0.4;
  diffuseColor.rgb = mix(diffuseColor.rgb, roadCol, clamp(vRoad * 1.3, 0.0, 1.0));
}`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.92, clamp(vRoad,0.0,1.0));',
        )
        .replace(
          '#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, clamp(vRoad,0.0,1.0));',
        );
    };

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';
    return this.mesh;
  }

  /** Scattered rocks. The racing corridor is kept clear. */
  buildBoulders(scene: THREE.Scene, track: Track | null, seed = 7): THREE.InstancedMesh {
    const rng = mulberry32(seed * 7919);
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const p = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = valueNoise2(v.x * 2.1 + 5, v.z * 2.1 + v.y * 3.3);
      const n2 = valueNoise2(v.y * 3.7 + 9, v.x * 2.9);
      v.multiplyScalar(0.72 + n * 0.5 + n2 * 0.22);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x76726b, roughness: 0.95, metalness: 0.02, flatShading: true });

    const placements: Placement[] = [];
    let guard = 0;
    while (placements.length < 430 && guard < 20000) {
      guard++;
      const x = (rng() - 0.5) * (WORLD - 400);
      const z = (rng() - 0.5) * (WORLD - 400);
      const r = 1.2 + Math.pow(rng(), 2.4) * 10;
      if (track) {
        const near = track.nearestS(x, z);
        if (near.dist < near.frame.hw + r * 0.8 + 9) continue;
      }
      placements.push({
        x,
        z,
        r,
        rot: rng() * Math.PI * 2,
        sx: 0.8 + rng() * 0.5,
        sy: 0.65 + rng() * 0.5,
        sz: 0.8 + rng() * 0.5,
      });
    }

    const inst = new THREE.InstancedMesh(geo, mat, placements.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const vv = new THREE.Vector3();
    const s = new THREE.Vector3();
    const cell = 60;
    placements.forEach((b, i) => {
      const y = this.sampleHeight(b.x, b.z);
      e.set(sin1(b.x) * 0.6, b.rot, sin1(b.z) * 0.6);
      q.setFromEuler(e);
      vv.set(b.x, y + b.r * 0.32, b.z);
      s.set(b.r * b.sx, b.r * b.sy, b.r * b.sz);
      m.compose(vv, q, s);
      inst.setMatrixAt(i, m);
      const key = `${Math.floor(b.x / cell)},${Math.floor(b.z / cell)}`;
      const arr = this.boulderHash.get(key);
      const rec: Boulder = { x: b.x, z: b.z, r: b.r * Math.max(b.sx, b.sz) * 1.05 };
      if (arr) arr.push(rec);
      else this.boulderHash.set(key, [rec]);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    scene.add(inst);
    this.boulderMesh = inst;
    return inst;
  }
}

/** A boulder as the physics sees it: a horizontal disc. */
export interface Boulder {
  x: number;
  z: number;
  r: number;
}
interface Placement extends Boulder {
  rot: number;
  sx: number;
  sy: number;
  sz: number;
}

function sin1(v: number): number {
  return Math.sin(v * 12.9898) * 43758.5453 - Math.floor(Math.sin(v * 12.9898) * 43758.5453);
}

function naturalHeight(x: number, z: number, ridge: RidgeFrame): number {
  let h = 0;
  h += (fbm2(x * 0.00032 + 17.3, z * 0.00032 + 4.1, 4) - 0.5) * 46; // rolling plain
  h += (fbm2(x * 0.0016 + 3.7, z * 0.0016 + 9.2, 4) - 0.5) * 11; // medium relief
  h += (fbm2(x * 0.009 + 31.7, z * 0.009 + 2.6, 3) - 0.5) * 2.6; // roughness
  h += craterHeight(x, z);

  // The launch kicker: a low ridge crossing the plain, whose LONGITUDINAL
  // profile matches track.rampAt (a crest on the approach, a faster drop on
  // the landing side), and which is broad across the road. The carved road
  // adds its own clean copy of the same shape; see Track.setHeightsFromTerrain.
  const rx = x - ridge.cx;
  const rz = z - ridge.cz;
  const along = rx * ridge.dx + rz * ridge.dz; // down-track
  const across = -rx * ridge.dz + rz * ridge.dx; // perpendicular to the road
  const crossTaper = smoothstep(KICKER_HALF_WIDTH, KICKER_HALF_WIDTH * 0.25, Math.abs(across));
  if (crossTaper <= 0) return h;
  const profile = RAMP_AMP * Math.exp(-((along / (along < 0 ? RAMP_SIGMA : RAMP_SIGMA_OUT)) ** 2));
  return h + profile * crossTaper;
}

// ---- procedural regolith textures ----------------------------------------

function makeRegolithAlbedo(): THREE.CanvasTexture {
  const s = 512;
  const cv = document.createElement('canvas');
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(cv);
  ctx.fillStyle = '#9b9994';
  ctx.fillRect(0, 0, s, s);
  const rand = mulberry32(71);
  const img = ctx.getImageData(0, 0, s, s);
  const d = img.data;
  for (let i = 0; i < s * s; i++) {
    const g = (rand() - 0.5) * 32;
    d[i * 4] = clamp(d[i * 4] + g, 0, 255);
    d[i * 4 + 1] = clamp(d[i * 4 + 1] + g, 0, 255);
    d[i * 4 + 2] = clamp(d[i * 4 + 2] + g * 0.9, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 950; i++) {
    const x = rand() * s;
    const y = rand() * s;
    const r = 1 + rand() * 6;
    ctx.fillStyle = `rgba(${(30 + rand() * 40) | 0},${(30 + rand() * 40) | 0},${(34 + rand() * 40) | 0},${0.1 + rand() * 0.2})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 7);
    ctx.fill();
    ctx.fillStyle = `rgba(235,235,240,${0.05 + rand() * 0.12})`;
    ctx.beginPath();
    ctx.arc(x, y - r * 0.55, r * 0.7, 0, 7);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeRegolithNormal(): THREE.CanvasTexture {
  const s = 256;
  const height = new Float32Array(s * s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      height[x + y * s] = fbm2(x * 0.06, y * 0.06, 3) + fbm2(x * 0.22, y * 0.22, 2) * 0.5;
    }
  }
  const cv = document.createElement('canvas');
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(cv);
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = x + y * s;
      const hx = height[((x + 1) % s) + y * s] - height[((x - 1 + s) % s) + y * s];
      const hy = height[x + ((y + 1) % s) * s] - height[x + ((y - 1 + s) % s) * s];
      const n = new THREE.Vector3(-hx * 2.2, -hy * 2.2, 1).normalize();
      img.data[i * 4] = (n.x * 0.5 + 0.5) * 255;
      img.data[i * 4 + 1] = (n.y * 0.5 + 0.5) * 255;
      img.data[i * 4 + 2] = (n.z * 0.5 + 0.5) * 255;
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
