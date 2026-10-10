"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  CircleAlert,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { apiErrorMessage, getBillingAccounts, type BillingAccount } from "@/lib/api";
import { formatMoney, formatUsdPrecise, scaledToString, sumDecimals } from "@/lib/money";
import {
  HEALTH_META,
  HEALTH_ORDER,
  TONE,
  accountHealth,
  initials,
  type AccountHealth,
} from "@/lib/billing";
import { cn } from "@/lib/utils";
import AddAccountDialog from "@/components/billing/AddAccountDialog";
import {
  HealthBadge,
  Notice,
  Skeleton,
  buttonCls,
  cardCls,
  focusRing,
  inputCls,
} from "@/components/billing/ui";

const ROW_ACCENT: Record<AccountHealth, string> = {
  healthy: "before:bg-transparent",
  low: "before:bg-amber-400/80",
  empty: "before:bg-rose-500/80",
  blocked: "before:bg-rose-500/80",
  unavailable: "before:bg-[#3a3a4c]",
};

export default function BillingPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<BillingAccount[] | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    // Ignore a response that arrives after a newer refresh was started.
    let current = true;
    getBillingAccounts()
      .then((list) => {
        if (!current) return;
        setAccounts(list);
        setError("");
      })
      .catch((e) => current && setError(apiErrorMessage(e)))
      .finally(() => current && setRefreshing(false));
    return () => {
      current = false;
    };
  }, [reloadKey]);

  const load = useCallback(() => {
    setRefreshing(true);
    setReloadKey((key) => key + 1);
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (accounts ?? [])
      .map((account) => ({ account, health: accountHealth(account) }))
      .filter(({ account }) => {
        if (!q) return true;
        return [
          account.label,
          account.email ?? "",
          `#${account.organization_id}`,
          String(account.organization_id),
          ...(account.agent_numbers ?? []),
        ].some((field) => field.toLowerCase().includes(q));
      })
      .sort(
        (a, b) =>
          HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health) ||
          a.account.label.localeCompare(b.account.label)
      );
  }, [accounts, query]);

  const stats = useMemo(() => {
    const list = accounts ?? [];
    const health = list.map(accountHealth);
    const reachable = list.filter((_, i) => health[i] !== "unavailable");
    return {
      total: list.length,
      totalUsd: scaledToString(sumDecimals(reachable.map((a) => a.balance_usd))),
      attention: health.filter((h) => h === "empty" || h === "low" || h === "blocked").length,
      unavailable: health.filter((h) => h === "unavailable").length,
    };
  }, [accounts]);

  const loading = accounts === null && !error;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Billing</h1>
          <p className="mt-1 max-w-xl text-sm text-[#666880]">
            Prepaid wallets for AgentX organizations. Balances are read live from AgentX every time this page
            loads.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            disabled={refreshing}
            className={buttonCls("secondary")}
            aria-label="Refresh balances"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <button type="button" onClick={() => setDialogOpen(true)} className={buttonCls("primary")}>
            <Plus size={16} /> Add account
          </button>
        </div>
      </div>

      {error && (
        <Notice
          tone="rose"
          icon={<CircleAlert size={16} />}
          title="Couldn't load billing accounts"
          role="alert"
          action={
            <button type="button" onClick={load} className={buttonCls("secondary", "sm")}>
              Try again
            </button>
          }
        >
          {error}
        </Notice>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Accounts" loading={loading} value={String(stats.total)} />
        <StatCard
          label="Total balance"
          loading={loading}
          value={formatMoney(stats.totalUsd, "USD")}
          hint={stats.unavailable > 0 ? `Excludes ${stats.unavailable} unavailable` : "Across all accounts, in USD"}
        />
        <StatCard
          label="Need attention"
          loading={loading}
          value={String(stats.attention)}
          tone={stats.attention > 0 ? "rose" : undefined}
          hint="Empty, low or suspended"
        />
        <StatCard
          label="Unavailable"
          loading={loading}
          value={String(stats.unavailable)}
          tone={stats.unavailable > 0 ? "amber" : undefined}
          hint="AgentX didn't respond"
        />
      </div>

      {/* List */}
      <section className={cardCls} aria-labelledby="billing-accounts-heading">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1e1e2e] px-5 py-4">
          <h2 id="billing-accounts-heading" className="font-semibold text-white">
            Accounts
            {accounts && accounts.length > 0 && (
              <span className="ml-2 text-xs font-normal text-[#66667f]">
                {rows.length === accounts.length ? accounts.length : `${rows.length} of ${accounts.length}`}
              </span>
            )}
          </h2>
          {accounts && accounts.length > 0 && (
            <div className="relative w-full sm:w-72">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#44445a]" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, email, org or number"
                aria-label="Search accounts"
                className={cn(inputCls, "py-1.5 pl-9")}
              />
            </div>
          )}
        </div>

        {loading ? (
          <ul className="divide-y divide-[#16161f]" aria-busy="true" aria-label="Loading accounts">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-4 px-5 py-4">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <Skeleton className="h-6 w-24" />
              </li>
            ))}
          </ul>
        ) : accounts && accounts.length === 0 ? (
          <EmptyState onAdd={() => setDialogOpen(true)} />
        ) : rows.length === 0 && accounts ? (
          <p className="px-5 py-12 text-center text-sm text-[#66667f]">No accounts match “{query}”.</p>
        ) : (
          <ul className="divide-y divide-[#16161f]">
            {rows.map(({ account, health }) => (
              <li key={account.organization_id}>
                <AccountRow account={account} health={health} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Mounted only while open, so every opening starts from a clean state. */}
      {dialogOpen && (
        <AddAccountDialog
          onClose={() => setDialogOpen(false)}
          onCreated={(account) => {
            setDialogOpen(false);
            router.push(`/billing/${account.organization_id}`);
          }}
        />
      )}
    </div>
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
  tone?: "rose" | "amber";
  loading: boolean;
}) {
  return (
    <div className={cn(cardCls, "p-4")}>
      <p className="text-xs text-[#66667f]">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone ? TONE[tone].text : "text-white")}>
          {value}
        </p>
      )}
      {hint && <p className="mt-0.5 text-[11px] text-[#44445a]">{hint}</p>}
    </div>
  );
}

function AccountRow({ account, health }: { account: BillingAccount; health: AccountHealth }) {
  const currency = account.display_currency ?? "USD";
  const meta = HEALTH_META[health];
  const showUsd = health !== "unavailable" && currency !== "USD";

  return (
    <Link
      href={`/billing/${account.organization_id}`}
      className={cn(
        "group relative flex items-center gap-4 px-5 py-4 transition-colors hover:bg-[#11111a]",
        "before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full",
        ROW_ACCENT[health],
        focusRing,
        "focus-visible:ring-inset focus-visible:ring-offset-0"
      )}
    >
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#262636] bg-[#13131c] text-sm font-semibold text-[#c4c4d8] ring-2",
          TONE[meta.tone].ring
        )}
        aria-hidden="true"
      >
        {initials(account.label)}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-white">{account.label}</span>
          <HealthBadge health={health} />
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#66667f]">
          <span className={account.email ? "text-[#8888aa]" : "italic"}>{account.email ?? "No owner email"}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">Org #{account.organization_id}</span>
          {(account.agent_numbers ?? []).length > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{account.agent_numbers.join(", ")}</span>
            </>
          )}
        </p>
      </div>

      <div className="shrink-0 text-right">
        {health === "unavailable" ? (
          <span className="flex items-center gap-1.5 text-xs text-[#8888aa]">
            <TriangleAlert size={13} className="text-amber-400" /> Balance unavailable
          </span>
        ) : (
          <>
            <p
              className={cn(
                "text-lg font-semibold tabular-nums",
                health === "empty" || health === "blocked" ? "text-rose-300" : health === "low" ? "text-amber-300" : "text-white"
              )}
            >
              {formatMoney(account.balance_display, currency)}
            </p>
            <p className="text-[11px] tabular-nums text-[#55556b]">
              {showUsd ? `${formatUsdPrecise(account.balance_usd)} USD` : "USD"}
              {account.is_blocked && (
                <span className="ml-1.5 inline-flex items-center gap-0.5 text-rose-300">
                  <ShieldAlert size={10} /> suspended
                </span>
              )}
            </p>
          </>
        )}
      </div>

      <ChevronRight
        size={16}
        className="shrink-0 text-[#33334a] transition-transform group-hover:translate-x-0.5 group-hover:text-[#8888aa]"
        aria-hidden="true"
      />
    </Link>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const steps = [
    "Pick the agent the customer uses",
    "Confirm the owner email AgentX finds from its API key",
    "Record payments; the wallet is credited in AgentX",
  ];
  return (
    <div className="px-6 py-14 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-indigo-500/20 bg-indigo-500/10">
        <Wallet size={24} className="text-indigo-300" />
      </div>
      <p className="mt-4 font-medium text-white">No billing accounts yet</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-[#66667f]">
        Add an account for each customer you collect payments from.
      </p>
      <ol className="mx-auto mt-5 max-w-sm space-y-2 text-left">
        {steps.map((step, i) => (
          <li key={step} className="flex items-start gap-3 text-sm text-[#8888aa]">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#2a2a3a] text-[11px] text-[#a0a0bc]">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
      <button type="button" onClick={onAdd} className={cn(buttonCls("primary"), "mt-6")}>
        <Plus size={16} /> Add your first account
      </button>
    </div>
  );
}

