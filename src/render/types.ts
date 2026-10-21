import type { ModeBank, Symmetry } from '../pattern/modes';
import type { TitleMask } from './title';

export interface Impulse { x: number; y: number; r: number; s: number }

export interface FrameInput {
  dt: number;
  bank: ModeBank;
  symmetry: Symmetry;
  /** vibration amplitude */
  V: number;
  kick: number;
  /** 0..1: how settled the sound is; steadier sound gives tighter lines */
  stability: number;
  response: number;
  impulses: Impulse[];
  /** freeze the sand */
  paused: boolean;
  /** background and sand colours: 6 sRGB floats */
  colors: Float32Array;
  /** 0..1: how much the opening title replaces the plate's own field */
  titleMix: number;
  /** 0..1: how strongly the title's letters shake the sand out */
  titleGain: number;
}

export interface PlateRenderer {
  readonly kind: 'gpu' | 'cpu';
  readonly canvas: HTMLCanvasElement;
  readonly particleCount: number;
  resize(cssW: number, cssH: number): void;
  /** set the grain budget (approximate); returns the actual count */
  setParticleBudget(n: number): number;
  frame(input: FrameInput): void;
  presettle(input: FrameInput, steps: number): void;
  scatter(): void;
  /** the word the sand spells before the plate starts singing; null clears it */
  setTitle(mask: TitleMask | null): void;
  /** lower quality one notch; false when already at the floor */
  qualityDown(): boolean;
  /** restore quality one notch; false when already at full quality */
  qualityUp(): boolean;
  exportPNG(): Promise<Blob>;
  dispose(): void;
}

/** Sand physics constants, in plate units (the plate spans -1..1), per 60 Hz frame. */
export const TUNE = {
  jitter: 0.018,
  diffuse: 0.0105,
  pull: 0.28,
  maxStep: 0.018,
  kick: 0.014,
};

/**
 * Layout of the square plate in a viewport: centred, never distorted, and
 * covering the whole screen. The plate spans the long side; the short side
 * shows the central part of it.
 */
export function plateLayout(w: number, h: number) {
  const side = Math.max(w, h);
  return {
    side,
    bx: Math.min(1, w / side),
    by: Math.min(1, h / side),
  };
}

/** client px → plate coords (y up) */
export function clientToPlate(cx: number, cy: number, w: number, h: number) {
  const { side } = plateLayout(w, h);
  return { x: (cx - w / 2) / (side / 2), y: -(cy - h / 2) / (side / 2) };
}

export function desiredParticles(cssW: number, cssH: number, density: number, coarse: boolean) {
  // a phone's plate spans its long side, so it is drawn small and its lines
  // crowd together: what keeps them full is sand per line, which scales with
  // the short side rather than the area
  const base = coarse ? Math.max(cssW * cssH * 0.3, Math.min(cssW, cssH) * 820) : cssW * cssH * 0.6;
  return Math.round(Math.min(Math.max(base * density, 16000), coarse ? 409600 : 1048576));
}
