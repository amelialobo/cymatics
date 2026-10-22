import { useEffect, useRef } from 'react';
import { toast, ui, useUI, writeFlag } from '../core/store';
import { openFilePicker, useExperience } from './context';
import { Icon, type IconName } from './icons';
import { Button, IconButton, cx } from './primitives';

// --------------------------------------------------------------- intro
/** the title the sand spells on load, and the button that sets it free */
/** the title the sand spells while the plate gets ready; it hands over by itself */
export function Intro() {
  const phase = useUI((s) => (s.loading ? 'loading' : s.intro));
  // the message is up from the start, and stays while the word disperses
  const show = phase !== 'done';
  if (phase === 'done') return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-30">
      <h1 className="sr-only">Cymatics</h1>
      <div
        className={cx(
          'absolute inset-x-0 flex justify-center px-4 transition-opacity duration-500',
          show ? 'opacity-100' : 'opacity-0'
        )}
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + clamp(24px, 6vh, 56px))' }}
      >
        <p role="status" className="flex items-center gap-2.5 rounded-full bg-black/70 px-4 py-1.5 text-[15px] text-white backdrop-blur-sm sm:text-[16px]">
          <span aria-hidden className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/25 border-t-white" />
          Preparing the plate…
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- welcome
export function Welcome() {
  const exp = useExperience();
  const show = useUI((s) => s.welcome && !s.loading && s.intro === 'done');
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (show) first.current?.focus({ preventScroll: true });
  }, [show]);
  if (!show || !exp) return null;

  const done = () => {
    writeFlag('cymatics:welcomed', true);
    ui.set({ welcome: false });
  };
  const choices: { icon: IconName; title: string; text: string; go: () => void }[] = [
    {
      icon: 'mic',
      title: 'Use your voice',
      text: 'Hum, sing or whistle into the microphone',
      go: () => {
        ui.set({ tab: 'live' });
        void exp.audio.startMic();
      },
    },
    {
      icon: 'wave',
      title: 'Play a tone',
      text: 'Slide the pitch and watch shapes change',
      go: () => {
        ui.set({ tab: 'tone' });
        exp.audio.startTone();
      },
    },
    {
      icon: 'music',
      title: 'Play a song',
      text: 'Upload any audio file from your device',
      go: () => {
        ui.set({ tab: 'file' });
        openFilePicker();
      },
    },
  ];

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/55 p-4" onClick={done}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        onClick={(e) => e.stopPropagation()}
        className="rise w-full max-w-[440px] rounded-3xl bg-surface/95 p-6 ring-1 ring-line backdrop-blur-md sm:p-7"
      >
        <h2 id="welcome-title" className="text-[24px] font-semibold leading-tight tracking-tight">
          Sound shapes sand
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-soft">
          Every sound makes this metal plate vibrate. The sand gathers wherever the plate stays still and draws the sound’s shape.
        </p>
        <div className="mt-5 grid gap-2">
          {choices.map((c, i) => (
            <button
              key={c.title}
              ref={i === 0 ? first : undefined}
              onClick={() => {
                done();
                c.go();
              }}
              className="group flex min-h-16 cursor-pointer items-center gap-4 rounded-2xl bg-raised px-4 py-3 text-left ring-1 ring-line ring-inset transition-colors duration-200 hover:bg-[#242424] hover:ring-white/40"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-black">
                <Icon name={c.icon} />
              </span>
              <span className="grid">
                <span className="text-[15px] font-semibold">{c.title}</span>
                <span className="text-[13px] text-muted">{c.text}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- help
export function Help() {
  const open = useUI((s) => s.helpOpen);
  const close = () => ui.set({ helpOpen: false });
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) btn.current?.focus({ preventScroll: true });
  }, [open]);
  if (!open) return null;
  const keys: [string, string][] = [
    ['Space', 'Play or stop'],
    ['← →', 'Change the tone’s pitch'],
    ['P', 'Freeze or resume the sand'],
    ['R', 'Scatter the sand'],
    ['S', 'Save an image'],
    ['A', 'Open Adjust'],
    ['C', 'Open Colours'],
    ['F', 'Full screen'],
    ['?', 'This help'],
    ['Esc', 'Close panels'],
  ];
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/55 p-4" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(e) => e.stopPropagation()}
        className="rise relative max-h-[85dvh] w-full max-w-[460px] overflow-y-auto rounded-3xl bg-surface p-6 ring-1 ring-line sm:p-7"
      >
        <IconButton ref={btn} icon="close" label="Close" className="absolute right-3 top-3" onClick={close} />
        <h2 id="help-title" className="text-[20px] font-semibold">How it works</h2>
        <ol className="mt-4 grid gap-3 text-[14px] leading-relaxed text-soft">
          <li><b className="font-semibold text-white">Sound vibrates the plate.</b> Each pitch makes it ripple in its own pattern.</li>
          <li><b className="font-semibold text-white">Sand finds the still lines.</b> It bounces off the moving parts and settles where the plate doesn’t move.</li>
          <li><b className="font-semibold text-white">Higher notes, finer shapes.</b> Low sounds draw big simple figures; high sounds draw intricate lace.</li>
        </ol>
        <h3 className="mt-6 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Try this</h3>
        <ul className="mt-2 grid gap-1.5 text-[14px] text-soft">
          <li>Hold one steady note and watch the sand settle.</li>
          <li>Press Glide in the tone controls to sweep through every shape.</li>
          <li>Touch or drag on the plate to stir the sand.</li>
        </ul>
        <h3 className="mt-6 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Keyboard</h3>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[14px]">
          {keys.map(([k, v]) => (
            <div key={k} className="contents">
              <dt><kbd className="rounded-md bg-raised px-2 py-0.5 font-sans text-[12.5px] ring-1 ring-line">{k}</kbd></dt>
              <dd className="text-soft">{v}</dd>
            </div>
          ))}
        </dl>
        <Button
          className="mt-6 w-full"
          onClick={() => {
            close();
            writeFlag('cymatics:welcomed', false);
            ui.set({ welcome: true });
          }}
        >
          Show the welcome screen again
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- details
export function Details() {
  const exp = useExperience();
  const show = useUI((s) => s.details);
  const freq = useRef<HTMLElement>(null);
  const rms = useRef<HTMLElement>(null);
  const mode = useRef<HTMLElement>(null);
  const complexity = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!exp) return;
    exp.bindReadout(
      show
        ? { freq: freq.current, rms: rms.current, mode: mode.current, complexity: complexity.current }
        : { freq: null, rms: null, mode: null, complexity: null }
    );
  }, [exp, show]);
  if (!show) return null;
  const rows: [string, React.RefObject<HTMLElement | null>][] = [
    ['Pitch', freq],
    ['Volume', rms],
    ['Pattern', mode],
    ['Detail', complexity],
  ];
  return (
    <dl
      aria-label="Sound details"
      className="pointer-events-none fixed left-3 z-10 grid min-w-[220px] gap-1 rounded-2xl bg-black/75 px-4 py-3 text-[13px] ring-1 ring-line backdrop-blur-sm md:left-5"
      style={{ bottom: 'calc(var(--dock-h, 80px) + 12px)' }}
    >
      {rows.map(([label, r]) => (
        <div key={label} className="grid grid-cols-[64px_1fr] gap-3">
          <dt className="text-muted">{label}</dt>
          <dd ref={r} className="tabular-nums">—</dd>
        </div>
      ))}
    </dl>
  );
}

// -------------------------------------------------------------- others
export function Toast() {
  const msg = useUI((s) => s.toast);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'fixed left-1/2 top-[72px] z-50 max-w-[min(440px,calc(100vw-32px))] -translate-x-1/2 rounded-full bg-white px-5 py-2.5 text-center text-[14px] font-medium text-black shadow-lg transition-[opacity,transform] duration-300',
        msg ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-2 opacity-0'
      )}
    >
      {msg}
    </div>
  );
}

export function DropOverlay({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden
      className={cx(
        'pointer-events-none fixed inset-4 z-50 grid place-items-center rounded-3xl border-2 border-dashed border-white/50 bg-black/70 transition-opacity duration-200',
        active ? 'opacity-100' : 'opacity-0'
      )}
    >
      <span className="flex items-center gap-3 text-[18px] font-medium">
        <Icon name="music" size={24} /> Drop to play this sound
      </span>
    </div>
  );
}

/** hidden file input shared by every “choose a song” button */
export function FileInput() {
  const exp = useExperience();
  return (
    <input
      id="file-input"
      type="file"
      className="hidden"
      accept="audio/*,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.webm"
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f || !exp) return;
        exp.audio.loadFile(f);
        ui.set({ tab: 'file' });
        void exp.audio.playFile().catch(() => toast('Loaded. Press play to start.'));
      }}
    />
  );
}

/** the screw that drives the plate, as in the photographs */
export function Bolt() {
  // hidden until the title, which sits where it would be, has dispersed
  const hidden = useUI((s) => s.intro !== 'done');
  return (
    <div
      aria-hidden
      className={cx(
        'pointer-events-none fixed left-1/2 top-[calc(50%-var(--dock-h,0px)/2)] z-[1] h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-700',
        hidden ? 'opacity-0' : 'opacity-100'
      )}
      style={{
        background:
          'radial-gradient(circle at 50% 50%, #0b0b0b 0 22%, transparent 24%), radial-gradient(circle at 38% 32%, #f2f2f2 0, #999 32%, #3a3a3a 62%, #111 80%)',
        boxShadow: '0 0 0 3px rgba(0,0,0,.35), 0 0 0 4px rgba(255,255,255,.25), 0 2px 10px 2px rgba(0,0,0,.3)',
      }}
    />
  );
}

export function NoRenderer() {
  return (
    <div className="fixed inset-0 grid place-items-center p-8 text-center">
      <p className="max-w-sm text-[15px] leading-relaxed text-soft">
        This browser can’t draw the plate. Please try a recent version of Chrome, Firefox, Safari or Edge.
      </p>
    </div>
  );
}
