/** Adjust: plain-language settings, as a floating card (desktop) or bottom sheet (mobile). */
import { useEffect, useRef, useState } from 'react';
import type { Waveform } from '../audio/AudioEngine';
import { DEFAULT_PARAMS, setParams, ui, useUI, writeFlag } from '../core/store';
import { complexityMult, hzFromLam } from '../pattern/driver';
import { ModeBank, SYMMETRIES, type Symmetry } from '../pattern/modes';
import { noteName, useAudio, useExperience } from './context';
import { Button, Choice, Group, IconButton, Slider, Switch, cx } from './primitives';

export function AdjustPanel() {
  const exp = useExperience();
  const open = useUI((s) => s.panelOpen);
  const tab = useUI((s) => s.tab);
  const p = useUI((s) => s.params);
  const details = useUI((s) => s.details);
  const count = useUI((s) => s.particleCount);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [open]);

  const close = () => ui.set({ panelOpen: false });
  const sym = SYMMETRIES.find((s) => s.id === p.symmetry)!;

  return (
    <>
      {open && <div aria-hidden className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={close} />}
      <div
        ref={ref}
        id="adjust-panel"
        role="dialog"
        aria-label="Adjust"
        inert={!open}
        className={cx(
          'fixed z-30 flex flex-col overflow-hidden bg-surface ring-1 ring-line transition-[transform,opacity] duration-300 ease-out-quint',
          'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-3xl',
          'md:inset-x-auto md:right-4 md:bottom-[calc(var(--dock-h,80px)+12px)] md:max-h-[calc(100dvh-var(--dock-h,80px)-88px)] md:w-[380px] md:rounded-2xl',
          open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0 md:translate-y-4'
        )}
      >
        <div className="relative flex min-h-14 shrink-0 items-center justify-between border-b border-line pl-5 pr-2">
          <span className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-[#444] md:hidden" aria-hidden />
          <h2 className="text-[16px] font-semibold">Adjust</h2>
          <IconButton data-autofocus icon="close" label="Close" onClick={close} />
        </div>

        <div className="divide-y divide-line overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          <Group title="Pattern">
            <Switch
              label="Sound chooses the pattern"
              hint={p.drive === 'audio' ? 'Higher notes draw more intricate shapes.' : 'You choose the shape; sound only shakes the sand.'}
              checked={p.drive === 'audio'}
              onChange={(on) => setParams({ drive: on ? 'audio' : 'manual' })}
            />
            <Slider
              label={p.drive === 'audio' ? 'Detail' : 'Shape'}
              ends={['Simple', 'Intricate']}
              value={p.complexity}
              min={0}
              max={100}
              valueText={`${p.complexity} percent`}
              onChange={(complexity) => setParams({ complexity })}
            />
            <div className="grid gap-2">
              <span className="text-[14px] font-medium">Style</span>
              <div role="radiogroup" aria-label="Style" className="grid grid-cols-4 gap-2">
                {SYMMETRIES.map((s) => (
                  <button
                    key={s.id}
                    role="radio"
                    aria-checked={p.symmetry === s.id}
                    onClick={() => setParams({ symmetry: s.id as Symmetry })}
                    className={cx(
                      'grid cursor-pointer justify-items-center gap-1.5 rounded-xl p-1.5 pb-2 text-[12.5px] font-medium ring-1 ring-inset transition-colors duration-200',
                      p.symmetry === s.id ? 'bg-raised text-white ring-white' : 'text-soft ring-line hover:text-white'
                    )}
                  >
                    <ShapeThumb symmetry={s.id} />
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="text-[12.5px] leading-snug text-muted">{sym.hint}</p>
            </div>
          </Group>

          <Group title="Sand">
            <Slider
              label="Amount"
              ends={['Less', 'More']}
              display={`${Math.round(count / 1000)}k grains`}
              value={Math.round(p.density * 100)}
              min={40}
              max={200}
              step={5}
              onChange={(v) => setParams({ density: v / 100 })}
            />
            <Slider
              label="Movement"
              ends={['Calm', 'Lively']}
              value={Math.round(p.response * 100)}
              min={30}
              max={250}
              step={5}
              onChange={(v) => setParams({ response: v / 100 })}
            />
          </Group>

          {tab === 'tone' && <ToneOptions />}
          {tab === 'file' && <FileOptions />}
          {tab === 'live' && <MicOptions />}

          <Group title="Display">
            <Switch
              label="Show sound details"
              hint="Pitch, volume and pattern readout"
              checked={details}
              onChange={(on) => {
                ui.set({ details: on });
                writeFlag('cymatics:details', on);
              }}
            />
            <div className="grid grid-cols-2 gap-2">
              <Button icon={p.paused ? 'play' : 'pause'} aria-pressed={p.paused} onClick={() => setParams({ paused: !p.paused })}>
                {p.paused ? 'Resume' : 'Freeze'}
              </Button>
              <Button icon="scatter" onClick={() => exp?.scatter()}>
                Scatter
              </Button>
              <Button
                icon="reset"
                className="col-span-2"
                disabled={JSON.stringify(p) === JSON.stringify(DEFAULT_PARAMS)}
                onClick={() => exp?.resetParams()}
              >
                Reset to defaults
              </Button>
            </div>
          </Group>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------ per source
const WAVES: { value: Waveform; label: string }[] = [
  { value: 'sine', label: 'Pure' },
  { value: 'triangle', label: 'Soft' },
  { value: 'square', label: 'Hollow' },
  { value: 'sawtooth', label: 'Bright' },
];
const RESONANT: [number, number][] = [[2, 1], [3, 1], [3, 2], [4, 2], [5, 3], [6, 2], [6, 4], [7, 4], [8, 3]];

function ToneOptions() {
  const exp = useExperience();
  const { tone } = useAudio();
  const complexity = useUI((s) => s.params.complexity);
  const res = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    exp?.bindResonance(res.current);
    return () => exp?.bindResonance(null);
  }, [exp]);
  if (!exp) return null;
  const a = exp.audio;
  const mult = complexityMult(complexity);
  const notes = RESONANT.map(([n, m]) => {
    const md = exp.bank.modes.find((x) => x.n === n && x.m === m)!;
    return Math.round(hzFromLam(md.lam) / mult);
  }).filter((hz) => hz >= 20 && hz <= 2000);

  return (
    <Group title="Tone">
      <Choice label="Sound" options={WAVES} value={tone.wave} onChange={(w) => a.setToneWave(w)} />
      <Slider label="Volume" value={Math.round(tone.amp * 100)} min={0} max={90} display={`${Math.round(tone.amp * 100)}%`} onChange={(v) => a.setToneAmp(v / 100)} />
      <Switch label="Play through speakers" hint="Turn off to watch the shapes in silence." checked={tone.listen} onChange={(on) => a.setToneListen(on)} />
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[14px] font-medium">Resonant notes</span>
          <span className="flex items-center gap-2 text-[12px] text-muted" title="How strongly the plate resonates with the current pitch">
            Match
            <span className="block h-1 w-14 overflow-hidden rounded-full bg-[#333]">
              <span ref={res} className="block h-full origin-left bg-white" style={{ transform: 'scaleX(0)' }} />
            </span>
          </span>
        </div>
        <p className="text-[12.5px] leading-snug text-muted">These pitches make the plate ring clearly and form crisp shapes.</p>
        <div className="flex flex-wrap gap-2">
          {notes.map((hz) => (
            <button
              key={hz}
              onClick={() => {
                ui.set({ sweep: false });
                a.setToneFreq(hz);
                if (!tone.running) a.startTone();
              }}
              className={cx(
                'min-h-10 cursor-pointer rounded-full px-3.5 text-[13px] font-medium ring-1 ring-inset transition-colors duration-200',
                Math.abs(tone.freq - hz) < 0.5 ? 'bg-white text-black ring-white' : 'text-soft ring-line hover:text-white'
              )}
              aria-label={`${noteName(hz)}, ${hz} hertz`}
            >
              {noteName(hz)}
            </button>
          ))}
        </div>
      </div>
    </Group>
  );
}

function FileOptions() {
  const exp = useExperience();
  const [vol, setVol] = useState(80);
  if (!exp) return null;
  return (
    <Group title="Music">
      <Slider label="Volume" value={vol} min={0} max={100} display={`${vol}%`} onChange={(v) => { setVol(v); exp.audio.setFileVolume(v / 100); }} />
      <p className="text-[12.5px] leading-snug text-muted">Volume only changes what you hear; the plate always gets the full signal.</p>
    </Group>
  );
}

const gainFrom = (v: number) => 0.5 * Math.pow(32, v / 100);
function MicOptions() {
  const exp = useExperience();
  const [g, setG] = useState(40);
  if (!exp) return null;
  return (
    <Group title="Microphone">
      <Slider
        label="Sensitivity"
        ends={['Quiet room', 'Loud room']}
        value={100 - g}
        min={0}
        max={100}
        onChange={(v) => {
          const next = 100 - v;
          setG(next);
          exp.audio.setMicGain(gainFrom(next));
        }}
      />
    </Group>
  );
}

// ------------------------------------------------------------ previews
/** a tiny live render of each plate style, drawn from the real equations */
function ShapeThumb({ symmetry }: { symmetry: Symmetry }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const S = 64;
    c.width = c.height = S;
    const bank = new ModeBank();
    bank.excite(symmetry === 'radial' ? 13 : 25, 1);
    bank.setRadial(symmetry === 'radial' ? 0.25 : 0.12, 3, 2.8);
    bank.snap();
    bank.pack();
    for (let i = 0; i < 6; i++) bank.normalise(symmetry, 24);
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(S, S);
    const h = 2 / S;
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const x = -1 + (2 * i + 1) / S, y = 1 - (2 * j + 1) / S;
        const f = bank.evalRaw(symmetry, x, y) * bank.norm;
        const gx = (bank.evalRaw(symmetry, x + h, y) - bank.evalRaw(symmetry, x - h, y)) * bank.norm / (2 * h);
        const gy = (bank.evalRaw(symmetry, x, y + h) - bank.evalRaw(symmetry, x, y - h)) * bank.norm / (2 * h);
        const d = Math.abs(f) / Math.max(Math.hypot(gx, gy), 1e-3);
        const v = Math.exp(-Math.pow(d / (h * 0.55), 2)) * 235;
        const o = (j * S + i) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [symmetry]);
  return <canvas ref={ref} aria-hidden className="aspect-square w-full rounded-lg bg-black" />;
}
