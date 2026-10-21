import { useSyncExternalStore } from 'react';
import type { Symmetry } from '../pattern/modes';
import type { SourceKind } from '../audio/AudioEngine';

export interface VisualParams {
  /** 0..100. Audio drive: scales pitch → mode. Manual drive: selects the mode. */
  complexity: number;
  /** grain count multiplier */
  density: number;
  /** how quickly sand and figures respond */
  response: number;
  symmetry: Symmetry;
  /** 'audio': sound shapes the figure. 'manual': the sliders do. */
  drive: 'audio' | 'manual';
  paused: boolean;
}

export const DEFAULT_PARAMS: VisualParams = {
  complexity: 50,
  density: 1,
  response: 1,
  symmetry: 'square',
  drive: 'audio',
  paused: false,
};

export interface UIState {
  tab: SourceKind;
  /** the Adjust panel */
  panelOpen: boolean;
  helpOpen: boolean;
  /** first-visit welcome card */
  welcome: boolean;
  /** show the technical readout */
  details: boolean;
  params: VisualParams;
  sweep: boolean;
  loading: boolean;
  renderer: 'gpu' | 'cpu' | 'none';
  toast: string;
  particleCount: number;
}

type Listener = () => void;

function readFlag(key: string) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* private mode: the preference just won't persist */
  }
}

function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export const ui = createStore<UIState>({
  tab: 'tone',
  panelOpen: false,
  helpOpen: false,
  welcome: !readFlag('cymatics:welcomed'),
  details: readFlag('cymatics:details'),
  params: { ...DEFAULT_PARAMS },
  sweep: false,
  loading: true,
  renderer: 'gpu',
  toast: '',
  particleCount: 0,
});

export function setParams(patch: Partial<VisualParams>) {
  ui.set((s) => ({ params: { ...s.params, ...patch } }));
}

export function useUI<S>(select: (s: UIState) => S): S {
  return useSyncExternalStore(ui.subscribe, () => select(ui.get()));
}

let toastTimer = 0;
export function toast(msg: string, ms = 4200) {
  ui.set({ toast: msg });
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.set({ toast: '' }), ms);
}
