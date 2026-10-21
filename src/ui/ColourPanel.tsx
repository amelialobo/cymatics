/** Colours: background and sand, in their own pop-up so the plate stays in view while you pick. */
import { useEffect, useId, useRef } from 'react';
import { setParams, ui, useUI } from '../core/store';
import { FIXED_PAIRS, contrast, fromHex, toHex } from '../pattern/palette';
import { useExperience } from './context';
import { Button, IconButton, cx } from './primitives';

/** shown on a swatch while that part keeps changing with the sound */
const CHANGING = 'conic-gradient(#FFD3B6, #4A0E1F, #FFE7A3, #12372A, #CFE8FF, #14213D, #E4D7FF, #FFD3B6)';
/** the full hue circle, for the button that opens this pop-up */
const WHEEL = 'conic-gradient(#ff4d4d, #ffb84d, #f5f54d, #4dff88, #4dd2ff, #6b4dff, #ff4dd2, #ff4d4d)';

export function ColourWheelButton() {
  const open = useUI((s) => s.coloursOpen);
  return (
    <button
      aria-label="Colours"
      title="Colours"
      aria-expanded={open}
      aria-controls="colour-panel"
      onClick={() => ui.set({ coloursOpen: !open, panelOpen: false, helpOpen: false })}
      className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full transition-colors duration-200 hover:bg-raised active:opacity-80 aria-expanded:bg-raised"
    >
      <span aria-hidden className="relative block h-5 w-5 rounded-full ring-1 ring-white/70" style={{ background: WHEEL }}>
        <span className="absolute inset-[6px] rounded-full bg-ink" />
      </span>
    </button>
  );
}

export function ColourPanel() {
  const open = useUI((s) => s.coloursOpen);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [open]);
  const close = () => ui.set({ coloursOpen: false });

  return (
    <>
      {/* no dimming: the plate behind is the preview */}
      {open && <div aria-hidden className="fixed inset-0 z-20 md:hidden" onClick={close} />}
      <div
        ref={ref}
        id="colour-panel"
        role="dialog"
        aria-label="Colours"
        inert={!open}
        className={cx(
          'fixed z-30 flex flex-col overflow-hidden bg-surface ring-1 ring-line transition-[transform,opacity] duration-300 ease-out-quint',
          'inset-x-0 bottom-0 max-h-[70dvh] rounded-t-3xl',
          'md:inset-x-auto md:right-4 md:bottom-[calc(var(--dock-h,80px)+12px)] md:max-h-[calc(100dvh-var(--dock-h,80px)-88px)] md:w-[340px] md:rounded-2xl',
          open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0 md:translate-y-4'
        )}
      >
        <div className="relative flex min-h-14 shrink-0 items-center justify-between border-b border-line pl-5 pr-2">
          <span className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-[#444] md:hidden" aria-hidden />
          <h2 className="text-[16px] font-semibold">Colours</h2>
          <IconButton data-autofocus icon="close" label="Close" onClick={close} />
        </div>
        <div className="overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          <ColourOptions />
        </div>
      </div>
    </>
  );
}

function ColourOptions() {
  const exp = useExperience();
  const bg = useUI((s) => s.params.bgColor);
  const sand = useUI((s) => s.params.sandColor);
  if (!exp) return null;
  // the colour on screen right now: the starting point when you switch a part to Custom
  const now = (offset: number) => toHex(exp.color.rgb, offset);
  const ratio = bg && sand ? contrast(fromHex(bg), fromHex(sand)) : null;
  const hint =
    !bg && !sand
      ? 'Both change with the pitch. Pick a colour to fix one, or choose a pair.'
      : bg && sand
        ? 'Your own colours. Switch either back to Changing to let the sound take over.'
        : bg
          ? 'Your background stays put; the sand keeps changing and stays easy to see.'
          : 'Your sand stays put; the background keeps changing and stays easy to see.';

  return (
    <section className="grid gap-4 px-5 py-5">
      <p className="-mt-1 text-[12.5px] leading-snug text-muted">{hint}</p>
      <ColourRow label="Background" value={bg} now={() => now(0)} onPick={(c) => setParams({ bgColor: c })} />
      <ColourRow label="Sand" value={sand} now={() => now(3)} onPick={(c) => setParams({ sandColor: c })} />

      {ratio !== null && (
        <p role="status" className={cx('text-[12.5px] leading-snug', ratio < 3 ? 'text-white' : 'text-muted')}>
          Contrast {ratio.toFixed(1)} : 1 ·{' '}
          {ratio >= 4.5 ? 'easy to see' : ratio >= 3 ? 'readable' : 'hard to see. Try a much lighter or darker sand.'}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button disabled={!bg && !sand} onClick={() => setParams({ bgColor: sand ?? now(3), sandColor: bg ?? now(0) })}>
          Swap
        </Button>
        <Button disabled={!bg && !sand} onClick={() => setParams({ bgColor: null, sandColor: null })}>
          Keep changing
        </Button>
      </div>

      <div className="grid gap-2">
        <span className="text-[14px] font-medium">Quick pairs</span>
        <div className="grid grid-cols-6 gap-1.5">
          {FIXED_PAIRS.map((pp) => {
            const b = toHex(pp.background), sd = toHex(pp.sand);
            const on = bg?.toLowerCase() === b && sand?.toLowerCase() === sd;
            return (
              <button
                key={pp.name}
                title={pp.name}
                aria-label={pp.name}
                aria-pressed={on}
                onClick={() => setParams({ bgColor: b, sandColor: sd })}
                className={cx(
                  'grid aspect-square min-h-11 cursor-pointer place-items-center rounded-full ring-inset transition-shadow duration-200',
                  on ? 'ring-2 ring-white' : 'ring-1 ring-line hover:ring-white/60'
                )}
                style={{ background: b }}
              >
                <span className="h-3 w-3 rounded-full" style={{ background: sd }} />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ColourRow({ label, value, now, onPick }: { label: string; value: string | null; now: () => string; onPick: (c: string | null) => void }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <span id={id} className="text-[14px] font-medium">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-labelledby={id} className="flex rounded-full bg-raised p-1 ring-1 ring-line ring-inset">
          {(['Changing', 'Custom'] as const).map((opt) => {
            const on = opt === 'Changing' ? !value : !!value;
            return (
              <button
                key={opt}
                role="radio"
                aria-checked={on}
                onClick={() => onPick(opt === 'Changing' ? null : value ?? now())}
                className={cx(
                  'min-h-9 cursor-pointer rounded-full px-3 text-[13px] font-medium transition-colors duration-200',
                  on ? 'bg-white text-black' : 'text-soft hover:text-white'
                )}
              >
                {opt}
              </button>
            );
          })}
        </div>
        <label
          className="relative h-11 w-11 shrink-0 cursor-pointer rounded-full ring-1 ring-line ring-inset transition-shadow hover:ring-white/60 focus-within:ring-2 focus-within:ring-white"
          style={{ background: value ?? CHANGING }}
          title={`Pick a ${label.toLowerCase()} colour`}
        >
          <span className="sr-only">Pick a {label.toLowerCase()} colour</span>
          <input
            type="color"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            value={value ?? now()}
            onChange={(e) => onPick(e.target.value)}
          />
        </label>
      </div>
    </div>
  );
}
