/**
 * Display helpers for the Model Pricing admin tab.
 *
 * Rate values arrive as exact decimal strings. Chat/embedding rates are
 * per-1M-tokens (USD); manual STT/TTS rates are per-character or per-second.
 */

import type { PricingKind, PricingUnit } from "@/lib/api";
import type { Tone } from "@/lib/billing";

export const KIND_LABEL: Record<PricingKind, string> = {
  chat: "Chat",
  embedding: "Embedding",
  tts: "Voice (TTS)",
  stt: "Transcriber (STT)",
  speech_to_speech: "Speech to Speech",
};

export const KIND_TONE: Record<PricingKind, Tone> = {
  chat: "indigo",
  embedding: "sky",
  tts: "emerald",
  stt: "amber",
  speech_to_speech: "rose",
};

export const UNIT_LABEL: Record<PricingUnit, string> = {
  per_1m_token: "per 1M tokens",
  per_1m_char: "per 1M chars",
  per_hour: "per hour",
  // Legacy units (pre-spec rows).
  per_character: "per character",
  per_second: "per second",
};

/** Format a per-1M-token USD rate: "$2.50". Returns "—" for null. */
export function formatPer1m(value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  // Rates are small, fixed USD values from the catalog; 2–4 dp reads cleanly.
  const places = num !== 0 && Math.abs(num) < 0.01 ? 4 : 2;
  return `$${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.max(2, places),
  })}`;
}

const UNIT_SUFFIX: Record<PricingUnit, string> = {
  per_1m_char: "/ 1M chars",
  per_hour: "/ hr",
  per_character: "/ char",
  per_second: "/ sec",
  per_1m_token: "/ 1M",
};

/**
 * Format a manual STT/TTS rate: "$50.00 / 1M chars", "$0.18 / hr".
 * Spec units are coarse (per-1M-chars, per-hour), so 2–4 dp reads cleanly.
 */
export function formatUnitRate(
  value: string | null | undefined,
  unit: PricingUnit,
): string {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  const trimmed = num
    .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  const suffix = UNIT_SUFFIX[unit] ?? "";
  return `$${trimmed}${suffix ? ` ${suffix}` : ""}`;
}
