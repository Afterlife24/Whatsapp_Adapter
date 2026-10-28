"use client";

import { useMemo, useState } from "react";
import { Check, GitPullRequestArrow, Search, Sparkles, TriangleAlert, X } from "lucide-react";
import {
  apiErrorMessage,
  approvePending,
  rejectPending,
  type PricingPendingItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatPer1m, KIND_LABEL } from "@/lib/pricing";
import { Badge, Notice, Spinner, buttonCls, cardCls, inputCls } from "@/components/billing/ui";

interface Props {
  pending: PricingPendingItem[];
  /** Called after an item is approved/rejected so the parent can refresh. */
  onResolved: () => void;
}

const CHANGE_META: Record<
  PricingPendingItem["change_type"],
  { label: string; tone: "emerald" | "amber" | "rose"; icon: typeof Sparkles }
> = {
  new: { label: "New", tone: "emerald", icon: Sparkles },
  price_change: { label: "Price change", tone: "amber", icon: GitPullRequestArrow },
  deprecated: { label: "Deprecated", tone: "rose", icon: TriangleAlert },
};

const PAGE_SIZE = 10;

export default function PendingPanel({ pending, onResolved }: Props) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");
  // Show 10 at a time — a fresh sync can produce 100+ pending rows.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Provider dropdown + search so the admin isn't scrolling 168 rows.
  const [providerFilter, setProviderFilter] = useState("all");
  const [query, setQuery] = useState("");

  const providers = useMemo(
    () => [...new Set(pending.map((p) => p.provider))].sort(),
    [pending],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pending.filter((p) => {
      if (providerFilter !== "all" && p.provider !== providerFilter) return false;
      if (q && !p.model_identifier.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [pending, providerFilter, query]);

  const act = async (id: number, action: "approve" | "reject") => {
    setBusyId(id);
    setError("");
    try {
      if (action === "approve") await approvePending(id);
      else await rejectPending(id);
      onResolved();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  if (pending.length === 0) return null;

  return (
    <section className={cn(cardCls, "border-amber-500/20")} aria-labelledby="pending-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1e1e2e] px-5 py-4">
        <div>
          <h2 id="pending-heading" className="flex items-center gap-2 font-semibold text-white">
            <GitPullRequestArrow size={16} className="text-amber-400" />
            Pending changes
            <span className="ml-1 text-xs font-normal text-[#66667f]">{pending.length}</span>
          </h2>
          <p className="mt-0.5 text-xs text-[#66667f]">
            From the last catalog sync. Nothing affects billing until you approve it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={providerFilter}
            onChange={(e) => {
              setProviderFilter(e.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
            aria-label="Filter by provider"
            className={cn(inputCls, "w-auto py-1.5")}
          >
            <option value="all">All providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <div className="relative w-full sm:w-56">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#44445a]" />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              placeholder="Search model"
              aria-label="Search pending models"
              className={cn(inputCls, "py-1.5 pl-9")}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="px-5 pt-4">
          <Notice tone="rose">{error}</Notice>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-[#66667f]">
          No pending changes match the current filter.
        </p>
      ) : (
      <ul className="divide-y divide-[#16161f]">
        {filtered.slice(0, visibleCount).map((item) => {
          const meta = CHANGE_META[item.change_type];
          const Icon = meta.icon;
          const busy = busyId === item.id;
          return (
            <li key={item.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <Badge tone={meta.tone}>
                <Icon size={11} /> {meta.label}
              </Badge>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">
                  <span className="font-mono">{item.model_identifier}</span>
                  <span className="ml-2 text-xs text-[#66667f]">
                    {item.provider} · {KIND_LABEL[item.kind]}
                  </span>
                </p>
                {item.change_type === "price_change" ? (
                  item.kind === "speech_to_speech" ? (
                    <p className="mt-0.5 text-xs text-[#8888aa]">
                      audio in {formatPer1m(item.current_rt_audio_input_per_1m)} →{" "}
                      {formatPer1m(item.proposed_rt_audio_input_per_1m)}
                      <span className="mx-1 text-[#44445a]">·</span>
                      out {formatPer1m(item.current_rt_audio_output_per_1m)} →{" "}
                      {formatPer1m(item.proposed_rt_audio_output_per_1m)}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-[#8888aa]">
                      in {formatPer1m(item.current_input_per_1m)} → {formatPer1m(item.proposed_input_per_1m)}
                      <span className="mx-1 text-[#44445a]">·</span>
                      out {formatPer1m(item.current_output_per_1m)} → {formatPer1m(item.proposed_output_per_1m)}
                    </p>
                  )
                ) : item.change_type === "new" ? (
                  <p className="mt-0.5 text-xs text-[#8888aa]">
                    {item.kind === "embedding"
                      ? `embed ${formatPer1m(item.proposed_embedding_per_1m)}`
                      : item.kind === "speech_to_speech"
                        ? `text in ${formatPer1m(item.proposed_rt_text_input_per_1m)} · out ${formatPer1m(item.proposed_rt_text_output_per_1m)} · audio in ${formatPer1m(item.proposed_rt_audio_input_per_1m)} · out ${formatPer1m(item.proposed_rt_audio_output_per_1m)}`
                        : `in ${formatPer1m(item.proposed_input_per_1m)} · out ${formatPer1m(item.proposed_output_per_1m)}`}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-rose-300/80">No longer in the catalog — will be marked deprecated.</p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => act(item.id, "reject")}
                  disabled={busy}
                  className={buttonCls("secondary", "sm")}
                >
                  <X size={13} /> Reject
                </button>
                <button
                  type="button"
                  onClick={() => act(item.id, "approve")}
                  disabled={busy}
                  className={buttonCls("primary", "sm")}
                >
                  {busy ? <Spinner size={12} /> : <Check size={13} />} Approve
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      )}

      {filtered.length > 0 && (
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
      )}
    </section>
  );
}
