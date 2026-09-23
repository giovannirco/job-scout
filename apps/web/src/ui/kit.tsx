import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...parts: Array<string | false | null | undefined>) {
  return twMerge(parts.filter(Boolean).join(" "));
}

/* ---------------------------------------------------------------- buttons */

type BtnVariant = "default" | "primary" | "ghost" | "danger" | "outline";
type BtnSize = "xs" | "sm" | "md";

const BTN_VARIANT: Record<BtnVariant, string> = {
  default: "border border-border bg-surface-2 hover:bg-surface-3 text-fg",
  outline: "border border-border-strong bg-transparent hover:bg-surface-2 text-fg",
  primary: "bg-accent text-accent-ink hover:brightness-105 font-semibold shadow-[inset_0_1px_0_rgb(255_255_255/0.18)]",
  ghost: "text-muted hover:text-fg hover:bg-surface-2",
  danger: "border border-bad/40 text-bad hover:bg-bad/10",
};
const BTN_SIZE: Record<BtnSize, string> = {
  xs: "h-6 px-2 text-[11px] rounded-[5px] gap-1",
  sm: "h-7 px-2.5 text-xs rounded-md gap-1.5",
  md: "h-8 px-3 text-[12.5px] rounded-md gap-1.5",
};

export function Btn({
  variant = "default",
  size = "sm",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize }) {
  return (
    <button
      type="button"
      className={cn("inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors disabled:opacity-45 disabled:pointer-events-none", BTN_SIZE[size], BTN_VARIANT[variant], className)}
      {...props}
    />
  );
}

export function IconBtn({ className, active, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-45",
        active && "bg-surface-3 text-fg",
        className,
      )}
      {...props}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="font-mono text-[10px] text-faint border border-border rounded px-1 py-px bg-bg leading-none">{children}</kbd>;
}

/* ---------------------------------------------------------------- surfaces */

export function Card({ children, className, onClick, tone }: { children: ReactNode; className?: string; onClick?: () => void; tone?: "default" | "raised" | "sunken" }) {
  const t = tone === "raised" ? "bg-surface-2" : tone === "sunken" ? "bg-bg" : "bg-surface";
  const interactive = onClick ? "cursor-pointer hover:border-border-strong transition-colors" : "";
  return (
    <div
      className={cn("rounded-lg border border-border", t, interactive, className)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " " ? (e.preventDefault(), onClick()) : undefined) : undefined}
    >
      {children}
    </div>
  );
}

/** Titled panel: eyebrow header row + body. The standard content block across pages. */
export function Panel({ title, meta, actions, children, className, bodyClass, flush }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; flush?: boolean }) {
  return (
    <section className={cn("rounded-lg border border-border bg-surface flex flex-col min-h-0", className)}>
      <header className="flex items-center gap-2 px-3 h-9 border-b border-border shrink-0">
        <h2 className="eyebrow text-muted">{title}</h2>
        {meta ? <span className="font-mono text-[10.5px] tabular text-faint">{meta}</span> : null}
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      </header>
      <div className={cn(flush ? "" : "p-3", "min-h-0", bodyClass)}>{children}</div>
    </section>
  );
}

export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="eyebrow">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({ eyebrow, title, subtitle, actions, children }: { eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          {eyebrow ? <div className="eyebrow mb-1">{eyebrow}</div> : null}
          <h1 className="font-display text-[22px] leading-tight font-semibold tracking-[-0.01em]">{title}</h1>
          {subtitle ? <div className="text-muted text-[12.5px] mt-1">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn("p-4 md:p-6 mx-auto w-full space-y-5", wide ? "max-w-[1600px]" : "max-w-[1280px]", className)}>{children}</div>;
}

/* ---------------------------------------------------------------- chips */

export type Tone = "neutral" | "accent" | "good" | "warn" | "bad" | "info" | "faint";
export const TONE_CHIP: Record<Tone, string> = {
  neutral: "bg-surface-3 text-muted",
  faint: "bg-surface-2 text-faint",
  accent: "bg-accent/15 text-accent",
  good: "bg-good/15 text-good",
  warn: "bg-warn/15 text-warn",
  bad: "bg-bad/15 text-bad",
  info: "bg-info/15 text-info",
};
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  faint: "text-faint",
  accent: "text-accent",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  info: "text-info",
};
export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted",
  faint: "bg-faint",
  accent: "bg-accent",
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-info",
};

export function Chip({ children, tone = "neutral", className, mono = true }: { children: ReactNode; tone?: Tone; className?: string; mono?: boolean }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-[4px] px-1.5 h-[18px] text-[10.5px] font-medium leading-none whitespace-nowrap", mono && "font-mono", TONE_CHIP[tone], className)}>{children}</span>;
}

export function Dot({ tone = "neutral", pulse, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full shrink-0", TONE_DOT[tone], className)}>
      {pulse ? <span className={cn("absolute inset-0 rounded-full animate-ping opacity-60", TONE_DOT[tone])} /> : null}
    </span>
  );
}

/** Company monogram — two letters, deterministic hue from the name. */
export function Monogram({ name, size = 28, className }: { name: string; size?: number; className?: string }) {
  const letters = name
    .replace(/[^a-z0-9 ]/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return (
    <span
      className={cn("inline-flex items-center justify-center rounded-md font-display font-semibold shrink-0 select-none", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: `oklch(0.28 0.06 ${hue} / 1)`,
        color: `oklch(0.85 0.1 ${hue})`,
        border: `1px solid oklch(0.4 0.08 ${hue} / 0.7)`,
      }}
      aria-hidden
    >
      {letters || "•"}
    </span>
  );
}

/* ---------------------------------------------------------------- signal meter (signature) */

/** Five-cell signal meter for 0–5 scores. The one visual every list shares. */
export function Meter({ value, max = 5, tone, className, showValue = true, size = "sm" }: { value: number | null | undefined; max?: number; tone?: Tone; className?: string; showValue?: boolean; size?: "sm" | "md" }) {
  const cells = 5;
  const v = value == null ? 0 : Math.max(0, Math.min(max, value));
  const filled = value == null ? 0 : (v / max) * cells;
  const t: Tone = tone ?? (value == null ? "faint" : v >= 4 ? "good" : v >= 3 ? "warn" : "bad");
  const h = size === "md" ? "h-3" : "h-2.5";
  const w = size === "md" ? "w-1.5" : "w-1";
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} title={value == null ? "no score" : `${v.toFixed(1)} / ${max}`}>
      <span className="inline-flex items-end gap-px" aria-hidden>
        {Array.from({ length: cells }, (_, i) => {
          const fill = Math.max(0, Math.min(1, filled - i));
          return (
            <span key={i} className={cn("relative rounded-[1px] overflow-hidden", h, w)} style={{ background: "var(--t-meter-empty)" }}>
              {fill > 0 ? <span className={cn("absolute inset-x-0 bottom-0", TONE_DOT[t])} style={{ height: `${fill * 100}%`, opacity: value == null ? 0.3 : 1 }} /> : null}
            </span>
          );
        })}
      </span>
      {showValue ? <span className={cn("font-mono tabular text-[11.5px]", value == null ? "text-faint" : TONE_TEXT[t])}>{value == null ? "—" : v.toFixed(1)}</span> : null}
    </span>
  );
}

/* ---------------------------------------------------------------- forms */

const FIELD = "w-full rounded-md border border-border bg-bg px-2.5 h-8 text-[12.5px] outline-none focus:border-accent placeholder:text-faint disabled:opacity-50";

export function Input({ label, className, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <label className="block space-y-1" htmlFor={id}>
      {label ? <span className="eyebrow block">{label}</span> : null}
      <input id={id} className={cn(FIELD, className)} {...rest} />
      {hint ? <span className="block text-[11px] text-faint">{hint}</span> : null}
    </label>
  );
}

export function Textarea({ label, className, hint, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <label className="block space-y-1" htmlFor={id}>
      {label ? <span className="eyebrow block">{label}</span> : null}
      <textarea id={id} className={cn(FIELD, "h-auto py-1.5 min-h-[80px] resize-y leading-relaxed", className)} {...rest} />
      {hint ? <span className="block text-[11px] text-faint">{hint}</span> : null}
    </label>
  );
}

export function Select({ label, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  const id = useId();
  return (
    <label className="block space-y-1" htmlFor={id}>
      {label ? <span className="eyebrow block">{label}</span> : null}
      <select id={id} className={cn(FIELD, "pr-7", className)} {...rest}>
        {children}
      </select>
    </label>
  );
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn("flex items-start gap-2.5 select-none", disabled ? "opacity-50" : "cursor-pointer")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-px h-[18px] w-[30px] shrink-0 rounded-full border transition-colors", checked ? "bg-accent border-accent" : "bg-surface-3 border-border-strong")}
      >
        <span className={cn("absolute top-[2px] h-3 w-3 rounded-full transition-all", checked ? "left-[14px] bg-accent-ink" : "left-[2px] bg-muted")} />
      </button>
      {label || hint ? (
        <span className="min-w-0">
          {label ? <span className="block text-[12.5px]">{label}</span> : null}
          {hint ? <span className="block text-[11px] text-faint">{hint}</span> : null}
        </span>
      ) : null}
    </label>
  );
}

export function Seg<T extends string>({ value, onChange, options, className, size = "sm" }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number | null; tone?: Tone }[]; className?: string; size?: "xs" | "sm" }) {
  return (
    <div className={cn("inline-flex rounded-md border border-border bg-bg p-0.5", size === "xs" ? "text-[11px]" : "text-xs", className)} role="tablist">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn("flex items-center gap-1.5 rounded-[5px] transition-colors whitespace-nowrap", size === "xs" ? "px-2 py-0.5" : "px-2.5 py-1", active ? "bg-surface-3 text-fg shadow-[0_1px_0_rgb(0_0_0/0.15)]" : "text-muted hover:text-fg")}
          >
            {o.label}
            {o.count != null ? <span className={cn("font-mono text-[10px] tabular", active ? (o.tone ? TONE_TEXT[o.tone] : "text-muted") : "text-faint")}>{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Underlined tab strip (page-level) */
export function Tabs<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number | null; tone?: Tone }[]; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1 border-b border-border overflow-x-auto no-scrollbar", className)} role="tablist">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn("relative flex items-center gap-1.5 px-2.5 h-9 text-[12.5px] whitespace-nowrap transition-colors -mb-px border-b-2", active ? "text-fg border-accent" : "text-muted hover:text-fg border-transparent")}
          >
            {o.label}
            {o.count != null ? <span className={cn("font-mono text-[10px] tabular", o.tone ? TONE_TEXT[o.tone] : "text-faint")}>{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Field({ label, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[110px_1fr] gap-x-3 gap-y-0.5 items-baseline text-[12.5px]", className)}>
      <div className="eyebrow">{label}</div>
      <div className="min-w-0 break-words">{children}</div>
      {hint ? <div className="col-start-2 text-[11px] text-faint">{hint}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- tables */

export function Table({ children, className, dense }: { children: ReactNode; className?: string; dense?: boolean }) {
  return (
    <div className={cn("overflow-x-auto rounded-lg border border-border bg-surface", className)}>
      <table className={cn("w-full border-collapse", dense ? "text-[12px]" : "text-[12.5px]")}>{children}</table>
    </div>
  );
}
export function Th({ children, className, right, w }: { children?: ReactNode; className?: string; right?: boolean; w?: number | string }) {
  return (
    <th style={w ? { width: w } : undefined} className={cn("eyebrow text-left font-medium px-3 h-8 border-b border-border whitespace-nowrap bg-surface sticky top-0 z-[1]", right && "text-right", className)}>
      {children}
    </th>
  );
}

export function SortHead({
  label,
  field,
  sort,
  onSort,
}: {
  label: ReactNode;
  field: string;
  sort?: string;
  onSort: (next: string) => void;
}) {
  const active = sort === field || sort === `${field}_asc` || sort === `${field}_desc`;
  const next = sort === `${field}_desc` || sort === field ? `${field}_asc` : `${field}_desc`;
  return (
    <button type="button" className={cn("hover:text-fg", active && "text-fg")} onClick={() => onSort(next)}>
      {label}
    </button>
  );
}
export function Td({ children, className, right, mono, colSpan, title }: { children?: ReactNode; className?: string; right?: boolean; mono?: boolean; colSpan?: number; title?: string }) {
  return (
    <td title={title} colSpan={colSpan} className={cn("px-3 py-1.5 border-b border-border/60 align-middle", right && "text-right", mono && "font-mono tabular text-[11.5px]", className)}>
      {children}
    </td>
  );
}
export function Tr({ children, onClick, className, selected }: { children: ReactNode; onClick?: () => void; className?: string; selected?: boolean }) {
  return (
    <tr className={cn("group", onClick && "cursor-pointer hover:bg-surface-2/70", selected && "bg-accent/[0.07]", className)} onClick={onClick}>
      {children}
    </tr>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between text-[11px] text-muted font-mono tabular pt-1">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <IconBtn label="previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </IconBtn>
        <span>
          {page}/{pages}
        </span>
        <IconBtn label="next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight className="h-3.5 w-3.5" />
        </IconBtn>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- states */

export function Empty({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("py-12 px-4 text-center text-muted text-[12.5px] border border-dashed border-border rounded-lg space-y-3", className)}>
      <div>{children}</div>
      {action}
    </div>
  );
}

export function Loading({ label = "loading", rows = 3, className }: { label?: string; rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2 py-2", className)} aria-busy aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-7 rounded-md bg-surface-2 animate-pulse" style={{ width: `${100 - i * 9}%`, animationDelay: `${i * 80}ms` }} />
      ))}
    </div>
  );
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  const msg = error instanceof Error ? error.message : String(error);
  return <div className={cn("rounded-md border border-bad/40 bg-bad/10 text-bad text-[12px] px-3 py-2", className)}>{msg}</div>;
}

export function Kpi({ label, value, hint, tone = "neutral", onClick, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone; onClick?: () => void; className?: string }) {
  const t = tone === "neutral" ? "text-fg" : TONE_TEXT[tone];
  return (
    <Card className={cn("p-3", className)} onClick={onClick}>
      <div className="eyebrow">{label}</div>
      <div className={cn("font-display text-[26px] leading-none font-semibold tabular mt-2", t)}>{value}</div>
      {hint ? <div className="text-[11px] text-faint mt-1.5">{hint}</div> : null}
    </Card>
  );
}

/* ---------------------------------------------------------------- overlays */

export function Modal({ open, onClose, children, wide, title }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean; title?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-2 sm:p-6">
      <button type="button" aria-label="Close dialog" className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div role="dialog" aria-modal="true" className={cn("relative z-10 w-full rounded-xl border border-border bg-surface shadow-pop overflow-hidden max-h-[92vh] flex flex-col", wide ? "max-w-5xl" : "max-w-2xl")} onClick={(e) => e.stopPropagation()}>
        {title ? (
          <div className="flex items-center justify-between px-4 h-11 border-b border-border shrink-0">
            <div className="font-display font-semibold text-[14px]">{title}</div>
            <IconBtn label="Close" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </IconBtn>
          </div>
        ) : null}
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- data viz */

export function Sparkline({ values, className, tone = "accent", height = 28 }: { values: number[]; className?: string; tone?: Tone; height?: number }) {
  const w = 120;
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${(i / n) * w},${height - (v / max) * (height - 2) - 1}`).join(" ");
  const color = `var(--color-${tone === "neutral" ? "muted" : tone})`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className={cn("w-full", className)} style={{ height }} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <polyline points={`0,${height} ${pts} ${w},${height}`} fill={color} opacity="0.12" stroke="none" />
    </svg>
  );
}

export function Bars({ values, className, tone = "accent", height = 28, labels }: { values: number[]; className?: string; tone?: Tone; height?: number; labels?: string[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className={cn("flex items-end gap-px", className)} style={{ height }} aria-hidden>
      {values.map((v, i) => (
        <span key={i} title={labels?.[i]} className={cn("flex-1 rounded-[1px] min-w-[3px]", TONE_DOT[tone])} style={{ height: `${Math.max(4, (v / max) * 100)}%`, opacity: v === 0 ? 0.18 : 0.85 }} />
      ))}
    </div>
  );
}

/** Horizontal usage bar: value/limit, limit 0 = unlimited */
export function Budget({ value, limit, label, className }: { value: number; limit: number; label: ReactNode; className?: string }) {
  const pct = limit > 0 ? Math.min(100, (value / limit) * 100) : 0;
  const tone: Tone = limit === 0 ? "neutral" : pct >= 100 ? "bad" : pct >= 80 ? "warn" : "good";
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono tabular text-faint">
          {value.toLocaleString()}
          {limit > 0 ? ` / ${limit.toLocaleString()}` : " · no cap"}
        </span>
      </div>
      <div className="h-1 rounded-full bg-surface-3 overflow-hidden">
        <div className={cn("h-full rounded-full", TONE_DOT[tone])} style={{ width: limit > 0 ? `${pct}%` : "0%" }} />
      </div>
    </div>
  );
}
