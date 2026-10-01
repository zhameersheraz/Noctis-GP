/**
 * NOCTIS GP - procedural open-wheel lunar racer.
 *
 * Built entirely from boxes, cylinders and two sculpted primitives, so the
 * game ships no model assets. The car is about 5.4 m long and faces +Z.
 *
 * Material notes
 *   Bodywork is deliberately low-metalness and high-roughness. A glossy clear
 *   coat under this low sun washes paint out to flat white, so the colour has
 *   to come from diffuse and the sparkle is left to the neon parts.
 *   Emissive trim uses toneMapped: false, which is also how the selective
 *   bloom pass identifies what is allowed to glow.
 */

import * as THREE from 'three';
import type { Livery } from '../core/liveries';
import type { CarVisualParts } from '../sim/car';

type SculptFn = (x: number, y: number, z: number) => { x: number; y: number; z: number };

/**
 * Warp a unit box through `fn` in normalised [-0.5, 0.5] space, then scale to
 * (w, h, d). This is how the nose, tub, sidepods and engine cover get their
 * tapered shapes without any custom geometry.
 */
function sculptedBox(w: number, h: number, d: number, fn: SculptFn, segW = 4, segD = 6): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1, segW, 2, segD);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = fn(v.x, v.y, v.z);
    p.setXYZ(i, r.x * w, r.y * h, r.z * d);
  }
  g.computeVertexNormals();
  return g;
}

export function makeCarMesh(livery: Livery, isPlayer = false): THREE.Group {
  const g = new THREE.Group();
  const accentColor = new THREE.Color(livery.color);

  // Bodywork is deliberately low-metalness and high-roughness. A glossy clear
  // coat under this low sun washes paint out to flat white, so colour comes
  // from diffuse and the sparkle is left to the neon parts. The base tone is
  // kept well clear of black on purpose: a night race is mostly near-black
  // tarmac, and the car has to stay readable against it.
  const paint = new THREE.MeshPhysicalMaterial({
    color: accentColor.clone().multiplyScalar(0.66).lerp(new THREE.Color(0x141a24), 0.28),
    metalness: 0.1,
    roughness: 0.52,
    specularIntensity: 0.4,
    clearcoat: 0.2,
    clearcoatRoughness: 0.42,
    emissive: accentColor,
    emissiveIntensity: 0.07,
    envMapIntensity: 0.2,
  });
  const accent = new THREE.MeshPhysicalMaterial({
    color: accentColor.clone().multiplyScalar(0.9),
    metalness: 0.1,
    roughness: 0.5,
    specularIntensity: 0.4,
    clearcoat: 0.18,
    clearcoatRoughness: 0.42,
    emissive: accentColor,
    emissiveIntensity: 0.22,
    envMapIntensity: 0.2,
  });
  const darkTrim = new THREE.MeshStandardMaterial({
    color: 0x0d1117,
    metalness: 0.35,
    roughness: 0.68,
    envMapIntensity: 0.24,
  });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x121418, roughness: 0.92, metalness: 0.05 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.85, roughness: 0.35 });
  const neon = new THREE.MeshBasicMaterial({ color: accentColor.clone().multiplyScalar(2.6), toneMapped: false });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0a1524,
    metalness: 0.3,
    roughness: 0.12,
    transparent: true,
    opacity: 0.5,
    clearcoat: 0.6,
    clearcoatRoughness: 0.15,
    envMapIntensity: 0.4,
  });

  const parts = g.userData as CarVisualParts;
  parts.livery = livery;

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    g.add(m);
    return m;
  };

  // ---- floor ------------------------------------------------------------
  add(new THREE.BoxGeometry(1.9, 0.05, 4.9), darkTrim, 0, -0.24, 0.1);

  // ---- nose: strong forward taper, raised tip ---------------------------
  add(
    sculptedBox(1.15, 0.34, 2.5, (x, y, z) => {
      const t = z + 0.5; // 0 at the rear, 1 at the tip
      return { x: x * (1 - t * (0.62 + 0.1 * t)), y: y * (1 - t * 0.45) + t * 0.14, z };
    }),
    paint,
    0,
    -0.05,
    1.95,
  );
  add(
    sculptedBox(0.16, 0.025, 1.05, (x, y, z) => ({ x: x * (1 - (z + 0.5) * 0.5), y, z })),
    accent,
    0,
    0.14,
    2.35,
  );

  // ---- front wing: main plane, two flaps, endplates, pylons --------------
  add(new THREE.BoxGeometry(2.55, 0.035, 0.55), paint, 0, -0.21, 2.85);
  add(new THREE.BoxGeometry(2.35, 0.03, 0.3), paint, 0, -0.13, 2.62, -0.12);
  add(new THREE.BoxGeometry(2.1, 0.025, 0.22), paint, 0, -0.06, 2.47, -0.18);
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.035, 0.22, 0.6), darkTrim, 1.27 * s, -0.11, 2.7);
    add(new THREE.BoxGeometry(0.04, 0.05, 0.5), accent, 1.27 * s, 0.02, 2.72);
    add(new THREE.BoxGeometry(0.05, 0.24, 0.3), darkTrim, 0.24 * s, -0.02, 2.52);
    // wishbones
    add(new THREE.BoxGeometry(0.62, 0.022, 0.05), darkTrim, 0.62 * s, 0.05, 1.62, 0, 0, 0.28 * s);
    add(new THREE.BoxGeometry(0.62, 0.022, 0.05), darkTrim, 0.62 * s, -0.12, 1.68, 0, 0, -0.2 * s);
  }

  // ---- monocoque --------------------------------------------------------
  add(
    sculptedBox(1.5, 0.5, 2.2, (x, y, z) => {
      const t = Math.abs(z);
      return { x: x * (1 - t * 0.25), y: y * (1 - t * 0.1), z };
    }),
    paint,
    0,
    -0.02,
    0.35,
  );
  add(new THREE.TorusGeometry(0.52, 0.035, 6, 18), accent, 0, 0.3, 0.28, Math.PI / 2, 0, 0);

  // ---- sidepods ---------------------------------------------------------
  for (const s of [-1, 1]) {
    add(
      sculptedBox(
        0.62,
        0.46,
        1.7,
        (x, y, z) => {
          const t = y + 0.5;
          const u = z + 0.5;
          return { x: x * (0.7 + 0.3 * t) * (0.88 + 0.12 * u), y: y - u * 0.1 * (y > 0 ? 1 : 0), z };
        },
      ),
      paint,
      0.78 * s,
      -0.09,
      -0.35,
    );
    add(new THREE.BoxGeometry(0.04, 0.16, 0.4), darkTrim, 1.06 * s, -0.02, 0.35); // undercut inlet
    add(new THREE.BoxGeometry(0.1, 0.02, 1.0), accent, 0.83 * s, 0.16, -0.5); // stripe
  }

  // ---- engine cover, airbox, shark fin ----------------------------------
  add(
    sculptedBox(0.85, 0.62, 1.9, (x, y, z) => {
      const t = 0.5 - z; // 0 at the front, 1 at the tail
      return { x: x * (1 - t * 0.62), y: y * (1 - t * 0.35), z };
    }),
    paint,
    0,
    0.22,
    -1.25,
  );
  add(new THREE.BoxGeometry(0.34, 0.24, 0.34), paint, 0, 0.56, -0.62);
  add(new THREE.BoxGeometry(0.24, 0.1, 0.06), darkTrim, 0, 0.6, -0.44);
  add(new THREE.BoxGeometry(0.035, 0.5, 1.05), paint, 0, 0.52, -1.55);

  // ---- canopy and halo ---------------------------------------------------
  const canopy = add(new THREE.SphereGeometry(0.55, 16, 12), glass, 0, 0.34, 0.3);
  canopy.scale.set(0.85, 0.52, 1.5);
  add(new THREE.TorusGeometry(0.44, 0.04, 7, 16, Math.PI), darkTrim, 0, 0.52, 0.42, Math.PI * 0.5, 0, 0);
  add(new THREE.BoxGeometry(0.045, 0.32, 0.045), darkTrim, 0, 0.42, 0.82);

  // ---- rear wing ---------------------------------------------------------
  add(new THREE.BoxGeometry(1.95, 0.045, 0.5), paint, 0, 0.88, -2.25, 0.1);
  add(new THREE.BoxGeometry(1.95, 0.035, 0.28), paint, 0, 0.7, -2.12, 0.16);
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.035, 0.52, 0.68), darkTrim, 0.97 * s, 0.72, -2.2);
    add(new THREE.BoxGeometry(0.04, 0.14, 0.6), accent, 0.97 * s, 0.94, -2.2);
  }
  add(new THREE.BoxGeometry(0.1, 0.55, 0.22), darkTrim, 0, 0.5, -2.05);

  // ---- diffuser and strakes ---------------------------------------------
  add(new THREE.BoxGeometry(1.6, 0.22, 0.55), darkTrim, 0, -0.12, -2.25, 0.35);
  for (const s of [-0.5, 0, 0.5]) {
    add(new THREE.BoxGeometry(0.03, 0.24, 0.4), darkTrim, s * 0.7, -0.1, -2.3, 0.35);
  }

  // ---- rear suspension ---------------------------------------------------
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.6, 0.022, 0.05), darkTrim, 0.6 * s, 0.02, -1.5, 0, 0, 0.24 * s);
    add(new THREE.BoxGeometry(0.6, 0.022, 0.05), darkTrim, 0.6 * s, -0.14, -1.42, 0, 0, -0.18 * s);
  }

  // ---- lights and neon trim ---------------------------------------------
  const brakeLightMat = new THREE.MeshStandardMaterial({
    color: 0x1a0505,
    emissive: 0xff2222,
    emissiveIntensity: 0.3,
    toneMapped: false,
  });
  add(new THREE.BoxGeometry(0.7, 0.05, 0.04), brakeLightMat, 0, 0.3, -2.52);
  parts.brakeMat = brakeLightMat;

  const beaconMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: accentColor, emissiveIntensity: 3, toneMapped: false });
  add(new THREE.SphereGeometry(0.05, 8, 6), beaconMat, 0, 0.7, -0.62);
  parts.beaconMat = beaconMat;

  const headMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xdff4ff, emissiveIntensity: 2.5, toneMapped: false });
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.14, 0.04, 0.05), headMat, 0.22 * s, 0.02, 3.0, 0, 0.3 * s, 0);
  }

  add(new THREE.BoxGeometry(1.5, 0.012, 0.025), neon, 0, 0.905, -2.48, 0.1); // wing stripe
  add(new THREE.BoxGeometry(0.02, 0.025, 3.0), neon, 0.96, -0.21, -0.2);
  add(new THREE.BoxGeometry(0.02, 0.025, 3.0), neon, -0.96, -0.21, -0.2);
  add(new THREE.BoxGeometry(0.22, 0.02, 0.03), neon, 0, 0.06, 3.05);

  const underMat = new THREE.MeshBasicMaterial({
    color: accentColor.clone().multiplyScalar(1.6),
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const under = add(new THREE.PlaneGeometry(1.8, 3.2), underMat, 0, -0.27, 0.1, -Math.PI / 2, 0, 0);
  under.castShadow = false;
  parts.underglow = under;

  // ---- wheels: slicks, brake discs, glowing rim rings --------------------
  const ringMat = new THREE.MeshBasicMaterial({ color: accentColor.clone().multiplyScalar(2.0), toneMapped: false });
  const wheels: NonNullable<CarVisualParts['wheels']> = [];
  for (const [x, z, r, wd, steerable] of [
    [1.16, 1.58, 0.5, 0.42, true],
    [-1.16, 1.58, 0.5, 0.42, true],
    [1.19, -1.48, 0.56, 0.5, false],
    [-1.19, -1.48, 0.56, 0.5, false],
  ] as [number, number, number, number, boolean][]) {
    const wg = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, wd, 20), tireMat);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    wg.add(tire);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.52, r * 0.52, wd + 0.04, 14), brakeMat);
    disc.rotation.z = Math.PI / 2;
    wg.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.015, 0.028, 6, 26), ringMat);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = x > 0 ? wd / 2 + 0.01 : -wd / 2 - 0.01;
    wg.add(ring);
    wg.position.set(x, -0.06 + (r - 0.5), z);
    g.add(wg);
    wheels.push({ group: wg, tire, steerable });
  }
  parts.wheels = wheels;

  // ---- thruster flames ---------------------------------------------------
  const flames: THREE.Mesh[] = [];
  for (const x of [-0.35, 0.35]) {
    const f = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.95, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x6f9fd0,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    f.rotation.x = -Math.PI / 2;
    f.position.set(x, 0, -2.62);
    f.castShadow = false;
    g.add(f);
    flames.push(f);
  }
  parts.flames = flames;

  // ---- driver: the helmet IS the head -----------------------------------
  const driver = new THREE.Group();
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.27, 20, 14),
    new THREE.MeshStandardMaterial({ color: accentColor, emissive: accentColor, emissiveIntensity: 0.55, roughness: 0.45, metalness: 0 }),
  );
  orb.castShadow = true;
  driver.add(orb);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4 });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 9), eyeMat);
    eye.scale.set(0.05, 0.09, 0.03);
    eye.position.set(s * 0.09, 0.05, 0.242);
    driver.add(eye);
  }
  driver.position.set(0, 0.5, 0.12);
  g.add(driver);
  parts.driver = driver;

  g.name = isPlayer ? 'playerCar' : `car-${livery.name}`;
  return g;
}

/**
 * Floating driver name. Redrawn once the webfont has actually loaded, because
 * drawing at boot races the font fetch and bakes the fallback in forever.
 */
export function makeNameTag(text: string, color: number): THREE.Sprite {
  const W = 512;
  const H = 128;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const accent = `#${new THREE.Color(color).getHexString()}`;
  const FONT = '500 56px "Geist Mono", ui-monospace, Menlo, monospace';

  const draw = (): void => {
    if (!c) return;
    c.clearRect(0, 0, W, H);
    c.font = FONT;
    if ('letterSpacing' in c) c.letterSpacing = '9px';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    // A thin dark rim instead of a blur shadow: stays crisp over sky and rock.
    c.strokeStyle = 'rgba(4, 8, 14, 0.82)';
    c.lineWidth = 9;
    c.strokeText(text, W / 2, 50);
    c.fillStyle = '#eef5fc';
    c.fillText(text, W / 2, 50);
    // Livery tick under the name, same grammar as the HUD.
    const w = Math.min(180, 34 + text.length * 15);
    c.fillStyle = accent;
    c.fillRect((W - w) / 2, 97, w, 7);
    tex.needsUpdate = true;
  };
  draw();

  if (document.fonts) {
    void document.fonts.load('500 56px "Geist Mono"').then(draw).catch(() => undefined);
    void document.fonts.ready.then(draw).catch(() => undefined);
  }

  const spr = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.92, depthTest: false, toneMapped: false }),
  );
  spr.scale.set(5.2, 1.3, 1);
  spr.position.y = 2.1;
  return spr;
}
