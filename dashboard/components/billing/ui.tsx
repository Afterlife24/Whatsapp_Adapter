"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { HEALTH_META, TONE, type AccountHealth, type Tone } from "@/lib/billing";

// ---------------------------------------------------------------------------
// Tokens — matched to the existing agent editor so billing feels native.
// ---------------------------------------------------------------------------

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0f]";

export const inputCls =
  "w-full bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg px-3 py-2 text-sm text-white placeholder-[#44445a] transition-colors focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-50";

export const labelCls = "block text-xs font-medium text-[#8888aa] mb-1.5";

export const cardCls = "bg-[#0d0d14] rounded-xl border border-[#1e1e2e]";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-indigo-600 text-white hover:bg-indigo-500 shadow-[0_1px_0_rgba(255,255,255,0.08)_inset] disabled:hover:bg-indigo-600",
  secondary:
    "bg-[#13131c] border border-[#2a2a3a] text-[#c4c4d8] hover:bg-[#1a1a26] hover:text-white",
  ghost: "text-[#8888aa] hover:bg-[#1a1a26] hover:text-white",
  danger: "border border-rose-500/25 text-rose-300 hover:bg-rose-500/10",
};

export function buttonCls(variant: ButtonVariant = "primary", size: "sm" | "md" = "md"): string {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
    size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
    BUTTON_VARIANTS[variant],
    focusRing
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} className={cn("animate-spin", className)} aria-hidden="true" />;
}

export function Badge({
  tone,
  children,
  dot = false,
  pulse = false,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap",
        TONE[tone].soft,
        className
      )}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          {pulse && (
            <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", TONE[tone].dot)} />
          )}
          <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", TONE[tone].dot)} />
        </span>
      )}
      {children}
    </span>
  );
}

export function HealthBadge({ health }: { health: AccountHealth }) {
  const meta = HEALTH_META[health];
  return (
    <Badge tone={meta.tone} dot pulse={health === "empty" || health === "blocked"}>
      {meta.label}
    </Badge>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-[#16161f]", className)} aria-hidden="true" />;
}

export function Notice({
  tone,
  icon,
  title,
  children,
  action,
  className,
  role,
}: {
  tone: Tone;
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  role?: "alert" | "status";
}) {
  return (
    <div role={role} className={cn("flex gap-3 rounded-lg border px-3.5 py-3 text-sm", TONE[tone].soft, className)}>
      {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
      <div className="min-w-0 flex-1 space-y-0.5">
        {title && <p className="font-medium text-white/90">{title}</p>}
        {children && <div className="text-[13px] leading-relaxed opacity-90">{children}</div>}
        {action && <div className="pt-2">{action}</div>}
      </div>
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[#1e1e2e] px-5 py-4">
      <div className="min-w-0">
        <h2 className="font-semibold text-white">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-[#66667f]">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context): nothing useful to do.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
      className={cn("rounded p-1 text-[#66667f] transition-colors hover:bg-[#1a1a26] hover:text-white", focusRing)}
    >
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
    </button>
  );
}

/** Label / value row used in confirmation summaries. */
export function SummaryRow({
  label,
  children,
  emphasis = false,
}: {
  label: string;
  children: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-xs text-[#8888aa]">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-right tabular-nums",
          emphasis ? "text-base font-semibold text-white" : "text-sm text-[#d4d4e4]"
        )}
      >
        {children}
      </dd>
    </div>
  );
}
