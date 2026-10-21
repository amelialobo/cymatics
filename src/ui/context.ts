import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { Experience } from '../core/Experience';
import type { AudioSnapshot } from '../audio/AudioEngine';

export const ExperienceContext = createContext<Experience | null>(null);
export const useExperience = () => useContext(ExperienceContext);

const IDLE: AudioSnapshot = {
  source: null,
  tone: { running: false, freq: 220, wave: 'sine', amp: 0.5, listen: true },
  mic: { status: 'off', message: '' },
  file: { name: '', loaded: false, playing: false, duration: 0, time: 0 },
};
const noop = () => () => {};

/** audio state for components; changes on events, never per frame */
export function useAudio(): AudioSnapshot {
  const exp = useExperience();
  const subscribe = useMemo(() => (exp ? (fn: () => void) => exp.audio.subscribe(fn) : noop), [exp]);
  return useSyncExternalStore(subscribe, () => (exp ? exp.audio.state : IDLE));
}

export function openFilePicker() {
  document.getElementById('file-input')?.click();
}

export function toggleFullscreen() {
  if (!document.fullscreenEnabled) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}

export const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export function noteName(hz: number) {
  const m = Math.round(69 + 12 * Math.log2(hz / 440));
  return NOTES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

export const fmtTime = (s: number) =>
  Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';
