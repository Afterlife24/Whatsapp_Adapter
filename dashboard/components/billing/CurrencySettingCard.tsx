"use client";

import { useMemo, useState } from "react";
import { CircleAlert, CircleCheck, Coins, Info } from "lucide-react";
import { apiErrorMessage, setAccountCurrency, type BillingAccount } from "@/lib/api";
import { currencySymbol, inverseRate, parseRate, trimRate } from "@/lib/money";
import { DEFAULT_USD_INR_RATE } from "@/lib/billing";
import { cn } from "@/lib/utils";
import { Notice, Spinner, buttonCls, cardCls, focusRing, labelCls } from "@/components/billing/ui";

type Currency = "INR" | "USD";

interface Props {
  account: BillingAccount;
  /** Called after AgentX confirms the change; the parent refetches. */
  onChanged: () => void;
}

/**
 * The account's display currency is an explicit admin choice. It decides both
 * what the customer sees on their billing page AND the only currency payments
 * may be recorded in for this account. New accounts default to USD; the admin
 * switches to INR here if they collect rupees.
 */
export default function CurrencySettingCard({ account, onChanged }: Props) {
  const current = ((account.display_currency ?? "USD").toUpperCase() as Currency);
  const currentRate = account.display_fx_rate_to_usd ?? null;

  const [choice, setChoice] = useState<Currency>(current);
  const [rate, setRate] = useState(
    current === "INR" && currentRate ? trimRate(currentRate) : DEFAULT_USD_INR_RATE
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const rateResult = useMemo(() => (choice === "INR" ? parseRate(rate) : null), [choice, rate]);
  const rateValid = choice === "USD" || (rateResult?.ok ?? false);
  const perDollar = rateResult?.ok ? inverseRate(rateResult.value) : null;

  // A change is pending if the currency differs, or (for INR) the rate differs.
  const rateChanged =
    choice === "INR" && currentRate != null && trimRate(rate) !== trimRate(currentRate);
  const dirty = choice !== current || rateChanged;

  const save = async () => {
    if (!rateValid || !dirty) return;
    setError("");
    setSaving(true);
    setSaved(false);
    try {
      await setAccountCurrency(account.organization_id, {
        currency: choice,
        fx_rate_to_usd: choice === "INR" && rateResult?.ok ? rateResult.value : undefined,
      });
      setSaved(true);
      onChanged();
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={cn(cardCls, "p-5")} aria-labelledby="currency-heading">
      <div className="flex items-center gap-2">
        <Coins size={16} className="text-indigo-300" aria-hidden="true" />
        <h2 id="currency-heading" className="font-semibold text-white">
          Billing currency
        </h2>
      </div>
      <p className="mt-1 text-xs text-[#66667f]">
        What this customer sees on their billing page, and the only currency payments can be recorded in.
      </p>

      {/* Currency choice */}
      <div
        role="radiogroup"
        aria-label="Billing currency"
        className="mt-4 grid grid-cols-2 gap-1 rounded-lg border border-[#2a2a3a] bg-[#0a0a0f] p-1"
      >
        {(["INR", "USD"] as Currency[]).map((code) => {
          const active = choice === code;
          return (
            <label
              key={code}
              className={cn(
                "relative flex cursor-pointer items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active ? "bg-indigo-600 text-white shadow" : "text-[#8888aa] hover:text-white"
              )}
            >
              <input
                type="radio"
                name="account-currency"
                value={code}
                checked={active}
                onChange={() => setChoice(code)}
                className="peer sr-only"
              />
              <span className="pointer-events-none absolute inset-0 rounded-md peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-400" />
              <span aria-hidden="true" className="opacity-80">
                {currencySymbol(code)}
              </span>
              {code}
              {code === current && (
                <span className="text-[10px] font-normal opacity-70">· current</span>
              )}
            </label>
          );
        })}
      </div>

      {/* Rate (INR only) */}
      {choice === "INR" && (
        <div className="mt-4">
          <label htmlFor="account-currency-rate" className={labelCls}>
            Exchange rate
          </label>
          <div
            className={cn(
              "flex items-center rounded-lg border bg-[#0a0a0f] transition-colors focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500",
              rateResult && !rateResult.ok ? "border-rose-500/60" : "border-[#2a2a3a]"
            )}
          >
            <span className="pl-3 text-xs text-[#66667f]" aria-hidden="true">
              1 INR =
            </span>
            <input
              id="account-currency-rate"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent px-2 py-2 font-mono text-sm text-white focus:outline-none"
            />
            <span className="pr-3 text-xs text-[#66667f]" aria-hidden="true">
              USD
            </span>
          </div>
          <p className={cn("mt-1 text-xs", rateResult && !rateResult.ok ? "text-rose-300" : "text-[#44445a]")}>
            {rateResult && !rateResult.ok
              ? rateResult.error
              : perDollar
                ? `≈ ₹${perDollar} per $1. Used as the default; each payment can fine-tune it.`
                : "How many US dollars one rupee is worth."}
          </p>
        </div>
      )}

      {choice !== current && (
        <Notice tone="amber" icon={<Info size={15} />} className="mt-4">
          Switching to {choice} changes what this customer sees and locks future payments to {choice}. Past
          transactions keep their original amounts; the USD balance never changes.
        </Notice>
      )}

      {error && (
        <Notice tone="rose" icon={<CircleAlert size={16} />} className="mt-4" role="alert">
          {error}
        </Notice>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || !rateValid || saving}
          className={buttonCls("primary")}
        >
          {saving ? <Spinner /> : null}
          {saving ? "Saving…" : "Save currency"}
        </button>
        {saved && (
          <span className={cn("flex items-center gap-1.5 text-sm text-emerald-400", focusRing)}>
            <CircleCheck size={15} /> Saved
          </span>
        )}
        {!dirty && !saved && (
          <span className="text-xs text-[#55556b]">Currently {current}</span>
        )}
      </div>
    </section>
  );
}
