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
import { NO_DRIFT, clientToPlate, desiredParticles, plateLayout, type FrameInput, type Impulse, type PlateRenderer } from '../render/types';
import { buildTitleMask, loadTitleFont, type TitleMask } from '../render/title';
import { saveFrame } from '../export/snapshot';
import { DEFAULT_PARAMS, toast, ui } from './store';

export interface ReadoutEls {
  freq: HTMLElement | null;
  rms: HTMLElement | null;
  mode: HTMLElement | null;
  complexity: HTMLElement | null;
}

/**
 * grains while the title shows: the light layer the word was designed on,
 * scaled to the screen as the plate's sand used to be
 */
function introSand(w: number, h: number, density: number, coarse: boolean) {
  const base = coarse ? Math.max(w * h * 0.3, Math.min(w, h) * 1000) : w * h * 0.6;
  return Math.round(Math.min(Math.max(base * density, 16000), coarse ? 589824 : 1048576));
}
/** seconds the title takes to merge into the plate's figure, and how much longer its middle lingers */
const MERGE_S = 7;
const MERGE_LAG_S = 3;
/** seconds to pour in the rest of the sand once the plate has taken over */
const SAND_POUR = 3;

/** the dock's height in css px, as the dock itself publishes it */
function dockHeight() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-h')) || 0;
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
  /** 0 while the intro holds the sand down to its light layer, 1 once it is all poured in */
  private sandK = 0;
  private sandT = 0;
  /** seconds since the title finished merging, while stray grains settle */
  private settleT = 0;
  /** whether the canvas has drawn its first frame and is showing */
  private drawn = false;
  /** seconds until the canvas stops overhanging the dock (once it has slid up), or -1 */
  private dropOverhangIn = -1;
  /** opening title: 'title' while the sand spells it, 'release' while it disperses */
  private intro = { phase: 'title' as 'title' | 'release' | 'off', t: -0.6, mix: 1, hold: 1, mask: null as TitleMask | null };
  private ro: ResizeObserver;
  private unsub: () => void;
  private input: FrameInput;
  /** seconds the plate has rested since its colours last moved on */
  private idleColourT = 0;
  /** the stopped tone's pitch last given to the colours */
  private silentToneHz = NaN;

  constructor(private container: HTMLElement) {
    this.driver = new PatternDriver(this.bank, this.reduced);
    this.renderer = this.createRenderer();
    // a new canvas is black until it is drawn: keep it out of sight till then
    if (this.renderer) this.renderer.canvas.style.opacity = '0';
    const p = ui.get().params;
    this.input = {
      dt: 1 / 60, bank: this.bank, symmetry: p.symmetry, V: 0, kick: 0,
      stability: 0, response: p.response, impulses: this.impulses, paused: false,
      colors: this.color.rgb, titleMix: 1, titleGain: 1, titleShake: 0, titleHold: 1, rehome: 1, driftLeft: NO_DRIFT, driftLag: MERGE_LAG_S,
    };

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.applyBudget();

    container.addEventListener('pointerdown', this.onDown);
    container.addEventListener('pointermove', this.onMove);
    container.addEventListener('pointerup', this.onUp);
    container.addEventListener('pointercancel', this.onUp);

    // react to parameter changes that need more than a per-frame read
    let prev = ui.get().params;
    this.unsub = ui.subscribe(() => {
      const next = ui.get().params;
      if (next.density !== prev.density) this.applyBudget(next.density);
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

  /** prepare the plate; until its first frame, the page shows the plate's own colour, not black */
  private async boot() {
    const r = this.renderer;
    if (!r) {
      this.intro.phase = 'off';
      ui.set({ loading: false, intro: 'done' });
      return;
    }
    const p = ui.get().params;
    this.bank.setPlate(p.symmetry);
    this.driver.update(1 / 60, performance.now() / 1000, this.audio.features, p, null, this.audio.state.tone);
    this.bank.snap();
    this.bank.pack();
    for (let i = 0; i < 8; i++) this.bank.normalise();
    this.color.setFixed(p.bgColor, p.sandColor);
    // the plate opens in black and white, then moves on through the colours
    this.color.snap(this.bank.meanLambda(), 0);
    this.paintBackdrop();

    await loadTitleFont();
    if (!this.renderer) return; // disposed while the font loaded
    this.buildTitle();
    if (this.reduced) {
      // no landing: the word is simply there
      this.intro.t = 0.5;
      this.presettleTitle();
    }
    this.driver.V = 0.4;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    window.setTimeout(() => ui.set({ loading: false }), 350);
  }

  /**
   * the app's own backdrop takes the plate's colour while the plate gets ready
   * (not the page's: browsers tint their own chrome with that)
   */
  private paintBackdrop(on = true) {
    const c = this.color.rgb;
    const css = on ? `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})` : '';
    for (const el of [document.getElementById('root'), this.container]) {
      if (el) el.style.backgroundColor = css;
    }
  }

  /** reduced motion: the sand is already settled around the word */
  private presettleTitle() {
    this.renderer?.presettle({ ...this.input, V: 0.32, kick: 0, dt: 1 / 60, stability: 0.6, titleMix: 1, titleGain: 1 }, 90);
  }

  private buildTitle() {
    const { clientWidth: w, clientHeight: h } = this.container;
    const { bx, by } = plateLayout(w, h);
    const mask = buildTitleMask('Cymatics', bx, by);
    this.intro.mask = mask;
    this.renderer?.setTitle(mask);
  }

  /** as many grains as the screen and the density ask for, within the current cap */
  private applyBudget(density = ui.get().params.density) {
    const r = this.renderer, w = this.container.clientWidth, h = this.container.clientHeight;
    if (!r || w <= 0 || h <= 0) return;
    const full = desiredParticles(w, h, density, this.coarse);
    const k = this.sandK, light = Math.min(full, introSand(w, h, density, this.coarse));
    const n = r.setParticleBudget(k >= 1 ? full : light + (full - light) * k * k * (3 - 2 * k));
    if (n !== ui.get().particleCount) ui.set({ particleCount: n });
  }

  /** once the plate has taken over from the title, pour in the rest of the sand */
  private pourSand(dt: number) {
    if (this.sandK >= 1 || this.intro.phase !== 'off') return;
    this.sandT += dt;
    this.sandK = Math.min(1, this.sandT / SAND_POUR);
    this.applyBudget();
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer?.resize(w, h);
    // the dock stays hidden while the title shows: let the sand run to the bottom of the screen
    if (this.intro.phase === 'title') this.renderer?.setOverhang(dockHeight());
    // more screen, more sand: the reserve makes this seamless (no re-sprinkling)
    if (w > 0 && h > 0) this.applyBudget();
    if (this.intro.mask && this.intro.phase === 'title') {
      this.buildTitle();
      // the sand was sprinkled over the old visible area (on phones the dock
      // arrives after the first layout and widens it); spread it edge to edge
      this.renderer?.scatter();
      if (this.reduced) this.presettleTitle();
    }
  }

  /**
   * Sand is sprinkled over the plate, in its own colours, with the word
   * already pressed into it. Almost at once it starts to merge into the
   * plate's figure, slowly, while the plate gets ready, until it is all sand.
   */
  private stepIntro(dt: number) {
    const it = this.intro, inp = this.input;
    if (it.phase === 'off') return;
    it.t += dt;
    if (it.phase === 'title') {
      const land = Math.min(1, Math.max(0, it.t / 1.4));
      const ring = (1 - land) * (1 - land);
      // the word is in the sand from the start: the letters stay bare throughout
      inp.titleGain = 1;
      inp.V = 0.1 + 0.9 * ring;
      inp.kick = 0.35 * ring;
      inp.stability = 0.6;
      if (it.t >= 2.4 && ui.get().intro === 'forming') ui.set({ intro: 'title' });
      // a moment to read the word, then it starts merging into the figure
      if (it.t > 0.5) this.begin();
    } else {
      // the word merges very slowly; its middle stays on the plate a little longer
      it.mix = Math.max(0, 1 - it.t / MERGE_S);
      it.hold = Math.min(1, Math.max(0, 1 - (it.t - MERGE_LAG_S) / MERGE_S));
      // and each grain drifts toward the figure at its own even speed, timed to
      // arrive as the merge ends there: the middle, like the word, a little later
      const k = Math.min(1, it.t / (MERGE_S + MERGE_LAG_S)), ease = k * k * (3 - 2 * k);
      inp.V *= 0.15 + 0.85 * ease;
      inp.kick *= ease;
      inp.driftLeft = MERGE_S - it.t;
      if (it.hold === 0) {
        it.phase = 'off';
        it.mask = null;
        this.renderer?.setTitle(null);
        // the plate is ready: the controls slide up, and once they cover the
        // strip the canvas stops overhanging it
        ui.set({ intro: 'done' });
        this.dropOverhangIn = 1.1;
        this.paintBackdrop(false);
      }
    }
    inp.titleMix = it.mix;
    inp.titleShake = it.phase === 'release' ? 1 : 0;
    // while the word merges, the sand under the dock drains onto the plate
    // gently, and just after, grains held at the edges land beside the figure
    inp.rehome = it.phase === 'release' ? 0.006 : it.phase === 'off' ? 0.05 : 1;
    if (it.phase !== 'release') inp.driftLeft = NO_DRIFT;
    inp.titleHold = it.phase === 'off' ? 0 : it.hold;
  }

  /** the plate takes over from the title and the sand runs to its lines */
  begin() {
    const it = this.intro;
    if (it.phase !== 'title') return;
    it.phase = 'release';
    it.t = 0;
    ui.set({ intro: 'leaving' });
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
    // each style is its own plate; the same drive shakes it into its own figure
    this.bank.setPlate(p.symmetry);
    if (!p.paused) {
      this.driver.update(dt, t, F, p, this.audio.state.source, this.audio.state.tone, state.tab === 'tone');
      this.bank.update(dt, p.response * (this.reduced ? 0.6 : 1));
    }
    this.bank.pack();
    this.bank.normalise();
    // the colours follow the pitch, and hold still in silence
    const sounding = F.active && F.level > 0.02 && F.dominantHz > 20;
    this.color.setFixed(p.bgColor, p.sandColor);
    // a stopped tone's slider picks the colours, then they rest like the plate does
    const toneHz = this.audio.state.tone.freq;
    if (this.driver.silentTone && toneHz !== this.silentToneHz) {
      this.color.aimAt(toneHz);
      this.idleColourT = 0;
    }
    this.silentToneHz = this.driver.silentTone ? toneHz : NaN;
    // a resting plate keeps one figure, but moves on to new colours every 3 s
    if ((this.driver.idle || this.driver.silentTone) && !p.paused) {
      this.idleColourT += dt;
      if (this.idleColourT >= 3) {
        this.idleColourT = 0;
        this.color.advance();
      }
    } else this.idleColourT = 0;
    // the colours flow from the start, through the intro and on into the plate
    this.color.update(dt, sounding ? F.dominantHz : null, this.reduced);

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
    this.pourSand(dt);
    // a few seconds after the merge, sand off the edge is sprinkled back as usual
    if (this.intro.phase === 'off' && this.input.rehome < 1 && (this.settleT += dt) > 3) this.input.rehome = 1;
    // resizing the canvas clears it, so it happens here, in a frame that redraws at once
    if (this.dropOverhangIn >= 0 && (this.dropOverhangIn -= dt) < 0) this.renderer?.setOverhang(0);
    const w0 = performance.now();
    this.renderer?.frame(inp);
    if (!this.drawn && this.renderer) {
      // the first frame is down: let the sand appear over the plate's colour
      this.drawn = true;
      Object.assign(this.renderer.canvas.style, { transition: 'opacity 0.15s ease-out', opacity: '1' });
    }
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
    if (mode) mode.textContent = m ? `${fam} ${m.label}` : '—';
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
      await saveFrame(this.renderer, m ? m.label.replace(/[^a-z0-9]+/gi, '-') : 'plate');
      toast('Image saved to your downloads.');
    } catch (err) {
      toast('Could not save the image: ' + (err as Error).message);
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.paintBackdrop(false);
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
