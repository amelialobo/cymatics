/**
 * The instrument: owns the audio engine, the mode bank, the driver and the
 * renderer, and runs the animation loop. React never re-renders per frame;
 * the loop reads parameters from the store and writes readouts straight to DOM.
 */
import { AudioEngine, TONE_MAX, TONE_MIN } from '../audio/AudioEngine';
import { ModeBank, SYMMETRIES } from '../pattern/modes';
import { ColorDrift } from '../pattern/palette';
import { PatternDriver } from '../pattern/driver';
import { CpuRenderer } from '../render/CpuRenderer';
import { GpuRenderer, gpuSupported } from '../render/GpuRenderer';
import { clientToPlate, desiredParticles, plateLayout, type FrameInput, type Impulse, type PlateRenderer } from '../render/types';
import { buildTitleMask, loadTitleFont, type TitleMask } from '../render/title';
import { saveFrame } from '../export/snapshot';
import { DEFAULT_PARAMS, toast, ui } from './store';

export interface ReadoutEls {
  freq: HTMLElement | null;
  rms: HTMLElement | null;
  mode: HTMLElement | null;
  complexity: HTMLElement | null;
}

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function noteName(hz: number) {
  const m = Math.round(69 + 12 * Math.log2(hz / 440));
  return NOTES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

export class Experience {
  readonly audio = new AudioEngine();
  readonly bank = new ModeBank();
  readonly driver: PatternDriver;
  readonly color = new ColorDrift();
  renderer: PlateRenderer | null = null;

  private raf = 0;
  private last = performance.now();
  private pointers = new Map<number, Impulse>();
  private impulses: Impulse[] = [];
  private readout: ReadoutEls = { freq: null, rms: null, mode: null, complexity: null };
  private resonanceEl: HTMLElement | null = null;
  private meterEls = new Set<HTMLElement>();
  private meterLevel = 0;
  private hudT = 0;
  private frameAvg = 16.7;
  /** time our own frame takes (sim + draw submit), separate from browser pauses */
  private workAvg = 2;
  private fastStreak = 0;
  private perfT = 0;
  private slowStreak = 0;
  private startT = performance.now() / 1000;
  private sweepDir = 1;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly coarse = matchMedia('(pointer: coarse)').matches;
  /** opening title: 'title' while the sand spells it, 'release' while it lets go */
  private intro = { phase: 'title' as 'title' | 'release' | 'off', t: -0.6, mix: 1, mask: null as TitleMask | null };
  /** white sand on black while the title shows, easing into the plate's own colours */
  private readonly introRgb = new Float32Array([0, 0, 0, 1, 1, 1]);
  private ro: ResizeObserver;
  private unsub: () => void;
  private input: FrameInput;

  constructor(private container: HTMLElement) {
    this.driver = new PatternDriver(this.bank, this.reduced);
    this.renderer = this.createRenderer();
    const p = ui.get().params;
    this.input = {
      dt: 1 / 60, bank: this.bank, symmetry: p.symmetry, V: 0, kick: 0,
      stability: 0, response: p.response, impulses: this.impulses, paused: false,
      colors: this.introRgb, titleMix: 1, titleGain: 0,
    };

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    if (this.renderer) {
      const n = this.renderer.setParticleBudget(desiredParticles(container.clientWidth, container.clientHeight, p.density, this.coarse));
      ui.set({ particleCount: n });
    }

    container.addEventListener('pointerdown', this.onDown);
    container.addEventListener('pointermove', this.onMove);
    container.addEventListener('pointerup', this.onUp);
    container.addEventListener('pointercancel', this.onUp);

    // react to parameter changes that need more than a per-frame read
    let prev = ui.get().params;
    this.unsub = ui.subscribe(() => {
      const next = ui.get().params;
      if (next.density !== prev.density && this.renderer) {
        const n = this.renderer.setParticleBudget(
          desiredParticles(container.clientWidth, container.clientHeight, next.density, this.coarse)
        );
        ui.set({ particleCount: n });
      }
      // a new plate family: the sand has to migrate to new nodal lines
      if (next.symmetry !== prev.symmetry) this.driver.kick = Math.max(this.driver.kick, 0.35);
      prev = next;
    });

    void this.boot();
  }

  private createRenderer(): PlateRenderer | null {
    // ?cpu forces the fallback, for testing it on capable machines
    const forceCpu = new URLSearchParams(location.search).has('cpu');
    try {
      if (!forceCpu && gpuSupported()) {
        ui.set({ renderer: 'gpu' });
        return new GpuRenderer(this.container);
      }
    } catch (err) {
      console.warn('WebGL renderer failed, using the CPU fallback', err);
    }
    try {
      ui.set({ renderer: 'cpu' });
      toast('Compatibility mode: WebGL2 is unavailable, so the plate runs on the CPU with fewer grains.', 6000);
      return new CpuRenderer(this.container);
    } catch {
      ui.set({ renderer: 'none' });
      return null;
    }
  }

  /** prepare the plate behind the loading screen; the sand starts as an even layer for the title */
  private async boot() {
    const r = this.renderer;
    if (!r) {
      this.intro.phase = 'off';
      ui.set({ loading: false, intro: 'done' });
      return;
    }
    const p = ui.get().params;
    this.driver.update(1 / 60, performance.now() / 1000, this.audio.features, p, null);
    this.bank.snap();
    this.bank.pack();
    for (let i = 0; i < 8; i++) this.bank.normalise(p.symmetry);
    this.color.setFixed(p.bgColor, p.sandColor);
    this.color.snap(this.bank.meanLambda());

    await loadTitleFont();
    if (!this.renderer) return; // disposed while the font loaded
    this.buildTitle();
    if (this.reduced) {
      // no shaking: the word is simply there
      this.intro.t = 2.4;
      this.presettleTitle();
    }
    this.driver.V = 0.4;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    window.setTimeout(() => ui.set({ loading: false }), 350);
  }

  /** reduced motion: settle the word out of sight instead of shaking it into place */
  private presettleTitle() {
    this.renderer?.presettle({ ...this.input, V: 0.32, kick: 0, dt: 1 / 60, stability: 0.6, titleMix: 1, titleGain: 1 }, 90);
  }

  private buildTitle() {
    const { clientWidth: w, clientHeight: h } = this.container;
    const { side, bx, by } = plateLayout(w, h);
    const mask = buildTitleMask('Cymatics', bx, by);
    this.intro.mask = mask;
    this.renderer?.setTitle(mask);
    ui.set({ titleBottom: Math.round((-mask.bottom * side) / 2) });
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer?.resize(w, h);
    // more screen, more sand: the reserve makes this seamless (no re-sprinkling)
    if (this.renderer && w > 0 && h > 0) {
      const n = this.renderer.setParticleBudget(desiredParticles(w, h, ui.get().params.density, this.coarse));
      if (n !== ui.get().particleCount) ui.set({ particleCount: n });
    }
    if (this.intro.mask && this.intro.phase === 'title') {
      this.buildTitle();
      // the sand was sprinkled over the old visible area (on phones the dock
      // arrives after the first layout and widens it); spread it edge to edge
      this.renderer?.scatter();
      if (this.reduced) this.presettleTitle();
    }
  }

  /**
   * The plate is struck: the whole layer of sand jumps, and as the ringing
   * dies down the grains shake out of every letter at once. It holds for a
   * moment, then releases by itself.
   */
  private stepIntro(dt: number) {
    const it = this.intro, inp = this.input;
    if (it.phase === 'off') return;
    it.t += dt;
    if (it.phase === 'title') {
      const k = Math.min(1, Math.max(0, it.t / 2.4));
      const ring = (1 - k) * (1 - k);
      inp.titleGain = k * k * (3 - 2 * k);
      // settles to a low hum, so the sand banks up crisply along the letters
      inp.V = 0.2 + 0.8 * ring;
      inp.kick = 0.35 * ring;
      inp.stability = 0.6;
      if (k >= 1 && ui.get().intro === 'forming') ui.set({ intro: 'title' });
      // hold the word a moment, then let the plate take over on its own
      if (it.t > 3.8) this.begin();
    } else {
      it.mix = Math.max(0, it.mix - dt / 1.3);
      if (it.mix === 0) {
        it.phase = 'off';
        it.mask = null;
        this.renderer?.setTitle(null);
        inp.colors = this.color.rgb;
      }
    }
    inp.titleMix = it.mix;
    if (it.phase !== 'off') {
      const pal = this.color.rgb, w = it.mix, rgb = this.introRgb;
      for (let i = 0; i < 6; i++) rgb[i] = pal[i] + ((i < 3 ? 0 : 1) - pal[i]) * w;
    }
  }

  /** the plate takes over from the title and the sand runs to its lines */
  begin() {
    const it = this.intro;
    if (it.phase !== 'title') return;
    it.phase = 'release';
    this.driver.V = Math.max(this.driver.V, 0.75);
    this.driver.kick = Math.max(this.driver.kick, 0.45);
    ui.set({ intro: 'leaving' });
    // let the figure form before anything covers it
    window.setTimeout(() => ui.set({ intro: 'done' }), 2600);
  }

  // ---------------------------------------------------------------- loop
  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const rawMs = now - this.last;
    this.last = now;
    const dt = Math.min(0.05, Math.max(0.001, rawMs / 1000));
    const t = now / 1000;
    const state = ui.get();
    const p = state.params;

    const F = this.audio.analyze(dt);
    if (state.sweep) this.sweep(dt);
    if (!p.paused) {
      this.driver.update(dt, t, F, p, this.audio.state.source);
      this.bank.update(dt, p.response * (this.reduced ? 0.6 : 1));
    }
    this.bank.pack();
    this.bank.normalise(p.symmetry);
    // the colours follow the figure the sand is drawing
    const sounding = F.active && F.level > 0.02 && F.dominantHz > 20;
    this.color.setFixed(p.bgColor, p.sandColor);
    this.color.update(dt, sounding ? F.dominantHz : null, F.active, this.bank.meanLambda(), this.reduced);

    this.impulses.length = 0;
    this.pointers.forEach((im) => this.impulses.push(im));
    const inp = this.input;
    inp.dt = dt;
    inp.symmetry = p.symmetry;
    inp.V = this.driver.V;
    inp.kick = this.driver.kick;
    inp.stability = this.driver.stability;
    inp.response = p.response;
    inp.paused = p.paused;
    this.stepIntro(dt);
    const w0 = performance.now();
    this.renderer?.frame(inp);
    const work = performance.now() - w0;

    this.trackPerformance(rawMs, work, t);
    this.updateMeters(F.active ? F.level : 0, dt);
    this.updateReadout(t);
  };

  /** adaptive quality: shed grains, then resolution, if frames run long */
  private trackPerformance(ms: number, work: number, t: number) {
    if (ms > 0 && ms < 100) this.frameAvg = this.frameAvg * 0.95 + ms * 0.05;
    this.workAvg = this.workAvg * 0.95 + work * 0.05;
    if (t < this.perfT || t - this.startT < 3 || document.hidden) return;
    this.perfT = t + 2;
    const r = this.renderer;
    if (!r) return;
    // shed grains only when frames are slow *and* our own work is heavy; a
    // throttled window, a dialog or a 30 fps battery cap are not reasons to
    // take sand away
    const slow = this.frameAvg > 24 && this.workAvg > 8;
    const fast = this.frameAvg < 19 && this.workAvg < 5;
    this.slowStreak = slow ? this.slowStreak + 1 : 0;
    this.fastStreak = fast ? this.fastStreak + 1 : 0;
    if (this.slowStreak >= 2 && r.qualityDown()) {
      this.slowStreak = 0;
      ui.set({ particleCount: r.particleCount });
    } else if (this.fastStreak >= 3 && r.qualityUp()) {
      // and give sand back once there is headroom again
      this.fastStreak = 0;
      ui.set({ particleCount: r.particleCount });
    }
  }


  private sweep(dt: number) {
    const tone = this.audio.state.tone;
    if (!tone.running) return;
    let f = tone.freq * Math.pow(2, (this.sweepDir * dt) / 8); // one octave every 8 s
    if (f > TONE_MAX) { f = TONE_MAX; this.sweepDir = -1; }
    else if (f < 40) { f = 40; this.sweepDir = 1; }
    this.audio.setToneFreq(Math.max(TONE_MIN, f));
  }

  // ------------------------------------------------------------- readout
  bindReadout(els: ReadoutEls) {
    this.readout = els;
  }

  bindResonance(el: HTMLElement | null) {
    this.resonanceEl = el;
  }

  /** live input-level bars; returns an unbind function */
  bindMeter(el: HTMLElement) {
    this.meterEls.add(el);
    return () => void this.meterEls.delete(el);
  }

  private updateMeters(level: number, dt: number) {
    if (!this.meterEls.size) return;
    // quick attack, gentle release, so the bar reads as a level, not a flicker
    const k = level > this.meterLevel ? 0.5 : 1 - Math.exp(-dt * 4);
    this.meterLevel += (level - this.meterLevel) * k;
    const v = `scaleX(${this.meterLevel.toFixed(3)})`;
    this.meterEls.forEach((el) => (el.style.transform = v));
  }

  private updateReadout(t: number) {
    if (t - this.hudT < 0.1) return;
    this.hudT = t;
    const F = this.audio.features;
    const p = ui.get().params;
    const { freq, rms, mode, complexity } = this.readout;
    const sounding = F.active && F.level > 0.02 && F.dominantHz > 20;
    if (freq) freq.textContent = sounding ? `${Math.round(F.dominantHz)} Hz · ${noteName(F.dominantHz)}` : 'Silent';
    if (rms) rms.textContent = F.active && F.rms > 0.0003 ? `${Math.round(Math.min(1, F.rms * 2.5) * 100)}%  (${(20 * Math.log10(F.rms)).toFixed(0)} dB)` : '—';
    const m = this.bank.dominant();
    const fam = SYMMETRIES.find((s) => s.id === p.symmetry)?.label ?? '';
    if (mode) mode.textContent = m ? `${fam} ${m.n}·${m.m}` : '—';
    if (complexity) {
      const lam = this.bank.meanLambda();
      const pct = lam > 0 ? Math.min(100, Math.round((Math.log(lam) / Math.log(400)) * 100)) : 0;
      const layers = this.bank.activeCount;
      complexity.textContent = `${pct}%  ·  ${layers} ${layers === 1 ? 'layer' : 'layers'}`;
    }
    if (this.resonanceEl) this.resonanceEl.style.transform = `scaleX(${(this.audio.state.tone.running ? this.driver.res : 0).toFixed(3)})`;
  }

  // ---------------------------------------------------------- interaction
  private toPlate(e: PointerEvent) {
    const r = this.container.getBoundingClientRect();
    return clientToPlate(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  }

  private onDown = (e: PointerEvent) => {
    if (this.pointers.size >= 4) return;
    this.container.setPointerCapture(e.pointerId);
    const p = this.toPlate(e);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, r: 0.13, s: 0.05 });
  };

  private onMove = (e: PointerEvent) => {
    const im = this.pointers.get(e.pointerId);
    if (!im) return;
    const p = this.toPlate(e);
    im.x = p.x;
    im.y = p.y;
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
  };

  // --------------------------------------------------------------- actions
  scatter() {
    this.renderer?.scatter();
    this.driver.kick = Math.max(this.driver.kick, 0.2);
  }

  resetParams() {
    ui.set({ params: { ...DEFAULT_PARAMS }, sweep: false });
    toast('Settings reset. Sound shapes the pattern again.');
  }

  async savePNG() {
    if (!this.renderer) return;
    try {
      const m = this.bank.dominant();
      await saveFrame(this.renderer, m ? `${m.n}-${m.m}` : 'plate');
      toast('Image saved to your downloads.');
    } catch (err) {
      toast('Could not save the image: ' + (err as Error).message);
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.unsub();
    this.container.removeEventListener('pointerdown', this.onDown);
    this.container.removeEventListener('pointermove', this.onMove);
    this.container.removeEventListener('pointerup', this.onUp);
    this.container.removeEventListener('pointercancel', this.onUp);
    this.renderer?.dispose();
    this.renderer = null;
    this.audio.dispose();
  }
}
