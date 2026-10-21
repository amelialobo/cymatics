import { useId, type ButtonHTMLAttributes, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet';
  icon?: IconName;
  size?: 'md' | 'lg';
};

export function Button({ variant = 'secondary', icon, size = 'md', className, children, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex cursor-pointer select-none items-center justify-center gap-2 rounded-full font-medium transition-[background-color,color,box-shadow,opacity] duration-200',
        'active:opacity-80 disabled:cursor-default disabled:opacity-35',
        size === 'lg' ? 'min-h-12 px-5 text-[15px]' : 'min-h-11 px-4 text-[14px]',
        variant === 'primary' && 'bg-white text-black hover:bg-neutral-200',
        variant === 'secondary' && 'bg-raised text-white ring-1 ring-line ring-inset hover:bg-[#262626] aria-pressed:bg-white aria-pressed:text-black aria-pressed:ring-white',
        variant === 'quiet' && 'text-soft hover:bg-raised hover:text-white',
        className
      )}
    >
      {icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  );
}

/** round icon-only button; always carries an accessible name */
export function IconButton({
  icon,
  label,
  className,
  ...rest
}: ComponentProps<'button'> & { icon: IconName; label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        'grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full text-soft transition-colors duration-200 hover:bg-raised hover:text-white active:opacity-80',
        'aria-pressed:bg-white aria-pressed:text-black aria-expanded:bg-raised aria-expanded:text-white',
        className
      )}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  ends,
  display,
  valueText,
  hideLabel,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** plain-language ends of the scale, e.g. ['Calm', 'Lively'] */
  ends?: [string, string];
  display?: ReactNode;
  valueText?: string;
  hideLabel?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div className="grid">
      <div className={cx('flex items-baseline justify-between gap-3', hideLabel && 'sr-only')}>
        <label htmlFor={id} className="text-[14px] font-medium text-white">
          {label}
        </label>
        {display !== undefined && <span className="text-[13px] tabular-nums text-muted">{display}</span>}
      </div>
      <input
        id={id}
        className="range"
        style={{ '--fill': fill } as CSSProperties}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={valueText}
        onChange={(e) => onChange(+e.target.value)}
      />
      {ends && (
        <div className="-mt-2 flex justify-between text-[12px] text-muted" aria-hidden>
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
    </div>
  );
}

export function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="grid">
        <span id={id} className="text-[14px] font-medium">{label}</span>
        {hint && <span className="text-[12.5px] leading-snug text-muted">{hint}</span>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        onClick={() => onChange(!checked)}
        className="relative grid h-11 w-14 shrink-0 cursor-pointer place-items-center"
      >
        <span className={cx('block h-7 w-12 rounded-full transition-colors duration-200', checked ? 'bg-white' : 'bg-[#3a3a3a]')} />
        <span
          className={cx(
            'absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full transition-[left,background-color] duration-200',
            checked ? 'left-[calc(100%-1.75rem)] bg-black' : 'left-[0.5rem] bg-white'
          )}
        />
      </button>
    </div>
  );
}

export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-[14px] font-medium">{label}</span>
      <div role="radiogroup" aria-label={label} className="grid grid-flow-col gap-1 rounded-full bg-raised p-1 ring-1 ring-line ring-inset">
        {options.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={o.value === value}
            onClick={() => onChange(o.value)}
            className={cx(
              'min-h-10 cursor-pointer rounded-full px-2 text-[13px] font-medium transition-colors duration-200',
              o.value === value ? 'bg-white text-black' : 'text-soft hover:text-white'
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 px-5 py-5">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">{title}</h3>
      {children}
    </section>
  );
}
