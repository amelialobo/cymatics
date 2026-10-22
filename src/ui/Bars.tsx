/** Floating info button and bottom dock: the only chrome over the plate. */
import { useEffect, useRef } from 'react';
import { TONE_MAX, TONE_MIN, type SourceKind } from '../audio/AudioEngine';
import { toast, ui, useUI } from '../core/store';
import { fmtTime, noteName, openFilePicker, toggleFullscreen, useAudio, useExperience } from './context';
import { Icon, type IconName } from './icons';
import { ColourWheelButton } from './ColourPanel';
import { Button, IconButton, cx } from './primitives';

// ----------------------------------------------------------------- info
export function InfoButton() {
  const helpOpen = useUI((s) => s.helpOpen);
  return (
    // bare icon, no container: IconButton's hover fill would bring the circle back
    <button
      aria-label="How it works"
      title="How it works"
      aria-expanded={helpOpen}
      onClick={() => ui.set({ helpOpen: !helpOpen, panelOpen: false, coloursOpen: false })}
      className="fixed right-3 z-20 grid h-11 w-11 cursor-pointer place-items-center text-white/45 transition-colors duration-200 hover:text-white/80 active:opacity-80 aria-expanded:text-white/80 md:right-4"
      style={{ top: 'calc(env(safe-area-inset-top) + 12px)' }}
    >
      <Icon name="info" />
    </button>
  );
}

/** colours, snapshot and full screen */
function Tools() {
  const exp = useExperience();
  return (
    <>
      <ColourWheelButton />
      <IconButton icon="camera" label="Save image" onClick={() => void exp?.savePNG()} />
      {document.fullscreenEnabled && <IconButton icon="expand" label="Full screen" onClick={toggleFullscreen} />}
    </>
  );
}

// ----------------------------------------------------------------- dock
const SOURCES: { id: SourceKind; label: string; short: string; icon: IconName }[] = [
  { id: 'live', label: 'Microphone', short: 'Mic', icon: 'mic' },
  { id: 'file', label: 'Music', short: 'Music', icon: 'music' },
  { id: 'tone', label: 'Tone', short: 'Tone', icon: 'wave' },
];

export function Dock() {
  const tab = useUI((s) => s.tab);
  const panelOpen = useUI((s) => s.panelOpen);
  // slides up once the title has dispersed into the plate
  const away = useUI((s) => s.intro !== 'done');
  const { source } = useAudio();
  const ref = useRef<HTMLElement>(null);

  // publish the dock height so floating panels can sit just above it
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--dock-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <footer
      ref={ref}
      className={cx(
        'fixed inset-x-0 bottom-0 z-20 border-t border-line/70 bg-ink transition-transform duration-1000 ease-out-quint',
        away ? 'translate-y-full' : 'translate-y-0'
      )}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-6xl flex-col-reverse gap-2 px-3 py-3 md:flex-row md:items-center md:gap-5 md:px-5">
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Sound source" className="flex flex-1 gap-1 rounded-full bg-surface p-1 ring-1 ring-line ring-inset md:flex-none">
            {SOURCES.map((s) => {
              const active = tab === s.id;
              return (
                <button
                  key={s.id}
                  role="tab"
                  aria-selected={active}
                  aria-label={s.label}
                  onClick={() => ui.set({ tab: s.id })}
                  className={cx(
                    'relative flex min-h-10 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full px-3.5 text-[14px] font-medium transition-colors duration-200 md:flex-none',
                    active ? 'bg-white text-black' : 'text-soft hover:text-white'
                  )}
                >
                  <Icon name={s.icon} size={18} />
                  <span className="hidden sm:inline">{s.label}</span>
                  <span className="max-[419px]:hidden sm:hidden">{s.short}</span>
                  {source === s.id && (
                    <span className={cx('absolute right-2 top-1.5 h-1.5 w-1.5 rounded-full', active ? 'bg-black' : 'bg-white')} aria-label="active" />
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex items-center md:hidden">
            <Tools />
          </div>
          <IconButton
            icon="sliders"
            label="Adjust"
            aria-expanded={panelOpen}
            aria-controls="adjust-panel"
            className="md:hidden"
            onClick={() => ui.set({ panelOpen: !panelOpen, helpOpen: false, coloursOpen: false })}
          />
        </div>

        <div className="min-w-0 flex-1" role="tabpanel" aria-label={SOURCES.find((s) => s.id === tab)!.label}>
          {tab === 'tone' && <ToneDock />}
          {tab === 'file' && <FileDock />}
          {tab === 'live' && <MicDock />}
        </div>

        <div className="hidden items-center gap-1 md:flex">
          <Tools />
          <Button
            icon="sliders"
            aria-expanded={panelOpen}
            aria-controls="adjust-panel"
            onClick={() => ui.set({ panelOpen: !panelOpen, helpOpen: false, coloursOpen: false })}
          >
            Adjust
          </Button>
        </div>
      </div>
    </footer>
  );
}

/** big round play/stop control */
function PlayButton({ playing, onClick, labels }: { playing: boolean; onClick: () => void; labels: [string, string] }) {
  return (
    <button
      onClick={onClick}
      aria-label={playing ? labels[1] : labels[0]}
      title={playing ? labels[1] : labels[0]}
      className="grid h-12 w-12 shrink-0 cursor-pointer place-items-center rounded-full bg-white text-black transition-colors duration-200 hover:bg-neutral-200 active:opacity-80"
    >
      <Icon name={playing ? 'stop' : 'play'} size={20} fill="currentColor" />
    </button>
  );
}

// tone ----------------------------------------------------------------
const LOG_SPAN = Math.log(TONE_MAX / TONE_MIN);
const sliderToHz = (v: number) => TONE_MIN * Math.exp((v / 1000) * LOG_SPAN);
const hzToSlider = (hz: number) => (1000 * Math.log(hz / TONE_MIN)) / LOG_SPAN;

function ToneDock() {
  const exp = useExperience();
  const { tone } = useAudio();
  const sweep = useUI((s) => s.sweep);
  if (!exp) return null;
  const a = exp.audio;
  const v = Math.round(hzToSlider(tone.freq));
  return (
    <div className="flex items-center gap-3">
      <PlayButton playing={tone.running} onClick={() => a.toggleTone()} labels={['Play tone', 'Stop tone']} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor="pitch" className="text-[14px] font-medium">Pitch</label>
          <span className="text-[13px] tabular-nums text-soft">
            {Math.round(tone.freq)} Hz <span className="text-muted">· {noteName(tone.freq)}</span>
          </span>
        </div>
        <input
          id="pitch"
          className="range -my-2.5"
          style={{ ['--fill' as string]: `${v / 10}%` }}
          type="range"
          min={0}
          max={1000}
          value={v}
          aria-valuetext={`${Math.round(tone.freq)} hertz, ${noteName(tone.freq)}`}
          onChange={(e) => {
            ui.set({ sweep: false });
            a.setToneFreq(sliderToHz(+e.target.value));
          }}
        />
        <div className="flex justify-between text-[12px] text-muted" aria-hidden>
          <span>Low</span>
          <span>High</span>
        </div>
      </div>
      <Button
        icon="glide"
        aria-label="Glide"
        aria-pressed={sweep}
        title="Slowly glide through every pitch"
        onClick={() => {
          const on = !sweep;
          ui.set({ sweep: on });
          if (on && !tone.running) a.startTone();
        }}
      >
        <span className="hidden sm:inline">Glide</span>
      </Button>
    </div>
  );
}

// file ----------------------------------------------------------------
function FileDock() {
  const exp = useExperience();
  const { file } = useAudio();
  if (!exp) return null;
  const a = exp.audio;
  if (!file.loaded) {
    return (
      <div className="flex items-center gap-3">
        <Button variant="primary" size="lg" icon="upload" onClick={openFilePicker}>
          Choose a song
        </Button>
        <span className="hidden text-[13px] text-muted sm:inline">or drop an audio file anywhere</span>
      </div>
    );
  }
  const pct = file.duration ? (file.time / file.duration) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <PlayButton
        playing={file.playing}
        labels={['Play', 'Pause']}
        onClick={() => void a.toggleFile().catch((e: Error) => toast('Playback failed: ' + e.message))}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[14px] font-medium" title={file.name}>{file.name}</span>
          <span className="shrink-0 text-[13px] tabular-nums text-muted">
            {fmtTime(file.time)} / {fmtTime(file.duration)}
          </span>
        </div>
        <input
          className="range -my-2.5"
          style={{ ['--fill' as string]: `${pct}%` }}
          type="range"
          min={0}
          max={1000}
          disabled={!file.duration}
          value={Math.round(pct * 10)}
          aria-label="Position in song"
          aria-valuetext={`${fmtTime(file.time)} of ${fmtTime(file.duration)}`}
          onChange={(e) => a.seekFile(+e.target.value / 1000)}
        />
      </div>
      <IconButton icon="upload" label="Choose another song" onClick={openFilePicker} />
    </div>
  );
}

// microphone ------------------------------------------------------------
function MicDock() {
  const exp = useExperience();
  const { mic } = useAudio();
  const meter = useRef<HTMLSpanElement>(null);
  const on = mic.status === 'on';
  useEffect(() => {
    if (!exp || !on || !meter.current) return;
    return exp.bindMeter(meter.current);
  }, [exp, on]);
  if (!exp) return null;
  const a = exp.audio;

  if (on) {
    return (
      <div className="flex items-center gap-3">
        <PlayButton playing onClick={() => a.stopMic()} labels={['Start listening', 'Stop listening']} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between">
            <span className="flex items-center gap-2 text-[14px] font-medium">
              <span className="breathe h-2 w-2 rounded-full bg-white" aria-hidden />
              Listening
            </span>
            {!mic.silent && <span className="text-[13px] text-muted">Hum, sing or whistle</span>}
          </div>
          <span className="mt-2.5 block h-1 overflow-hidden rounded-full bg-[#333]" role="meter" aria-label="Input level">
            <span ref={meter} className="block h-full origin-left rounded-full bg-white" style={{ transform: 'scaleX(0)' }} />
          </span>
          {mic.silent && (
            <span role="status" className="mt-2 block text-[13px] leading-snug text-white">
              {mic.message}
            </span>
          )}
        </div>
      </div>
    );
  }
  const problem = mic.status === 'denied' || mic.status === 'unavailable';
  return (
    <div className="flex items-center gap-3">
      <Button variant="primary" size="lg" icon="mic" disabled={mic.status === 'requesting'} onClick={() => void a.startMic()}>
        {mic.status === 'requesting' ? 'Waiting…' : problem ? 'Try again' : 'Start listening'}
      </Button>
      <span role="status" className={cx('min-w-0 text-[13px] leading-snug', problem ? 'text-white' : 'text-muted')}>
        {problem ? mic.message : 'Your browser will ask for permission. Nothing is recorded.'}
      </span>
    </div>
  );
}
