import type { ModeBank, Symmetry } from '../pattern/modes';

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
  /** lower quality one notch; false when already at the floor */
  qualityDown(): boolean;
  exportPNG(): Promise<Blob>;
  dispose(): void;
}

/** Sand physics constants, in plate units (the plate spans -1..1), per 60 Hz frame. */
export const TUNE = {
  jitter: 0.018,
  diffuse: 0.0085,
  pull: 0.08,
  maxStep: 0.006,
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
  const base = cssW * cssH * (coarse ? 0.1 : 0.22);
  return Math.round(Math.min(Math.max(base * density, 12000), coarse ? 120000 : 330000));
}
