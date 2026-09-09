import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { patch, useAction, type PipelineStatus } from "@/lib/api";
import { Dot, TONE_CHIP, cn } from "@/ui/kit";
import { STATUS_LABEL, STATUS_PATH, STATUS_TERMINAL, STATUS_TONE } from "./badges";

export function useStatusChange() {
  return useAction(
    async ({ id, status }: { id: string; status: PipelineStatus }) => {
      await patch(`/api/v1/positions/${id}`, { status });
      return status;
    },
    ["positions", "today", "position", "company"],
  );
}

/** Status pill that opens a menu. Forward path first, terminal states below a rule. */
export function StatusMenu({ id, value, size = "sm", className, align = "left" }: { id: string; value: PipelineStatus; size?: "sm" | "md"; className?: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const m = useStatusChange();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tone = STATUS_TONE[value] || "neutral";
  const pick = (status: PipelineStatus) => {
    setOpen(false);
    if (status === value) return;
    m.mutateAsync({ id, status })
      .then(() => toast.success(`Moved to ${STATUS_LABEL[status]}`))
      .catch((err) => toast.error(err.message));
  };

  return (
    <div ref={ref} className={cn("relative inline-block", className)} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-transparent hover:border-border-strong transition-colors whitespace-nowrap",
          size === "md" ? "h-7 px-2 text-[12.5px]" : "h-[22px] px-1.5 text-[11.5px]",
          TONE_CHIP[tone],
          m.isPending && "opacity-60",
        )}
      >
        <Dot tone={tone} />
        {STATUS_LABEL[value] || value}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open ? (
        <div role="menu" className={cn("absolute z-30 mt-1 w-44 rounded-md border border-border bg-surface shadow-pop py-1", align === "right" ? "right-0" : "left-0")}>
          {STATUS_PATH.map((s) => (
            <Item key={s} s={s} current={value} onPick={pick} />
          ))}
          <div className="my-1 border-t border-border" />
          {STATUS_TERMINAL.map((s) => (
            <Item key={s} s={s} current={value} onPick={pick} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Item({ s, current, onPick }: { s: PipelineStatus; current: PipelineStatus; onPick: (s: PipelineStatus) => void }) {
  return (
    <button type="button" role="menuitem" onClick={() => onPick(s)} className={cn("w-full flex items-center gap-2 px-2.5 h-7 text-left text-[12px] hover:bg-surface-2", s === current && "bg-surface-2 font-medium")}>
      <Dot tone={STATUS_TONE[s]} />
      {STATUS_LABEL[s]}
    </button>
  );
}
