import type { BillingAccount, LedgerEntry, Payment } from "@/lib/api";
import { isPositive, toScaled } from "@/lib/money";

// ---------------------------------------------------------------------------
// Account health
// ---------------------------------------------------------------------------

export type AccountHealth = "unavailable" | "blocked" | "empty" | "low" | "healthy";

/** Most urgent first: used to sort the account list. */
export const HEALTH_ORDER: AccountHealth[] = ["blocked", "empty", "low", "unavailable", "healthy"];

export interface HealthMeta {
  label: string;
  /** One-line explanation shown next to the balance. */
  hint: string;
  tone: Tone;
}

export const HEALTH_META: Record<AccountHealth, HealthMeta> = {
  healthy: {
    label: "Healthy",
    hint: "New calls and chats can start.",
    tone: "emerald",
  },
  low: {
    label: "Low balance",
    hint: "At or below this account's low-balance level. Ask the customer to top up soon.",
    tone: "amber",
  },
  empty: {
    label: "Empty",
    hint: "At or below zero. New calls and chats are refused while balance enforcement is on.",
    tone: "rose",
  },
  blocked: {
    label: "Suspended",
    hint: "Suspended in AgentX. New calls and chats are refused regardless of balance.",
    tone: "rose",
  },
  unavailable: {
    label: "Unavailable",
    hint: "AgentX could not be reached for this account.",
    tone: "slate",
  },
};

export function accountHealth(account: Partial<BillingAccount>): AccountHealth {
  if (account.balance_error || account.balance_usd == null) return "unavailable";
  if (account.is_blocked) return "blocked";

  const balance = toScaled(account.balance_usd);
  if (balance === null) return "unavailable";
  if (!isPositive(account.balance_usd)) return "empty";

  const threshold = toScaled(account.low_balance_threshold_usd ?? "0");
  if (threshold !== null && isPositive(account.low_balance_threshold_usd) && balance <= threshold) {
    return "low";
  }
  return "healthy";
}

// ---------------------------------------------------------------------------
// Tones — one place for the semantic color tokens used across billing.
// ---------------------------------------------------------------------------

export type Tone = "emerald" | "amber" | "rose" | "sky" | "indigo" | "slate";

export const TONE: Record<Tone, { text: string; soft: string; dot: string; ring: string }> = {
  emerald: {
    text: "text-emerald-400",
    soft: "bg-emerald-500/10 border-emerald-500/20 text-emerald-300",
    dot: "bg-emerald-400",
    ring: "ring-emerald-500/30",
  },
  amber: {
    text: "text-amber-400",
    soft: "bg-amber-500/10 border-amber-500/25 text-amber-300",
    dot: "bg-amber-400",
    ring: "ring-amber-500/30",
  },
  rose: {
    text: "text-rose-400",
    soft: "bg-rose-500/10 border-rose-500/25 text-rose-300",
    dot: "bg-rose-400",
    ring: "ring-rose-500/30",
  },
  sky: {
    text: "text-sky-400",
    soft: "bg-sky-500/10 border-sky-500/20 text-sky-300",
    dot: "bg-sky-400",
    ring: "ring-sky-500/30",
  },
  indigo: {
    text: "text-indigo-400",
    soft: "bg-indigo-500/10 border-indigo-500/20 text-indigo-300",
    dot: "bg-indigo-400",
    ring: "ring-indigo-500/30",
  },
  slate: {
    text: "text-[#8888aa]",
    soft: "bg-[#1a1a26] border-[#2a2a3a] text-[#a0a0bc]",
    dot: "bg-[#66667f]",
    ring: "ring-[#2a2a3a]",
  },
};

// ---------------------------------------------------------------------------
// Ledger presentation
// ---------------------------------------------------------------------------

export function ledgerActivity(entry: LedgerEntry): { label: string; tone: Tone } {
  switch (entry.entry_type) {
    case "topup":
      return { label: "Top-up", tone: "emerald" };
    case "debit_call":
      return entry.idempotency_key.startsWith("kb:")
        ? { label: "Knowledge base", tone: "sky" }
        : { label: "Usage", tone: "rose" };
    case "refund":
      return { label: "Refund", tone: "sky" };
    case "adjustment":
      return { label: "Adjustment", tone: "amber" };
    case "initial_balance":
      return { label: "Opening balance", tone: "slate" };
    default:
      return { label: String(entry.entry_type).replace(/_/g, " "), tone: "slate" };
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const PAYMENT_STATUS_META: Record<Payment["status"], { label: string; tone: Tone }> = {
  confirmed: { label: "Credited", tone: "emerald" },
  pending: { label: "Pending", tone: "amber" },
  failed: { label: "Failed", tone: "rose" },
};

/** A pending payment older than this probably lost its response mid-flight. */
const STALE_PENDING_MS = 30000;

export function canRetryPayment(payment: Payment, now = Date.now()): boolean {
  if (payment.status === "failed") return true;
  if (payment.status !== "pending") return false;
  const created = Date.parse(payment.created_at);
  return Number.isFinite(created) && now - created > STALE_PENDING_MS;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** A unique id for one payment submission. Works outside secure contexts too. */
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function initials(label: string): string {
  // Emails make poor initials; use the part before "@".
  const source = label.includes("@") ? label.split("@")[0] : label;
  const words = source.split(/[\s._-]+/).filter((w) => /[A-Za-z0-9]/.test(w));
  if (words.length === 0) return "#";
  const firstChar = (w: string) => (w.match(/[A-Za-z0-9]/)?.[0] ?? "").toUpperCase();
  if (words.length === 1) return words[0].replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  return firstChar(words[0]) + firstChar(words[1]);
}

const absoluteFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

export function formatAbsolute(iso: string | undefined | null): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  return Number.isFinite(time) ? absoluteFormat.format(time) : "";
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatRelative(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";

  const seconds = Math.round((time - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relativeFormat.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 7) return relativeFormat.format(Math.round(seconds / 86400), "day");
  return formatAbsolute(iso);
}

const STORAGE_OPERATOR = "billing.operatorName";

export function loadOperatorName(): string {
  try {
    return window.localStorage.getItem(STORAGE_OPERATOR) ?? "";
  } catch {
    return "";
  }
}

export function saveOperatorName(name: string): void {
  try {
    window.localStorage.setItem(STORAGE_OPERATOR, name.trim());
  } catch {
    // Storage unavailable (private mode): the field just won't be remembered.
  }
}

/** Default INR→USD rate, inlined at build time from the dashboard env. */
export const DEFAULT_USD_INR_RATE = (() => {
  const configured = (process.env.NEXT_PUBLIC_DEFAULT_USD_INR_RATE ?? "").trim();
  return /^\d+(\.\d{1,6})?$/.test(configured) && isPositive(configured) ? configured : "0.0112";
})();
