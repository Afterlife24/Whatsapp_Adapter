"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Trash2,
} from "lucide-react";
import {
  apiErrorMessage,
  deletePricingModel,
  getPricingModels,
  getPricingPending,
  setModelEnabled,
  setProviderEnabled,
  syncPricing,
  type PricingKind,
  type PricingModel,
  type PricingPendingItem,
  type PricingProviderSetting,
} from "@/lib/api";
import {
  KIND_LABEL,
  KIND_TONE,
  UNIT_LABEL,
  formatPer1m,
  formatUnitRate,
} from "@/lib/pricing";
import { cn } from "@/lib/utils";
import {
  Badge,
  Notice,
  Skeleton,
  Spinner,
  buttonCls,
  cardCls,
  focusRing,
  inputCls,
} from "@/components/billing/ui";
import AddManualModelDialog from "@/components/pricing/AddManualModelDialog";
import PendingPanel from "@/components/pricing/PendingPanel";

type KindFilter = "all" | PricingKind;

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "chat", label: "Chat" },
  { value: "embedding", label: "Embedding" },
  { value: "tts", label: "Voice" },
  { value: "stt", label: "Transcriber" },
  { value: "speech_to_speech", label: "Speech to Speech" },
];

export default function PricingPage() {
  const [models, setModels] = useState<PricingModel[] | null>(null);
  const [providers, setProviders] = useState<PricingProviderSetting[]>([]);
  const [pending, setPending] = useState<PricingPendingItem[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [busyModelId, setBusyModelId] = useState<number | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  // Progressive disclosure: show 10 rows at a time to avoid a long scroll.
  const PAGE_SIZE = 10;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    let current = true;
    Promise.all([getPricingModels(), getPricingPending()])
      .then(([m, p]) => {
        if (!current) return;
        setModels(m.models);
        setProviders(m.providers);
        setPending(p);
        setError("");
      })
      .catch((e) => current && setError(apiErrorMessage(e)))
      .finally(() => current && setRefreshing(false));
    return () => {
      current = false;
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
  }, []);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setError("");
    setNotice("");
    try {
      const result = await syncPricing();
      const autoNote =
        result.auto_approved > 0
          ? ` ${result.auto_approved} in-use model(s) were auto-approved and enabled.`
          : "";
      const missingNote =
        result.missing > 0
          ? ` ${result.missing} stored model(s) are now MISSING from the catalog.`
          : "";
      setNotice(
        result.total === 0
          ? `Catalog is up to date — no new changes to review.${autoNote}${missingNote}`
          : `Sync found ${result.total} change(s): ${result.new} new, ${result.price_change} price change(s). Review below.${autoNote}${missingNote}`,
      );
      reload();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSyncing(false);
    }
  }, [reload]);

  const providerEnabled = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const p of providers) map.set(p.provider, p.is_enabled);
    return map;
  }, [providers]);

  // Filtered, sorted flat list of models (provider then model id).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models ?? [])
      .filter((m) => {
        if (kindFilter !== "all" && m.kind !== kindFilter) return false;
        if (!q) return true;
        return (
          m.model_identifier.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q)
        );
      })
      .sort(
        (a, b) =>
          a.provider.localeCompare(b.provider) ||
          a.model_identifier.localeCompare(b.model_identifier),
      );
  }, [models, query, kindFilter]);

  // Flat cap of visibleCount rows, then re-group the visible slice by provider.
  const grouped = useMemo(() => {
    const visible = filtered.slice(0, visibleCount);
    const byProvider = new Map<string, PricingModel[]>();
    for (const m of visible) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()].map(([provider, list]) => ({ provider, models: list }));
  }, [filtered, visibleCount]);

  const stats = useMemo(() => {
    const list = models ?? [];
    return {
      total: list.length,
      enabled: list.filter((m) => m.is_enabled).length,
      pending: pending.length,
      providers: new Set(list.map((m) => m.provider)).size,
    };
  }, [models, pending]);

  const toggleModel = async (m: PricingModel) => {
    setBusyModelId(m.id);
    setError("");
    try {
      await setModelEnabled(m.id, !m.is_enabled);
      setModels((prev) =>
        (prev ?? []).map((x) => (x.id === m.id ? { ...x, is_enabled: !m.is_enabled } : x)),
      );
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyModelId(null);
    }
  };

  const toggleProvider = async (provider: string, next: boolean) => {
    setBusyProvider(provider);
    setError("");
    try {
      await setProviderEnabled(provider, next);
      setProviders((prev) => {
        const exists = prev.some((p) => p.provider === provider);
        return exists
          ? prev.map((p) => (p.provider === provider ? { ...p, is_enabled: next } : p))
          : [...prev, { provider, is_enabled: next }];
      });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyProvider(null);
    }
  };

  const removeModel = async (m: PricingModel) => {
    if (!window.confirm(`Delete ${m.provider} / ${m.model_identifier}? This cannot be undone.`)) {
      return;
    }
    setBusyModelId(m.id);
    setError("");
    try {
      await deletePricingModel(m.id);
      setModels((prev) => (prev ?? []).filter((x) => x.id !== m.id));
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyModelId(null);
    }
  };

  const loading = models === null && !error;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Model Pricing</h1>
          <p className="mt-1 max-w-2xl text-sm text-[#666880]">
            Per-model rates used to bill AgentX usage. Chat &amp; embedding prices sync from the
            LiteLLM catalog (admin-approved); voice &amp; transcription are added manually. Only
            enabled models appear in AgentX.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reload}
            disabled={refreshing}
            className={buttonCls("secondary")}
            aria-label="Reload"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            <span className="hidden sm:inline">Reload</span>
          </button>
          <button type="button" onClick={runSync} disabled={syncing} className={buttonCls("secondary")}>
            {syncing ? <Spinner size={14} /> : <RefreshCw size={14} />}
            Refresh pricing
          </button>
          <button type="button" onClick={() => setAddOpen(true)} className={buttonCls("primary")}>
            <Plus size={16} /> Add STT/TTS
          </button>
        </div>
      </div>

      {error && (
        <Notice tone="rose" icon={<CircleAlert size={16} />} role="alert">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="sky" role="status">
          {notice}
        </Notice>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Models" loading={loading} value={String(stats.total)} />
        <StatCard label="Enabled" loading={loading} value={String(stats.enabled)} hint="Shown in AgentX" />
        <StatCard
          label="Pending changes"
          loading={loading}
          value={String(stats.pending)}
          tone={stats.pending > 0 ? "amber" : undefined}
          hint="Awaiting approval"
        />
        <StatCard label="Providers" loading={loading} value={String(stats.providers)} />
      </div>

      {/* Pending diff */}
      {!loading && <PendingPanel pending={pending} onResolved={reload} />}

      {/* Models table */}
      <section className={cardCls} aria-labelledby="models-heading">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1e1e2e] px-5 py-4">
          <h2 id="models-heading" className="font-semibold text-white">
            Models
            {models && models.length > 0 && (
              <span className="ml-2 text-xs font-normal text-[#66667f]">{models.length}</span>
            )}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-[#2a2a3a] p-0.5">
              {KIND_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => {
                    setKindFilter(f.value);
                    setVisibleCount(PAGE_SIZE);
                  }}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    kindFilter === f.value ? "bg-indigo-600 text-white" : "text-[#8888aa] hover:text-white",
                    focusRing,
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-64">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#44445a]" />
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setVisibleCount(PAGE_SIZE);
                }}
                placeholder="Search model or provider"
                aria-label="Search models"
                className={cn(inputCls, "py-1.5 pl-9")}
              />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="space-y-3 p-5" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : models && models.length === 0 ? (
          <EmptyState onSync={runSync} syncing={syncing} />
        ) : grouped.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-[#66667f]">No models match the current filter.</p>
        ) : (
          <div className="divide-y divide-[#16161f]">
            {grouped.map(({ provider, models: rows }) => {
              const pEnabled = providerEnabled.get(provider) ?? true;
              return (
                <div key={provider}>
                  {/* Provider group header */}
                  <div className="flex items-center justify-between gap-3 bg-[#0b0b12] px-5 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold uppercase tracking-wide text-[#c4c4d8]">
                        {provider}
                      </span>
                      <span className="text-xs text-[#55556b]">{rows.length}</span>
                      {!pEnabled && <Badge tone="rose">Provider disabled</Badge>}
                    </div>
                    <ToggleSwitch
                      checked={pEnabled}
                      busy={busyProvider === provider}
                      onChange={(next) => toggleProvider(provider, next)}
                      label={`Toggle provider ${provider}`}
                    />
                  </div>

                  {/* Model rows */}
                  <table className="w-full">
                    <tbody>
                      {rows.map((m) => (
                        <tr key={m.id} className="border-t border-[#13131c] hover:bg-[#11111a]">
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm text-white">{m.model_identifier}</span>
                              <Badge tone={KIND_TONE[m.kind]}>{KIND_LABEL[m.kind]}</Badge>
                              {/* Catalog presence status (litellm models only).
                                  Active = still in catalog; Missing = provider
                                  dropped it. Manual STT/TTS aren't in the catalog
                                  so they show no presence badge. */}
                              {m.source === "litellm" && m.status === "active" && (
                                <Badge tone="emerald">Active</Badge>
                              )}
                              {m.status === "missing" && <Badge tone="rose">Missing</Badge>}
                              {m.status === "deprecated" && <Badge tone="amber">Deprecated</Badge>}
                              {m.source === "manual" && (
                                <span className="text-[10px] uppercase text-[#55556b]">manual</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <RatesCell model={m} />
                          </td>
                          <td className="px-3 py-3 text-center">
                            <ToggleSwitch
                              checked={m.is_enabled}
                              busy={busyModelId === m.id}
                              onChange={() => toggleModel(m)}
                              label={`Toggle ${m.model_identifier}`}
                            />
                          </td>
                          <td className="px-5 py-3 text-right">
                            {/* Delete permanently removes the model from the DB
                                (vs. the toggle, which only hides it from AgentX).
                                Available on every row. If a deleted litellm model
                                is still in the catalog, the next sync re-queues it
                                under Pending changes. */}
                            <button
                              type="button"
                              onClick={() => removeModel(m)}
                              disabled={busyModelId === m.id}
                              aria-label={`Delete ${m.model_identifier}`}
                              title="Delete permanently"
                              className={cn("rounded p-1.5 text-[#55556b] hover:bg-rose-500/10 hover:text-rose-300", focusRing)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}

            {/* Show more / count footer */}
            <div className="flex items-center justify-between gap-3 px-5 py-3">
              <span className="text-xs text-[#55556b]">
                Showing {Math.min(visibleCount, filtered.length)} of {filtered.length}
              </span>
              {visibleCount < filtered.length && (
                <button
                  type="button"
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  className={buttonCls("secondary", "sm")}
                >
                  Show more
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {addOpen && (
        <AddManualModelDialog
          existingModels={models ?? []}
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function RatesCell({ model: m }: { model: PricingModel }) {
  if (m.kind === "chat") {
    return (
      <span className="text-xs tabular-nums text-[#c4c4d8]">
        in {formatPer1m(m.input_per_1m)} · out {formatPer1m(m.output_per_1m)}
        <span className="ml-1 text-[#55556b]">/ 1M</span>
      </span>
    );
  }
  if (m.kind === "embedding") {
    return (
      <span className="text-xs tabular-nums text-[#c4c4d8]">
        {formatPer1m(m.embedding_per_1m)} <span className="text-[#55556b]">/ 1M</span>
      </span>
    );
  }
  if (m.kind === "speech_to_speech") {
    // Four per-1M-token rates: text/audio × in/out.
    return (
      <span className="text-xs tabular-nums leading-relaxed text-[#c4c4d8]">
        <span className="text-[#55556b]">text</span> in {formatPer1m(m.rt_text_input_per_1m)} · out{" "}
        {formatPer1m(m.rt_text_output_per_1m)}
        <br />
        <span className="text-[#55556b]">audio</span> in {formatPer1m(m.rt_audio_input_per_1m)} · out{" "}
        {formatPer1m(m.rt_audio_output_per_1m)}
        <span className="ml-1 text-[#55556b]">/ 1M</span>
      </span>
    );
  }
  // tts / stt (manual)
  return (
    <span className="text-xs tabular-nums text-[#c4c4d8]" title={UNIT_LABEL[m.unit]}>
      {formatUnitRate(m.rate, m.unit)}
    </span>
  );
}

function ToggleSwitch({
  checked,
  busy,
  onChange,
  label,
}: {
  checked: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-indigo-600" : "bg-[#2a2a3a]",
        focusRing,
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-1",
        )}
      />
    </button>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "amber";
  loading: boolean;
}) {
  return (
    <div className={cn(cardCls, "p-4")}>
      <p className="text-xs text-[#66667f]">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "amber" ? "text-amber-400" : "text-white")}>
          {value}
        </p>
      )}
      {hint && <p className="mt-0.5 text-[11px] text-[#44445a]">{hint}</p>}
    </div>
  );
}

function EmptyState({ onSync, syncing }: { onSync: () => void; syncing: boolean }) {
  return (
    <div className="px-6 py-14 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-indigo-500/20 bg-indigo-500/10">
        <Tag size={24} className="text-indigo-300" />
      </div>
      <p className="mt-4 font-medium text-white">No models yet</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-[#66667f]">
        Run a catalog sync to fetch chat &amp; embedding models, then approve them. Add voice and
        transcription models manually.
      </p>
      <button type="button" onClick={onSync} disabled={syncing} className={cn(buttonCls("primary"), "mt-6")}>
        {syncing ? <Spinner size={14} /> : <RefreshCw size={14} />}
        Refresh pricing
      </button>
    </div>
  );
}
