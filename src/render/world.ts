/**
 * NOCTIS GP - renderer, lighting and post-processing.
 *
 * The one non-obvious piece here is the SELECTIVE bloom. Rather than letting
 * the whole frame bloom (which blows out sunlit bodywork and the regolith),
 * the frame is rendered twice: once with every non-emissive object swapped for
 * flat black so only bloom-marked materials contribute, and once normally.
 * The two are then summed. Materials opt in by being emissive, which they
 * signal with toneMapped: false.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export interface QualityPreset {
  pr: number;
  shadows: number;
  bloom: number;
  bloomRes: number;
}

/** Drop the settings that cost the most fill rate and geometry bandwidth. */
export const QUALITY: Record<'HIGH' | 'MEDIUM' | 'LOW', QualityPreset> = {
  HIGH: { pr: Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2), shadows: 2048, bloom: 0.5, bloomRes: 1 },
  MEDIUM: { pr: Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 1.5), shadows: 2048, bloom: 0.42, bloomRes: 0.75 },
  LOW: { pr: 1, shadows: 1024, bloom: 0.35, bloomRes: 0.5 },
};

/**
 * True when the browser is falling back to a CPU rasteriser (SwiftShader,
 * llvmpipe, Mesa software). A 2 M triangle world with a shadow pass and two
 * full-screen bloom passes is unusable there, so the caller downgrades hard
 * rather than letting the game crawl at one frame per second.
 */
export function isSoftwareRenderer(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return false;
    const name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '').toLowerCase();
    return /swiftshader|llvmpipe|software|basic render|microsoft basic/.test(name);
  } catch {
    return false;
  }
}

/** A preset for machines with no real GPU: no shadows, no bloom, 1x pixels. */
export const SOFTWARE_PRESET: QualityPreset = { pr: 1, shadows: 0, bloom: 0, bloomRes: 0.5 };

const BLOOM_LAYER = 1;

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;

  private quality: QualityPreset;
  private software: boolean;
  private readonly composer: EffectComposer;
  private readonly bloomComposer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly darkMaterial = new THREE.MeshBasicMaterial({ color: 'black' });
  private readonly darkMats = new Map<string, THREE.Material | THREE.Material[]>();
  private readonly bloomLayerTest = new THREE.Layers();
  private readonly onLost: (e: Event) => void;
  private readonly onRestored: () => void;
  private contextLost = false;

  constructor(canvas: HTMLCanvasElement, quality: QualityPreset, opts: { preserveDrawingBuffer?: boolean } = {}) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      // Only for automated capture: reading the framebuffer back after a
      // frame has been composited returns zeros without this, and it costs
      // bandwidth, so it stays off during normal play.
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    });
    this.renderer.setPixelRatio(quality.pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;

    this.scene.background = new THREE.Color(0x02030a);
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 90000);

    this.software = isSoftwareRenderer(this.renderer);
    if (this.software) {
      // No GPU: strip the two most expensive passes outright.
      this.quality = SOFTWARE_PRESET;
      this.renderer.setPixelRatio(SOFTWARE_PRESET.pr);
      this.renderer.shadowMap.enabled = false;
    }

    this.sun = new THREE.DirectionalLight(0xfff0d8, 3.3);
    this.sun.castShadow = !this.software;
    this.sun.shadow.mapSize.set(Math.max(1, quality.shadows), Math.max(1, quality.shadows));
    this.sun.shadow.camera.near = 100;
    this.sun.shadow.camera.far = 3200;
    const S = 620;
    this.sun.shadow.camera.left = -S;
    this.sun.shadow.camera.right = S;
    this.sun.shadow.camera.top = S;
    this.sun.shadow.camera.bottom = -S;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 1.2;
    this.scene.add(this.sun, this.sun.target);

    // Bounce from the regolith, a cool Earth fill, and a faint overhead
    // starlight so crater interiors have just enough modelling to read.
    this.scene.add(new THREE.HemisphereLight(0x2a3f5e, 0x0a0b10, 0.85));
    const earthFill = new THREE.DirectionalLight(0x4a7fd0, 0.22);
    earthFill.position.set(-0.55, 0.35, 0.8);
    this.scene.add(earthFill);
    const starlight = new THREE.DirectionalLight(0x667d9e, 0.28);
    starlight.position.set(0.15, 1, 0.1);
    this.scene.add(starlight);

    this.bloomLayerTest.set(BLOOM_LAYER);

    const renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth * quality.bloomRes, window.innerHeight * quality.bloomRes),
      quality.bloom,
      0.45,
      0.0,
    );

    this.bloomComposer = new EffectComposer(this.renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(renderPass);
    this.bloomComposer.addPass(this.bloomPass);

    const mixPass = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          baseTexture: { value: null },
          bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
        },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv;
          void main() { gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv); }`,
      }),
      'baseTexture',
    );
    mixPass.needsSwap = true;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    this.composer.addPass(mixPass);
    this.composer.addPass(new OutputPass());

    for (const c of [this.composer, this.bloomComposer]) {
      c.setPixelRatio(quality.pr);
      c.setSize(window.innerWidth, window.innerHeight);
      if (c.renderTarget1.samples !== undefined) {
        c.renderTarget1.samples = 4;
        c.renderTarget2.samples = 4;
      }
    }

    // Context loss is survivable: three re-uploads automatically, we just need
    // to rebuild the render targets and tell the rest of the app.
    this.onLost = (e: Event) => {
      e.preventDefault();
      this.contextLost = true;
    };
    this.onRestored = () => {
      this.contextLost = false;
      this.resize(window.innerWidth, window.innerHeight);
    };
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  /** Flag every emissive (toneMapped: false) material onto the bloom layer. */
  markBloom(root: THREE.Object3D): void {
    root.traverse((node) => {
      if ((node as THREE.Sprite).isSprite) return; // name tags: crisp text, no glow halo
      const m = (node as THREE.Mesh).material;
      const mats = m ? (Array.isArray(m) ? m : [m]) : [];
      for (const mat of mats) if (mat && mat.toneMapped === false) node.layers.enable(BLOOM_LAYER);
    });
  }

  /** Cheap procedural environment so metal parts have something to reflect. */
  buildEnvironment(sunDir: THREE.Vector3): void {
    const envScene = new THREE.Scene();
    const g = new THREE.SphereGeometry(100, 24, 12);
    const m = new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true });
    const pos = g.attributes.position as THREE.BufferAttribute;
    const colors: number[] = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      const up = Math.max(0, v.y);
      const sunK = Math.pow(Math.max(0, v.dot(sunDir)), 64) * 1.1;
      const c = new THREE.Color(0x0a1020)
        .lerp(new THREE.Color(0x1c2b44), up * 0.6)
        .add(new THREE.Color(0xffd9a0).multiplyScalar(sunK));
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    envScene.add(new THREE.Mesh(g, m));

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(envScene, 0, 0.04, 120).texture;
    pmrem.dispose();
    g.dispose();
    m.dispose();
  }

  /** True when running on a CPU rasteriser, so the UI can warn the player. */
  get isSoftware(): boolean {
    return this.software;
  }

  applyQuality(name: 'HIGH' | 'MEDIUM' | 'LOW'): void {
    // A software rasteriser cannot be rescued by raising settings.
    const q = this.software ? SOFTWARE_PRESET : (QUALITY[name] ?? QUALITY.HIGH);
    this.quality = q;
    this.renderer.setPixelRatio(q.pr);
    for (const c of [this.composer, this.bloomComposer]) {
      c.setPixelRatio(q.pr);
      c.setSize(window.innerWidth, window.innerHeight);
    }
    this.bloomPass.enabled = q.bloom > 0;
    this.bloomPass.strength = q.bloom;
    this.renderer.shadowMap.enabled = !this.software && q.shadows > 0;
    this.sun.castShadow = this.renderer.shadowMap.enabled;
    this.sun.shadow.mapSize.set(Math.max(1, q.shadows), Math.max(1, q.shadows));
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  get pixelRatio(): number {
    return this.quality.pr;
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomComposer.setSize(w, h);
  }

  /** Keep the shadow frustum tight around whatever the camera cares about. */
  focusShadows(target: THREE.Vector3, sunDir: THREE.Vector3): void {
    this.sun.position.set(target.x + sunDir.x * 1200, target.y + sunDir.y * 1200 + 200, target.z + sunDir.z * 1200);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }

  private darkenNonBloomed = (obj: THREE.Object3D): void => {
    const o = obj as THREE.Mesh & { isPoints?: boolean; isSprite?: boolean };
    const drawable = o.isMesh || o.isPoints || o.isSprite;
    if (drawable && o.material && !this.bloomLayerTest.test(o.layers)) {
      this.darkMats.set(o.uuid, o.material);
      o.material = this.darkMaterial;
    }
  };

  private restoreMaterial = (obj: THREE.Object3D): void => {
    const m = this.darkMats.get(obj.uuid);
    if (m) {
      (obj as THREE.Mesh).material = m;
      this.darkMats.delete(obj.uuid);
    }
  };

  render(): void {
    if (this.contextLost) return;
    if (this.software) {
      // Single forward pass: the bloom composer would be pure cost here.
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.scene.traverse(this.darkenNonBloomed);
    this.bloomComposer.render();
    this.scene.traverse(this.restoreMaterial);
    this.composer.render();
  }

  dispose(): void {
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onLost);
    canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.composer.dispose();
    this.bloomComposer.dispose();
    this.renderer.dispose();
  }
}
