"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CircleAlert, Mic, Pencil, Plus, Volume2, X } from "lucide-react";
import { addManualModel, apiErrorMessage, type PricingModel } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Notice,
  Spinner,
  buttonCls,
  focusRing,
  inputCls,
  labelCls,
} from "@/components/billing/ui";

interface Props {
  /** Current STT/TTS pricing rows — source for the "Existing model" dropdowns. */
  existingModels?: PricingModel[];
  onClose: () => void;
  onCreated: (model: PricingModel) => void;
}

type Kind = "tts" | "stt";
/** Which flow the admin is in: edit a priced model, or add a brand-new one. */
type Mode = "existing" | "new";

/**
 * Input unit the operator types in. Every provider quotes STT/TTS differently
 * (per 1k chars, per character, per minute, …) so we let them pick a familiar
 * unit and convert to the stored canonical unit on save:
 *   - TTS → stored as USD per 1,000,000 characters (per_1m_char)
 *   - STT → stored as USD per hour (per_hour)
 */
type TtsInputUnit = "per_1m_char" | "per_1k_char" | "per_character";
type SttInputUnit = "per_hour" | "per_minute" | "per_second";
type InputUnit = TtsInputUnit | SttInputUnit;

interface UnitOption {
  value: InputUnit;
  label: string;
  placeholder: string;
  /** Multiply the typed rate by this to reach the stored canonical unit. */
  toCanonical: number;
}

const TTS_UNITS: UnitOption[] = [
  { value: "per_1m_char", label: "per 1M characters", placeholder: "50", toCanonical: 1 },
  { value: "per_1k_char", label: "per 1,000 characters", placeholder: "0.05", toCanonical: 1_000 },
  { value: "per_character", label: "per character", placeholder: "0.00005", toCanonical: 1_000_000 },
];

const STT_UNITS: UnitOption[] = [
  { value: "per_hour", label: "per hour", placeholder: "0.36", toCanonical: 1 },
  { value: "per_minute", label: "per minute", placeholder: "0.006", toCanonical: 60 },
  { value: "per_second", label: "per second", placeholder: "0.0001", toCanonical: 3_600 },
];

// Canonical stored bounds (mirror the server guard in pricing_service.add_manual_model).
const TTS_BOUNDS = { min: 1, max: 500, unit: "USD per 1M chars" };
const STT_BOUNDS = { min: 0.01, max: 20, unit: "USD per hour" };

/** Format a USD amount with up to 6 dp, trailing zeros trimmed. */
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return (
    "$" +
    n
      .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "")
  );
}

/**
 * Add or re-price a manual STT/TTS model. Two flows share this dialog:
 *   - "Existing model": pick a provider + model already in the pricing table
 *     from dropdowns and change its rate. Only the rate is versioned; the
 *     model's enabled/disabled state is left untouched.
 *   - "New model": type a provider + model id that isn't in the table yet.
 * Both store TTS as USD/1M chars and STT as USD/hour, and both go through the
 * same versioned write, so future runs bill at the new rate automatically.
 */
export default function AddManualModelDialog({
  existingModels = [],
  onClose,
  onCreated,
}: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  // Only manual STT/TTS rows are editable here (chat/embedding come from the catalog).
  const speechModels = useMemo(
    () => existingModels.filter((m) => m.kind === "tts" || m.kind === "stt"),
    [existingModels],
  );
  const hasExisting = speechModels.length > 0;

  // Default to the "existing" flow when there are priced rows to edit.
  const [mode, setMode] = useState<Mode>(hasExisting ? "existing" : "new");
  const [kind, setKind] = useState<Kind>("tts");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [rate, setRate] = useState("");
  const [inputUnit, setInputUnit] = useState<InputUnit>("per_1m_char");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      restoreFocus.current?.focus?.();
    };
  }, [onClose]);

  const unitOptions = kind === "tts" ? TTS_UNITS : STT_UNITS;
  const bounds = kind === "tts" ? TTS_BOUNDS : STT_BOUNDS;

  // Providers present for the selected kind (distinct, sorted).
  const providersForKind = useMemo(() => {
    const set = new Set(
      speechModels.filter((m) => m.kind === kind).map((m) => m.provider),
    );
    return [...set].sort();
  }, [speechModels, kind]);

  // Models for the selected provider + kind (sorted).
  const modelsForProvider = useMemo(
    () =>
      speechModels
        .filter((m) => m.kind === kind && m.provider === provider)
        .sort((a, b) => a.model_identifier.localeCompare(b.model_identifier)),
    [speechModels, kind, provider],
  );

  // Prefill the rate from a selected existing model's stored value. Stored unit
  // is the canonical one (per_1m_char for TTS, per_hour for STT), so set the
  // unit dropdown to that and show the stored number directly.
  const applyExistingModel = (modelId: string) => {
    setModel(modelId);
    const row = speechModels.find(
      (m) => m.kind === kind && m.provider === provider && m.model_identifier === modelId,
    );
    if (row?.rate != null && row.rate !== "") {
      setInputUnit(kind === "tts" ? "per_1m_char" : "per_hour");
      // Trim trailing zeros for a clean editable value.
      setRate(String(Number(row.rate)));
    } else {
      setRate("");
    }
    setError("");
  };

  // Switching kind resets provider/model/rate and the unit default.
  const selectKind = (next: Kind) => {
    if (next === kind) return;
    setKind(next);
    setInputUnit(next === "tts" ? "per_1m_char" : "per_hour");
    setProvider("");
    setModel("");
    setRate("");
    setError("");
  };

  const selectMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setProvider("");
    setModel("");
    setRate("");
    setError("");
  };

  const selectExistingProvider = (p: string) => {
    setProvider(p);
    setModel("");
    setRate("");
    setError("");
  };

  const selectedOption = unitOptions.find((o) => o.value === inputUnit) ?? unitOptions[0];

  // Live conversion to the canonical stored unit.
  const canonical = useMemo(() => {
    const n = Number(rate.trim());
    if (!rate.trim() || !Number.isFinite(n) || n <= 0) return null;
    return n * selectedOption.toCanonical;
  }, [rate, selectedOption]);

  const preview =
    canonical == null
      ? null
      : `Will be stored as ${fmtUsd(canonical)} ${bounds.unit}`;

  const outOfBounds =
    canonical != null && (canonical < bounds.min || canonical > bounds.max);

  const validate = (): string | null => {
    if (!provider.trim()) {
      return mode === "existing" ? "Pick a provider." : "Enter the provider (e.g. cartesia).";
    }
    if (!model.trim()) {
      return mode === "existing" ? "Pick a model." : "Enter the model identifier.";
    }
    const text = rate.trim();
    if (!text) return "Enter the rate.";
    if (!/^\d+(\.\d+)?$/.test(text)) return "Rate must be a positive decimal.";
    if (Number(text) <= 0) return "Rate must be greater than zero.";
    if (canonical == null) return "Enter a valid rate.";
    if (canonical < bounds.min || canonical > bounds.max) {
      return (
        `That converts to ${fmtUsd(canonical)} ${bounds.unit}, outside the ` +
        `allowed ${bounds.min}–${bounds.max}. Check the unit.`
      );
    }
    return null;
  };

  const submit = async () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError("");
    try {
      // Backend derives unit from kind and expects the canonical stored rate:
      // TTS USD/1M chars, STT USD/hour. Send 6 dp to match the column scale.
      // Re-pricing an existing provider+model versions a new rate row; the
      // model's enabled/disabled state is NOT changed here.
      const storedRate = (canonical as number).toFixed(6);
      const result = await addManualModel({
        provider: provider.trim().toLowerCase(),
        model_identifier: model.trim(),
        kind,
        rate: storedRate,
        // "New model" adds are enabled by default; "change rate" omits the flag
        // so the backend preserves the model's current enabled/disabled state.
        ...(isExisting ? {} : { is_enabled: true }),
      });
      onCreated(result);
    } catch (e) {
      setError(apiErrorMessage(e));
      setSaving(false);
    }
  };

  const isExisting = mode === "existing";
  const saveLabel = isExisting ? "Save rate" : "Add model";
  const savingLabel = isExisting ? "Saving…" : "Adding…";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-[#1e1e2e] bg-[#0d0d14] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[#1e1e2e] px-5 py-4">
          <h2 id={titleId} className="font-semibold text-white">
            {isExisting ? "Change model rate" : "Add STT / TTS model"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cn("rounded p-1 text-[#66667f] hover:bg-[#1a1a26] hover:text-white", focusRing)}
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {/* Mode toggle: edit an existing priced model, or add a new one. */}
          {hasExisting && (
            <div>
              <span className={labelCls}>Action</span>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: "existing" as const, label: "Change rate", icon: Pencil },
                  { value: "new" as const, label: "Add new", icon: Plus },
                ]).map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => selectMode(value)}
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                      mode === value
                        ? "border-indigo-500 bg-indigo-500/10 text-white"
                        : "border-[#2a2a3a] text-[#8888aa] hover:bg-[#1a1a26]",
                      focusRing
                    )}
                  >
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-[#66667f]">
            {isExisting
              ? "Pick a priced voice or transcription model and set a new rate. Only the rate changes — the model's enabled state is left as-is, and new calls bill at the updated rate."
              : "Voice and transcription prices aren't in the catalog, so add them here. Enabled models become selectable in AgentX."}
          </p>

          {/* Kind toggle */}
          <div>
            <span className={labelCls}>Type</span>
            <div className="grid grid-cols-2 gap-2">
              {([
                { value: "tts" as const, label: "Voice (TTS)", icon: Volume2 },
                { value: "stt" as const, label: "Transcriber (STT)", icon: Mic },
              ]).map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => selectKind(value)}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                    kind === value
                      ? "border-indigo-500 bg-indigo-500/10 text-white"
                      : "border-[#2a2a3a] text-[#8888aa] hover:bg-[#1a1a26]",
                    focusRing
                  )}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
          </div>

          {/* Provider + Model: dropdowns in "existing" mode, text in "new" mode. */}
          {isExisting ? (
            <>
              <div>
                <label className={labelCls} htmlFor={`${titleId}-provider-sel`}>Provider</label>
                <select
                  id={`${titleId}-provider-sel`}
                  className={cn(inputCls, "cursor-pointer")}
                  value={provider}
                  onChange={(e) => selectExistingProvider(e.target.value)}
                >
                  <option value="" disabled>
                    {providersForKind.length ? "Select a provider" : "No priced providers"}
                  </option>
                  {providersForKind.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className={labelCls} htmlFor={`${titleId}-model-sel`}>Model</label>
                <select
                  id={`${titleId}-model-sel`}
                  className={cn(inputCls, "cursor-pointer")}
                  value={model}
                  onChange={(e) => applyExistingModel(e.target.value)}
                  disabled={!provider}
                >
                  <option value="" disabled>
                    {provider ? "Select a model" : "Pick a provider first"}
                  </option>
                  {modelsForProvider.map((m) => (
                    <option key={m.id} value={m.model_identifier}>
                      {m.model_identifier}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className={labelCls} htmlFor={`${titleId}-provider`}>Provider</label>
                <input
                  id={`${titleId}-provider`}
                  className={inputCls}
                  placeholder="cartesia"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  autoFocus
                />
              </div>

              <div>
                <label className={labelCls} htmlFor={`${titleId}-model`}>Model identifier</label>
                <input
                  id={`${titleId}-model`}
                  className={inputCls}
                  placeholder={kind === "tts" ? "sonic-2" : "ink-whisper"}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>
            </>
          )}

          {/* Rate + unit */}
          <div>
            <label className={labelCls} htmlFor={`${titleId}-rate`}>
              Rate (USD)
            </label>
            <div className="flex gap-2">
              <input
                id={`${titleId}-rate`}
                className={cn(inputCls, "flex-1")}
                inputMode="decimal"
                placeholder={selectedOption.placeholder}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
              <select
                aria-label="Rate unit"
                className={cn(inputCls, "w-[11.5rem] shrink-0 cursor-pointer")}
                value={inputUnit}
                onChange={(e) => setInputUnit(e.target.value as InputUnit)}
              >
                {unitOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <p
              className={cn(
                "mt-1.5 text-[11px]",
                preview == null
                  ? "text-[#55556b]"
                  : outOfBounds
                    ? "text-rose-400"
                    : "text-emerald-400"
              )}
            >
              {preview ??
                `Enter the vendor's rate, then pick its unit. Allowed range: ${bounds.min}–${bounds.max} ${bounds.unit}.`}
            </p>
          </div>

          {error && (
            <Notice tone="rose" icon={<CircleAlert size={16} />} role="alert">
              {error}
            </Notice>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[#1e1e2e] px-5 py-4">
          <button type="button" onClick={onClose} className={buttonCls("secondary")}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || outOfBounds}
            className={buttonCls("primary")}
          >
            {saving ? <Spinner /> : null}
            {saving ? savingLabel : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
