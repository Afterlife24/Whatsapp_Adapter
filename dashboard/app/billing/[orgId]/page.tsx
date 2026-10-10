"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronRight, CircleAlert, Mail, Phone, RefreshCw, ShieldAlert, Wallet } from "lucide-react";
import { apiErrorMessage, getBillingAccount, type BillingAccount, type BillingAccountDetail } from "@/lib/api";
import { currencySymbol, formatMoney, formatUsdPrecise, inverseRate, isPositive, trimRate } from "@/lib/money";
import { HEALTH_META, TONE, accountHealth } from "@/lib/billing";
import { cn } from "@/lib/utils";
import RecordPaymentPanel from "@/components/billing/RecordPaymentPanel";
import PaymentsList from "@/components/billing/PaymentsList";
import LedgerTable from "@/components/billing/LedgerTable";
import CurrencySettingCard from "@/components/billing/CurrencySettingCard";
import WorkflowsCard from "@/components/billing/WorkflowsCard";
import { CopyButton, HealthBadge, Notice, Skeleton, buttonCls, cardCls, focusRing } from "@/components/billing/ui";

const timeFormat = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

export default function BillingAccountPage() {
  const params = useParams<{ orgId: string }>();
  const rawId = params?.orgId ?? "";
  const organizationId = /^\d+$/.test(rawId) ? Number(rawId) : null;

  const [detail, setDetail] = useState<BillingAccountDetail | null>(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (organizationId === null) return;
    // Ignore a response that arrives after a newer refresh was started, so a
    // slow request can't overwrite the balance shown after a payment.
    let current = true;
    getBillingAccount(organizationId)
      .then((data) => {
        if (!current) return;
        setDetail(data);
        setError("");
        setNotFound(false);
        setLoadedAt(Date.now());
      })
      .catch((e) => {
        if (!current) return;
        const message = e instanceof Error ? e.message : "";
        if (message.startsWith("404") && message.includes("Billing account not found")) setNotFound(true);
        else setError(apiErrorMessage(e));
      })
      .finally(() => current && setRefreshing(false));
    return () => {
      current = false;
    };
  }, [organizationId, reloadKey]);

  const load = useCallback(() => {
    setRefreshing(true);
    setReloadKey((key) => key + 1);
  }, []);

  if (organizationId === null || notFound) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <Breadcrumb label="Not found" />
        <div className={cn(cardCls, "mt-6 px-6 py-14 text-center")}>
          <Wallet size={32} className="mx-auto text-[#2a2a3a]" />
          <p className="mt-3 font-medium text-white">No billing account here</p>
          <p className="mt-1 text-sm text-[#66667f]">
            Organization {organizationId === null ? `"${rawId}"` : `#${organizationId}`} doesn&apos;t have a billing
            account in this console.
          </p>
          <Link href="/billing" className={cn(buttonCls("secondary"), "mt-5")}>
            Back to billing
          </Link>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <Breadcrumb label={`Org #${organizationId}`} />
        {error ? (
          <Notice
            tone="rose"
            icon={<CircleAlert size={16} />}
            title="Couldn't load this account"
            role="alert"
            action={
              <button type="button" onClick={load} className={buttonCls("secondary", "sm")}>
                Try again
              </button>
            }
          >
            {error}
          </Notice>
        ) : (
          <LoadingSkeleton />
        )}
      </div>
    );
  }

  const { account, ledger, payments } = detail;
  const health = accountHealth(account);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <Breadcrumb label={account.label} />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-bold text-white">{account.label}</h1>
            <HealthBadge health={health} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-[#8888aa]">
            <span className="flex items-center gap-1.5">
              <Mail size={13} className="text-[#55556b]" aria-hidden="true" />
              {account.email ?? <span className="italic text-[#66667f]">No owner email</span>}
            </span>
            <span className="flex items-center gap-1 font-mono text-xs">
              Org #{account.organization_id}
              <CopyButton value={String(account.organization_id)} label="organization id" />
            </span>
            {(account.agent_numbers ?? []).map((number) => (
              <Link
                key={number}
                href={`/agents/${encodeURIComponent(number)}`}
                className={cn(
                  "flex items-center gap-1 rounded-md border border-[#1e1e2e] px-1.5 py-0.5 font-mono text-xs text-[#8888aa] hover:border-[#2a2a3a] hover:text-white",
                  focusRing
                )}
              >
                <Phone size={11} aria-hidden="true" /> {number}
              </Link>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {loadedAt && (
            <span className="hidden text-xs text-[#55556b] sm:inline">
              Live from AgentX · {timeFormat.format(loadedAt)}
            </span>
          )}
          <button type="button" onClick={load} disabled={refreshing} className={buttonCls("secondary")}>
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <Notice tone="amber" icon={<CircleAlert size={16} />} title="Showing the last loaded data" role="alert">
          Refresh failed: {error}
        </Notice>
      )}

      {account.is_blocked && (
        <Notice tone="rose" icon={<ShieldAlert size={16} />} title="This account is suspended in AgentX">
          New calls and chats are refused regardless of balance. Payments recorded here still credit the wallet.
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
        <BalanceCard account={account} />

        <aside className="lg:col-start-2 lg:row-span-4 lg:row-start-1 space-y-6">
          <div className="lg:sticky lg:top-6 space-y-6">
            <CurrencySettingCard account={account} onChanged={load} />
            <RecordPaymentPanel account={account} onRecorded={load} />
          </div>
        </aside>

        <div className="min-w-0 lg:col-start-1">
          <WorkflowsCard workflows={detail.workflows} />
        </div>
        <div className="min-w-0 lg:col-start-1">
          <PaymentsList payments={payments} onChanged={load} />
        </div>
        <div className="min-w-0 lg:col-start-1">
          <LedgerTable ledger={ledger} />
        </div>
      </div>
    </div>
  );
}

function Breadcrumb({ label }: { label: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-[#66667f]">
      <Link href="/billing" className={cn("rounded hover:text-white", focusRing)}>
        Billing
      </Link>
      <ChevronRight size={14} className="text-[#33334a]" aria-hidden="true" />
      <span aria-current="page" className="truncate text-[#a0a0bc]">
        {label}
      </span>
    </nav>
  );
}

function BalanceCard({ account }: { account: BillingAccount }) {
  const health = accountHealth(account);
  const meta = HEALTH_META[health];
  const currency = account.display_currency ?? "USD";
  const nonUsd = currency !== "USD";
  const rate = account.display_fx_rate_to_usd;
  const perUnit = nonUsd && rate ? inverseRate(rate) : null;
  const threshold = account.low_balance_threshold_usd;
  const alarming = health === "empty" || health === "blocked";

  return (
    <section
      aria-labelledby="balance-heading"
      className={cn(
        cardCls,
        "relative overflow-hidden p-6",
        alarming && "border-rose-500/25",
        health === "low" && "border-amber-500/25"
      )}
    >
      {/* Soft glow keyed to account health */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full blur-3xl",
          alarming ? "bg-rose-500/10" : health === "low" ? "bg-amber-500/10" : "bg-indigo-500/10"
        )}
      />

      <div className="relative">
        <h2 id="balance-heading" className="text-xs font-medium uppercase tracking-wider text-[#66667f]">
          Wallet balance
        </h2>

        {health === "unavailable" ? (
          <p className="mt-3 text-sm text-[#8888aa]">{meta.hint}</p>
        ) : (
          <>
            <p
              className={cn(
                "mt-2 text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl",
                alarming ? "text-rose-300" : health === "low" ? "text-amber-200" : "text-white"
              )}
            >
              {formatMoney(account.balance_display, currency)}
            </p>
            <p className="mt-1.5 text-sm tabular-nums text-[#8888aa]">
              {formatUsdPrecise(account.balance_usd)} <span className="text-[#55556b]">USD in AgentX</span>
            </p>
            <p className={cn("mt-3 flex items-center gap-2 text-sm", TONE[meta.tone].text)}>
              <span className={cn("h-1.5 w-1.5 rounded-full", TONE[meta.tone].dot)} aria-hidden="true" />
              {meta.hint}
            </p>
          </>
        )}

        <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[#1e1e2e] bg-[#1e1e2e] sm:grid-cols-3">
          <Fact label="Customer sees">
            {currency}
            <span className="block text-[11px] font-normal text-[#55556b]">set below</span>
          </Fact>
          <Fact label="Display rate">
            {nonUsd && rate ? (
              <>
                1 {currency} = {trimRate(rate)} USD
                {perUnit && (
                  <span className="block text-[11px] text-[#55556b]">
                    ≈ {currencySymbol(currency)}
                    {perUnit} per $1
                  </span>
                )}
              </>
            ) : (
              "—"
            )}
          </Fact>
          <Fact label="Low-balance alert">
            {threshold && isPositive(threshold) ? `At or below ${formatMoney(threshold, "USD")}` : "Off"}
          </Fact>
        </dl>
        {nonUsd && (
          <p className="mt-2 text-[11px] text-[#55556b]">
            The display rate comes from the latest payment. It only changes how the balance is shown, never the USD
            amount.
          </p>
        )}
      </div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-[#0b0b11] px-3.5 py-3">
      <dt className="text-[11px] text-[#55556b]">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums text-[#d4d4e4]">{children}</dd>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading account">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
        <div className="space-y-6">
          <Skeleton className="h-56 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
        <Skeleton className="h-[520px] w-full rounded-xl" />
      </div>
    </div>
  );
}
