/**
 * WebGL2 renderer (Three.js). The field, the sand simulation and the drawing
 * all run on the GPU; the CPU only uploads ~30 numbers per frame.
 */
import * as THREE from 'three';
import { NOISE_AMT, NOISE_WAVES, SYM_INDEX, WARP, MAX_ACTIVE } from '../pattern/modes';
import { displayFrag, fieldFrag, pointsFrag, pointsVert, quadVert, simFrag } from './shaders';
import { TUNE, plateLayout, type FrameInput, type PlateRenderer } from './types';
import type { TitleMask } from './title';

const FIELD_RES = 512;
/** sand is reserved once at this size (grains = size²); quality only changes how much of it is active */
const COARSE = matchMedia('(pointer: coarse)').matches;
const CAPACITY = COARSE ? 768 : 1024;
/** a phone's pixels are physically small: its grains are drawn a little wider to match */
const GRAIN_PX = COARSE ? 1.5 : 1.0;
const MIN_ACTIVE = 16000;

export function gpuSupported(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ok = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

type Uniforms = Record<string, THREE.IUniform>;

export class GpuRenderer implements PlateRenderer {
  readonly kind = 'gpu' as const;
  readonly canvas: HTMLCanvasElement;
  private gl: THREE.WebGLRenderer;
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad = new THREE.PlaneGeometry(2, 2);

  private fieldRT: THREE.WebGLRenderTarget;
  private fieldScene = new THREE.Scene();
  private fieldU: Uniforms;

  private simScene = new THREE.Scene();
  private simU: Uniforms;
  private posRT: THREE.WebGLRenderTarget[] = [];
  private posTex: THREE.Texture | null = null;
  private seedTex: THREE.DataTexture | null = null;
  private titleTex: THREE.DataTexture;
  private densityTex: THREE.DataTexture;
  private ping = 0;
  private texSize = 0;
  /** grains asked for (from screen size and the Amount slider) */
  private budget = 0;
  /** 0.25..1: share of the budget kept active by the performance governor */
  private quality = 1;
  private activeRows = 0;
  private frameNo = 0;

  /** how much sand lands on each screen pixel; the colour pass reads it */
  private accumRT: THREE.WebGLRenderTarget;
  private displayScene = new THREE.Scene();
  private displayU: Uniforms;
  private pointsScene = new THREE.Scene();
  private pointsU: Uniforms;
  private points: THREE.Points | null = null;

  private cssW = 1;
  private cssH = 1;
  private overhang = 0;
  private overhangSand = true;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);
  private prScale = 1;
  private brightBase = 1;
  private lift = 1;
  private bounds = new THREE.Vector2(1, 1);
  private floor = { value: -1 };
  private bufSize = new THREE.Vector2();
  private readonly modesArr = new Float32Array(MAX_ACTIVE * 4);
  private readonly impArr = new Float32Array(16);

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.gl.autoClear = false;
    this.gl.setClearColor(0x000000, 1);
    this.canvas = this.gl.domElement;
    this.canvas.className = 'block w-full h-full';
    container.appendChild(this.canvas);

    this.fieldRT = new THREE.WebGLRenderTarget(FIELD_RES, FIELD_RES, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });

    // 8-bit: adding many grains into the same pixel is much cheaper than in float
    this.accumRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });

    const noise = new Float32Array(32);
    NOISE_WAVES.forEach((w, i) => noise.set(w, i * 4));
    this.fieldU = {
      uModes: { value: this.modesArr },
      uCount: { value: 0 },
      uSym: { value: 0 },
      uRadial: { value: new THREE.Vector4() },
      uNoise: { value: noise },
      uNoiseAmt: { value: NOISE_AMT },
      uWarp: { value: WARP },
      uNorm: { value: 1 },
    };
    this.fieldScene.add(new THREE.Mesh(this.quad, this.mat(quadVert, fieldFrag, this.fieldU)));

    this.simU = {
      uPos: { value: null },
      uField: { value: this.fieldRT.texture },
      uFieldTexel: { value: 1 / FIELD_RES },
      uBounds: { value: this.bounds },
      uFloor: this.floor,
      uV: { value: 0 },
      uKick: { value: 0 },
      uJitter: { value: TUNE.jitter },
      uDiffuse: { value: TUNE.diffuse },
      uPull: { value: TUNE.pull },
      uMaxStep: { value: TUNE.maxStep },
      uFrame: { value: 0 },
      uImp: { value: this.impArr },
      uImpN: { value: 0 },
      uTitleMix: { value: 0 },
      uTitle: { value: null },
      uTitleGain: { value: 0 },
      uTitleShake: { value: 0 },
      uTitleHold: { value: 0 },
      uTitleHalf: { value: 1 },
    };
    this.titleTex = this.redTexture(new Uint8Array(1), 1);
    this.simU.uTitle.value = this.titleTex;
    this.simScene.add(new THREE.Mesh(this.quad, this.mat(quadVert, simFrag, this.simU)));

    this.displayU = {
      uField: { value: this.fieldRT.texture },
      uAccum: { value: this.accumRT.texture },
      uFieldTexel: { value: 1 / FIELD_RES },
      uRes: { value: new THREE.Vector2() },
      uCentre: { value: new THREE.Vector2() },
      uSide: { value: 1 },
      uLine: { value: 0.06 },
      uHaze: { value: 0.16 },
      uBgIn: { value: new THREE.Vector3() },
      uSand: { value: new THREE.Vector3(1, 1, 1) },
    };
    this.displayScene.add(new THREE.Mesh(this.quad, this.mat(quadVert, displayFrag, this.displayU)));

    this.pointsU = {
      uPos: { value: null },
      uScale: { value: new THREE.Vector2(1, 1) },
      uOffset: { value: new THREE.Vector2() },
      uPointSize: { value: 1.5 },
      uBright: { value: 1 },
      uDensity: { value: null },
      uDensityMix: { value: 0 },
      uLetters: { value: null },
      uLettersGain: { value: 0 },
    };
    this.densityTex = this.redTexture(new Uint8Array(1), 1);
    this.pointsU.uDensity.value = this.densityTex;
    this.pointsU.uLetters.value = this.titleTex;
  }

  private mat(vertexShader: string, fragmentShader: string, uniforms: Uniforms) {
    return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false });
  }

  get particleCount() {
    return this.activeRows * this.texSize;
  }

  private pixelRatio() {
    return this.dpr * this.prScale;
  }

  resize(cssW: number, cssH: number) {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.gl.setPixelRatio(this.pixelRatio());
    this.gl.setSize(this.cssW, this.cssH + this.overhang, false);
    const { side, bx, by } = plateLayout(this.cssW, this.cssH);
    this.bounds.set(bx, by);
    this.floor.value = -by - (this.overhangSand ? (2 * this.overhang) / side : 0);
    this.canvas.style.height = this.overhang ? `calc(100% + ${this.overhang}px)` : '';
    this.syncSizeUniforms(1);
  }

  setOverhang(px: number, sand = true) {
    px = Math.max(0, Math.round(px));
    if (px === this.overhang && sand === this.overhangSand) return;
    this.overhang = px;
    this.overhangSand = sand;
    this.resize(this.cssW, this.cssH);
  }

  private syncSizeUniforms(exportScale: number) {
    const pr = this.pixelRatio() * exportScale;
    const { side } = plateLayout(this.cssW, this.cssH);
    // match the real drawing buffer exactly, so each grain maps to one pixel
    this.gl.getDrawingBufferSize(this.bufSize);
    const bw = this.bufSize.x, bh = this.bufSize.y;
    (this.displayU.uRes.value as THREE.Vector2).set(bw, bh);
    // the stage is the top cssH of the canvas; anything below overhangs it
    const tall = this.cssH + this.overhang;
    (this.displayU.uCentre.value as THREE.Vector2).set(bw / 2, (bh * (this.overhang + this.cssH / 2)) / tall);
    if (this.accumRT.width !== bw || this.accumRT.height !== bh) this.accumRT.setSize(bw, bh);
    this.displayU.uSide.value = side * pr;
    (this.pointsU.uScale.value as THREE.Vector2).set(side / this.cssW, side / tall);
    (this.pointsU.uOffset.value as THREE.Vector2).set(0, this.overhang / tall);
    // grains stay about one physical grain wide at any resolution
    this.pointsU.uPointSize.value = Math.max(1, pr * GRAIN_PX);
    this.brightBase = pr < 1 ? 0.85 : 1;
    this.pointsU.uBright.value = this.brightBase * this.lift;
  }

  setParticleBudget(n: number) {
    this.budget = n;
    if (!this.texSize) this.allocParticles(CAPACITY);
    this.applyActive();
    return this.particleCount;
  }

  /** activate a share of the reserved sand: no re-sprinkling, so changes are seamless */
  private applyActive() {
    const size = this.texSize;
    const want = Math.min(size * size, Math.max(MIN_ACTIVE, Math.round(this.budget * this.quality)));
    const rows = Math.max(1, Math.min(size, Math.ceil(want / size)));
    if (rows === this.activeRows) return;
    this.activeRows = rows;
    for (const rt of this.posRT) {
      rt.scissor.set(0, 0, size, rows);
      rt.scissorTest = true;
    }
    this.points?.geometry.setDrawRange(0, rows * size);
  }

  private allocParticles(size: number) {
    this.texSize = size;
    this.posRT.forEach((rt) => rt.dispose());
    this.posRT = [0, 1].map(
      () =>
        new THREE.WebGLRenderTarget(size, size, {
          type: THREE.FloatType,
          format: THREE.RGBAFormat,
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          depthBuffer: false,
        })
    );
    if (this.points) {
      this.pointsScene.remove(this.points);
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
    }
    const count = size * size;
    const refs = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      refs[i * 3] = ((i % size) + 0.5) / size;
      refs[i * 3 + 1] = (Math.floor(i / size) + 0.5) / size;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(refs, 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: pointsVert,
      fragmentShader: pointsFrag,
      uniforms: this.pointsU,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.pointsScene.add(this.points);
    this.activeRows = 0;
    this.seed();
  }

  /** sprinkle fresh sand evenly over the visible plate */
  private seed() {
    const size = this.texSize;
    const data = new Float32Array(size * size * 4);
    const { x: bx, y: by } = this.bounds, lo = this.floor.value;
    for (let i = 0; i < size * size; i++) {
      const dust = Math.random() < 0.06;
      data[i * 4] = (Math.random() * 2 - 1) * bx;
      data[i * 4 + 1] = lo + Math.random() * (by - lo);
      data[i * 4 + 2] = dust ? 0.12 + Math.random() * 0.3 : 0.7 + Math.random() * 0.3; // mobility
      data[i * 4 + 3] = dust ? 0.2 + Math.random() * 0.3 : 0.35 + Math.random() * Math.random() * 0.65; // brightness
    }
    this.seedTex?.dispose();
    this.seedTex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    this.seedTex.minFilter = this.seedTex.magFilter = THREE.NearestFilter;
    this.seedTex.needsUpdate = true;
    // copy the fresh sand into both buffers in full (not just the active rows),
    // so grains that become active later start somewhere sensible
    const u = this.simU;
    u.uPos.value = this.seedTex;
    u.uV.value = u.uKick.value = u.uPull.value = 0;
    u.uImpN.value = 0;
    for (const rt of this.posRT) {
      const test = rt.scissorTest;
      rt.scissorTest = false;
      this.gl.setRenderTarget(rt);
      this.gl.render(this.simScene, this.camera);
      rt.scissorTest = test;
    }
    this.posTex = this.posRT[0].texture;
    this.ping = 1;
  }

  scatter() {
    this.seed();
  }

  private redTexture(data: Uint8Array, size: number) {
    const t = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  setTitle(mask: TitleMask | null) {
    this.titleTex.dispose();
    this.titleTex = mask ? this.redTexture(mask.data, mask.size) : this.redTexture(new Uint8Array(1), 1);
    this.simU.uTitleHalf.value = mask ? mask.right : 1;
    this.simU.uTitle.value = this.titleTex;
    this.densityTex.dispose();
    this.densityTex = mask ? this.redTexture(mask.density, mask.densitySize) : this.redTexture(new Uint8Array(1), 1);
    this.pointsU.uDensity.value = this.densityTex;
    this.pointsU.uLetters.value = this.titleTex;
  }

  qualityDown() {
    if (this.quality > 0.3) {
      this.quality = Math.max(0.25, this.quality * 0.8);
      this.applyActive();
      return true;
    }
    if (this.prScale > 0.6) {
      this.prScale = Math.max(0.6, this.prScale * 0.8);
      this.resize(this.cssW, this.cssH);
      return true;
    }
    return false;
  }

  /** give back what qualityDown took, resolution first */
  qualityUp() {
    if (this.prScale < 1) {
      this.prScale = Math.min(1, this.prScale * 1.15);
      this.resize(this.cssW, this.cssH);
      return true;
    }
    if (this.quality < 1) {
      this.quality = Math.min(1, this.quality * 1.15);
      this.applyActive();
      return true;
    }
    return false;
  }

  private renderField(inp: FrameInput) {
    const bank = inp.bank;
    this.modesArr.set(bank.packed);
    this.fieldU.uCount.value = bank.activeCount;
    this.fieldU.uSym.value = SYM_INDEX[inp.symmetry];
    (this.fieldU.uRadial.value as THREE.Vector4).set(bank.radialWeight(), bank.radial.k, bank.radial.p, 0);
    this.fieldU.uNorm.value = bank.norm;
    this.gl.setRenderTarget(this.fieldRT);
    this.gl.render(this.fieldScene, this.camera);
  }

  private simulate(inp: FrameInput) {
    const f60 = Math.min(inp.dt * 60, 3);
    const u = this.simU;
    u.uPos.value = this.posTex;
    u.uV.value = inp.V;
    u.uKick.value = inp.kick * TUNE.kick * f60;
    u.uJitter.value = TUNE.jitter * f60;
    u.uDiffuse.value = TUNE.diffuse * f60 * (1 - 0.45 * inp.stability);
    u.uPull.value = Math.min(0.6, inp.V * TUNE.pull * inp.response * f60);
    u.uMaxStep.value = TUNE.maxStep * f60;
    u.uFrame.value = this.frameNo++ % 4096;
    const n = Math.min(4, inp.impulses.length);
    for (let i = 0; i < n; i++) {
      const im = inp.impulses[i];
      this.impArr.set([im.x, im.y, im.r, im.s * f60], i * 4);
    }
    u.uImpN.value = n;
    u.uTitleMix.value = inp.titleMix;
    u.uTitleGain.value = inp.titleGain;
    u.uTitleShake.value = inp.titleShake;
    u.uTitleHold.value = inp.titleHold;
    const target = this.posRT[this.ping];
    this.gl.setRenderTarget(target);
    this.gl.render(this.simScene, this.camera);
    this.posTex = target.texture;
    this.ping ^= 1;
  }

  private draw(inp: FrameInput) {
    // intricate figures spread the same sand over far more line: lift it a little
    this.lift = Math.min(1.55, Math.max(1, 0.9 + inp.bank.meanLambda() / 110));
    this.pointsU.uBright.value = this.brightBase * this.lift;
    // the nodal field shows through more while the sand is in motion
    // while the title holds the sand, the plate's own lines stay hidden
    const own = 1 - inp.titleMix;
    this.displayU.uLine.value = (0.015 + 0.035 * Math.min(1, inp.V + inp.kick)) * own;
    this.displayU.uHaze.value = 0.16 * own;
    this.pointsU.uDensityMix.value = inp.titleMix;
    this.pointsU.uLettersGain.value = inp.titleMix * inp.titleGain;
    const c = inp.colors;
    (this.displayU.uBgIn.value as THREE.Vector3).set(c[0], c[1], c[2]);
    (this.displayU.uSand.value as THREE.Vector3).set(c[3], c[4], c[5]);
    this.composite();
  }

  /** sand into the coverage buffer, then colour everything in one pass */
  private composite() {
    this.pointsU.uPos.value = this.posTex;
    this.gl.setRenderTarget(this.accumRT);
    this.gl.setClearColor(0x000000, 0);
    this.gl.clear();
    this.gl.render(this.pointsScene, this.camera);
    this.gl.setRenderTarget(null);
    this.gl.setClearColor(0x000000, 1);
    this.gl.clear();
    this.gl.render(this.displayScene, this.camera);
  }

  frame(inp: FrameInput) {
    this.renderField(inp);
    const moving = inp.V > 0.0005 || inp.kick > 0.0005 || inp.impulses.length > 0;
    if (!inp.paused && moving) {
      // a long frame becomes several normal 60 Hz steps, so the sand settles
      // the same on a slow or busy machine instead of smearing
      const steps = Math.min(4, Math.max(1, Math.round(inp.dt * 60)));
      const step = steps > 1 ? { ...inp, dt: inp.dt / steps } : inp;
      for (let i = 0; i < steps; i++) this.simulate(step);
    }
    this.draw(inp);
  }

  presettle(inp: FrameInput, steps: number) {
    this.renderField(inp);
    for (let i = 0; i < steps; i++) this.simulate(inp);
    this.draw(inp);
  }

  async exportPNG(): Promise<Blob> {
    const caps = this.gl.capabilities;
    const longest = Math.max(this.cssW, this.cssH + this.overhang) * this.pixelRatio();
    const limit = Math.min(caps.maxTextureSize, 6144);
    // at least twice the screen, or 4096 px on the long side, within GPU limits
    const scale = Math.max(1, Math.min(limit / longest, Math.max(2, 4096 / longest)));
    const base = this.pixelRatio();
    this.gl.setPixelRatio(base * scale);
    this.gl.setSize(this.cssW, this.cssH + this.overhang, false);
    this.syncSizeUniforms(scale);
    this.composite();
    // read back synchronously, before the browser composites and clears the buffer
    const url = this.canvas.toDataURL('image/png');
    this.gl.setPixelRatio(base);
    this.gl.setSize(this.cssW, this.cssH + this.overhang, false);
    this.syncSizeUniforms(1);
    const res = await fetch(url);
    return res.blob();
  }

  dispose() {
    this.fieldRT.dispose();
    this.accumRT.dispose();
    this.posRT.forEach((rt) => rt.dispose());
    this.seedTex?.dispose();
    this.titleTex.dispose();
    this.densityTex.dispose();
    this.quad.dispose();
    for (const scene of [this.fieldScene, this.simScene, this.displayScene, this.pointsScene]) {
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        m?.dispose();
        if (o instanceof THREE.Points) o.geometry.dispose();
      });
    }
    this.gl.dispose();
    this.gl.forceContextLoss();
    this.canvas.remove();
  }
}
