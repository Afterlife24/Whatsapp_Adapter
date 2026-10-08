"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  Info,
  Receipt,
  RotateCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import {
  apiErrorMessage,
  recordPayment,
  retryPayment,
  type BillingAccount,
  type Payment,
} from "@/lib/api";
import {
  currencySymbol,
  formatMinor,
  formatMoney,
  formatUsdPrecise,
  inverseRate,
  parseAmountToMinor,
  parseRate,
  previewCreditUsd,
  scaledToString,
  trimRate,
  type PaymentCurrency,
} from "@/lib/money";
import {
  DEFAULT_USD_INR_RATE,
  loadOperatorName,
  newRequestId,
  saveOperatorName,
} from "@/lib/billing";
import { cn } from "@/lib/utils";
import {
  Notice,
  Spinner,
  SummaryRow,
  buttonCls,
  cardCls,
  focusRing,
  inputCls,
  labelCls,
} from "@/components/billing/ui";

interface Props {
  account: BillingAccount;
  /** Called after AgentX has (or may have) changed; the parent refetches. */
  onRecorded: () => void;
}

type Stage = "form" | "review" | "submitting" | "result";

type Outcome =
  | { kind: "credited"; payment: Payment }
  | { kind: "duplicate"; payment: Payment }
  | { kind: "failed"; payment: Payment }
  | { kind: "unknown"; message: string };

const CURRENCIES: { code: PaymentCurrency; name: string }[] = [
  { code: "INR", name: "Indian rupee" },
  { code: "USD", name: "US dollar" },
];

function outcomeFor(payment: Payment): Outcome {
  if (payment.status === "confirmed") {
    return payment.duplicate ? { kind: "duplicate", payment } : { kind: "credited", payment };
  }
  if (payment.status === "failed") return { kind: "failed", payment };
  return { kind: "unknown", message: "AgentX hasn't confirmed this payment yet." };
}

export default function RecordPaymentPanel({ account, onRecorded }: Props) {
  const ids = {
    amount: useId(),
    amountHelp: useId(),
    rate: useId(),
    rateHelp: useId(),
    note: useId(),
    operator: useId(),
    preview: useId(),
  };

  const accountCurrency = (account.display_currency ?? "USD").toUpperCase();
  const [currency, setCurrency] = useState<PaymentCurrency>(accountCurrency === "USD" ? "USD" : "INR");
  const [amount, setAmount] = useState("");
  const [rate, setRate] = useState(DEFAULT_USD_INR_RATE);
  const [note, setNote] = useState("");
  // The panel only mounts after the account loads in the browser, so reading
  // localStorage here can't cause a server/client hydration mismatch.
  const [operator, setOperator] = useState(() =>
    typeof window === "undefined" ? "" : loadOperatorName()
  );
  const [showErrors, setShowErrors] = useState(false);

  const [stage, setStage] = useState<Stage>("form");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [retrying, setRetrying] = useState(false);

  // One id per reviewed payment. Resubmitting the same review reuses it, so
  // the adapter returns the existing payment instead of creating another.
  const requestId = useRef<string | null>(null);
  // Synchronous guard: state updates are async, a ref blocks a double-click.
  const inFlight = useRef(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (stage === "review") reviewHeadingRef.current?.focus();
    if (stage === "result") resultHeadingRef.current?.focus();
  }, [stage]);

  const amountResult = useMemo(() => parseAmountToMinor(amount), [amount]);
  const rateResult = useMemo(() => (currency === "INR" ? parseRate(rate) : null), [currency, rate]);

  const minor = amountResult.ok ? amountResult.value : null;
  const rateValue = rateResult && rateResult.ok ? rateResult.value : null;
  const creditUsd = minor !== null ? previewCreditUsd(minor, currency, rateValue) : null;
  const creditUsdText = creditUsd !== null ? scaledToString(creditUsd) : null;
  const creditIsZero = creditUsd !== null && creditUsd <= BigInt(0);

  const valid = minor !== null && creditUsd !== null && !creditIsZero && (currency === "USD" || rateValue !== null);
  const switchesCurrency = currency !== accountCurrency;
  const rateEdited = currency === "INR" && rate.trim() !== DEFAULT_USD_INR_RATE;
  const perDollar = rateValue ? inverseRate(rateValue) : null;

  const amountError = showErrors && !amountResult.ok ? amountResult.error : "";
  const rateError =
    showErrors && rateResult && !rateResult.ok
      ? rateResult.error
      : showErrors && creditIsZero
        ? "At this rate the payment credits less than $0.000001."
        : "";

  const resetForNewPayment = () => {
    setAmount("");
    setNote("");
    setShowErrors(false);
    setOutcome(null);
    requestId.current = null;
    setStage("form");
    requestAnimationFrame(() => amountRef.current?.focus());
  };

  const handleReview = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) {
      setShowErrors(true);
      return;
    }
    requestId.current = newRequestId();
    saveOperatorName(operator);
    setStage("review");
  };

  const backToEdit = () => {
    // Editing means a different payment: the next review gets a fresh id.
    requestId.current = null;
    setStage("form");
    requestAnimationFrame(() => amountRef.current?.focus());
  };

  const submit = async () => {
    if (inFlight.current || minor === null || !requestId.current) return;
    inFlight.current = true;
    setStage("submitting");
    try {
      const payment = await recordPayment(account.organization_id, {
        paid_amount_minor: minor,
        paid_currency: currency,
        fx_rate_to_usd: currency === "INR" && rateValue ? rateValue : undefined,
        note: note.trim() || undefined,
        created_by: operator.trim() || undefined,
        client_request_id: requestId.current,
      });
      setOutcome(outcomeFor(payment));
    } catch (e) {
      // No reliable answer: keep requestId so "Try again" can't double-credit.
      setOutcome({ kind: "unknown", message: apiErrorMessage(e) });
    } finally {
      inFlight.current = false;
      setStage("result");
      onRecorded();
    }
  };

  const retryFailed = async (payment: Payment) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRetrying(true);
    try {
      setOutcome(outcomeFor(await retryPayment(payment.payment_id)));
    } catch (e) {
      setOutcome({ kind: "unknown", message: apiErrorMessage(e) });
    } finally {
      inFlight.current = false;
      setRetrying(false);
      onRecorded();
    }
  };

  const amountText = minor !== null ? formatMinor(minor, currency) : "—";

  return (
    <section className={cn(cardCls, "overflow-hidden")} aria-labelledby="record-payment-heading">
      <div className="border-b border-[#1e1e2e] bg-gradient-to-b from-indigo-500/[0.06] to-transparent px-5 py-4">
        <div className="flex items-center gap-2">
          <Receipt size={16} className="text-indigo-300" aria-hidden="true" />
          <h2 id="record-payment-heading" className="font-semibold text-white">
            Record a payment
          </h2>
        </div>
        <p className="mt-0.5 text-xs text-[#66667f]">Credit money this customer has already paid you.</p>
      </div>

      {/* ── Form ─────────────────────────────────────────────────────── */}
      {stage === "form" && (
        <form onSubmit={handleReview} noValidate className="space-y-5 p-5">
          {/* Currency */}
          <fieldset>
            <legend className={labelCls}>Paid in</legend>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-[#2a2a3a] bg-[#0a0a0f] p-1">
              {CURRENCIES.map(({ code, name }) => {
                const active = currency === code;
                return (
                  <label
                    key={code}
                    className={cn(
                      "relative flex cursor-pointer items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      active ? "bg-indigo-600 text-white shadow" : "text-[#8888aa] hover:text-white"
                    )}
                  >
                    <input
                      type="radio"
                      name="payment-currency"
                      value={code}
                      checked={active}
                      onChange={() => setCurrency(code)}
                      className="peer sr-only"
                      aria-label={`${name} (${code})`}
                    />
                    <span className="pointer-events-none absolute inset-0 rounded-md peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-400" />
                    <span aria-hidden="true" className="tabular-nums opacity-80">
                      {currencySymbol(code)}
                    </span>
                    {code}
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* Amount */}
          <div>
            <label htmlFor={ids.amount} className={labelCls}>
              Amount received
            </label>
            <div className="relative">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-[#66667f]"
              >
                {currencySymbol(currency)}
              </span>
              <input
                ref={amountRef}
                id={ids.amount}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                placeholder={currency === "INR" ? "500" : "10.00"}
                aria-invalid={Boolean(amountError)}
                aria-describedby={ids.amountHelp}
                className={cn(
                  inputCls,
                  "py-2.5 pl-8 text-lg font-semibold tabular-nums",
                  amountError && "border-rose-500/60 focus:border-rose-500 focus:ring-rose-500"
                )}
              />
            </div>
            <p id={ids.amountHelp} className={cn("mt-1 text-xs", amountError ? "text-rose-300" : "text-[#44445a]")}>
              {amountError || "Exactly what the customer paid, up to 2 decimal places."}
            </p>
          </div>

          {/* Rate */}
          {currency === "INR" && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor={ids.rate} className="text-xs font-medium text-[#8888aa]">
                  Exchange rate
                </label>
                {rateEdited && (
                  <button
                    type="button"
                    onClick={() => setRate(DEFAULT_USD_INR_RATE)}
                    className={cn("rounded text-[11px] text-indigo-300 hover:text-indigo-200", focusRing)}
                  >
                    Reset to {DEFAULT_USD_INR_RATE}
                  </button>
                )}
              </div>
              <div
                className={cn(
                  "flex items-center rounded-lg border bg-[#0a0a0f] transition-colors focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500",
                  rateError ? "border-rose-500/60" : "border-[#2a2a3a]"
                )}
              >
                <span className="pl-3 text-xs text-[#66667f]" aria-hidden="true">
                  1 INR =
                </span>
                <input
                  id={ids.rate}
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(rateError)}
                  aria-describedby={ids.rateHelp}
                  className="min-w-0 flex-1 bg-transparent px-2 py-2 font-mono text-sm text-white focus:outline-none"
                />
                <span className="pr-3 text-xs text-[#66667f]" aria-hidden="true">
                  USD
                </span>
              </div>
              <p id={ids.rateHelp} className={cn("mt-1 text-xs", rateError ? "text-rose-300" : "text-[#44445a]")}>
                {rateError ||
                  (perDollar
                    ? `≈ ₹${perDollar} per $1. Use the rate you actually applied.`
                    : "How many US dollars one rupee is worth.")}
              </p>
            </div>
          )}

          {/* Live preview */}
          <div
            className={cn(
              "rounded-xl border px-4 py-3.5 transition-colors",
              valid ? "border-indigo-500/25 bg-indigo-500/[0.06]" : "border-[#1e1e2e] bg-[#0a0a0f]"
            )}
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-[#66667f]">Wallet will be credited</p>
            <p id={ids.preview} aria-live="polite" className="mt-1 flex items-baseline gap-2">
              <span className={cn("text-2xl font-semibold tabular-nums", valid ? "text-white" : "text-[#33334a]")}>
                {valid && creditUsdText ? formatMoney(creditUsdText, "USD") : "$0.00"}
              </span>
              {valid && creditUsdText && (
                <span className="text-xs tabular-nums text-[#66667f]">{formatUsdPrecise(creditUsdText)} exact</span>
              )}
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[#55556b]">
              Preview only. AgentX recalculates from the amount and rate, and its figure is final.
            </p>
          </div>

          {/* Display-currency side effect */}
          {switchesCurrency ? (
            <Notice tone="amber" icon={<TriangleAlert size={15} />} title={`Switches the customer to ${currency}`}>
              After this payment, {account.label}&apos;s billing screen shows balances in {currency} instead of{" "}
              {accountCurrency}.
            </Notice>
          ) : (
            <p className="flex items-start gap-2 text-xs text-[#66667f]">
              <Info size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              The customer keeps seeing balances in {currency}. Recording in the other currency would switch them.
            </p>
          )}

          {/* Reference + operator */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <div>
              <label htmlFor={ids.note} className={labelCls}>
                Reference <span className="font-normal text-[#44445a]">(optional)</span>
              </label>
              <input
                id={ids.note}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                placeholder="UPI ref 4432"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor={ids.operator} className={labelCls}>
                Recorded by <span className="font-normal text-[#44445a]">(optional)</span>
              </label>
              <input
                id={ids.operator}
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                maxLength={60}
                autoComplete="name"
                placeholder="Your name"
                className={inputCls}
              />
            </div>
          </div>

          <button type="submit" className={cn(buttonCls("primary"), "w-full py-2.5")}>
            Review payment
          </button>
        </form>
      )}

      {/* ── Review / submitting ──────────────────────────────────────── */}
      {(stage === "review" || stage === "submitting") && (
        <div className="space-y-4 p-5">
          <h3 ref={reviewHeadingRef} tabIndex={-1} className="text-sm font-semibold text-white focus:outline-none">
            Check the details before crediting
          </h3>

          <div className="rounded-xl border border-[#262636] bg-[#0a0a0f] px-4 py-1">
            <dl className="divide-y divide-[#1a1a26]">
              <SummaryRow label="Account">
                <span className="block truncate">{account.label}</span>
                <span className="block text-xs text-[#66667f]">
                  {account.email ?? "No owner email"} · Org #{account.organization_id}
                </span>
              </SummaryRow>
              <SummaryRow label="Amount received">{amountText}</SummaryRow>
              {currency === "INR" && rateValue && (
                <SummaryRow label="Exchange rate">1 INR = {trimRate(rateValue)} USD</SummaryRow>
              )}
              {note.trim() && <SummaryRow label="Reference">{note.trim()}</SummaryRow>}
              <SummaryRow label="Customer currency">
                {switchesCurrency ? (
                  <span className="text-amber-300">
                    {accountCurrency} → {currency}
                  </span>
                ) : (
                  currency
                )}
              </SummaryRow>
              <SummaryRow label="Wallet credit" emphasis>
                {creditUsdText ? formatMoney(creditUsdText, "USD") : "—"}
                {creditUsdText && (
                  <span className="block text-[11px] font-normal text-[#66667f]">
                    {formatUsdPrecise(creditUsdText)} exact
                  </span>
                )}
              </SummaryRow>
            </dl>
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <button
              type="button"
              onClick={backToEdit}
              disabled={stage === "submitting"}
              className={cn(buttonCls("secondary"), "sm:flex-1")}
            >
              <ArrowLeft size={14} /> Edit
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={stage === "submitting"}
              aria-busy={stage === "submitting"}
              className={cn(buttonCls("primary"), "sm:flex-[2]")}
            >
              {stage === "submitting" ? (
                <>
                  <Spinner /> Crediting…
                </>
              ) : (
                <>Confirm and credit {creditUsdText ? formatMoney(creditUsdText, "USD") : ""}</>
              )}
            </button>
          </div>

          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[#55556b]">
            <ShieldCheck size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            Saved here first, then sent to AgentX with a one-time key. Clicking twice or retrying can&apos;t credit it
            twice.
          </p>
        </div>
      )}

      {/* ── Result ───────────────────────────────────────────────────── */}
      {stage === "result" && outcome && (
        <div className="space-y-4 p-5" role="status">
          {outcome.kind === "credited" && (
            <ResultBlock
              headingRef={resultHeadingRef}
              tone="emerald"
              icon={<CircleCheck size={22} />}
              title={`Credited ${formatMoney(outcome.payment.credited_usd, "USD")}`}
            >
              {formatMinor(outcome.payment.paid_amount_minor, outcome.payment.paid_currency)} received from{" "}
              {account.label}. AgentX ledger entry #{outcome.payment.agentx_entry_id}.
            </ResultBlock>
          )}

          {outcome.kind === "duplicate" && (
            <ResultBlock
              headingRef={resultHeadingRef}
              tone="sky"
              icon={<CircleCheck size={22} />}
              title="Already credited"
            >
              AgentX matched this to entry #{outcome.payment.agentx_entry_id}. No extra money was added.
            </ResultBlock>
          )}

          {outcome.kind === "failed" && (
            <>
              <ResultBlock
                headingRef={resultHeadingRef}
                tone="rose"
                icon={<CircleAlert size={22} />}
                title="AgentX didn't accept this payment"
              >
                {outcome.payment.error || "No reason was given."}
              </ResultBlock>
              <p className="text-xs text-[#66667f]">
                It&apos;s saved as failed under Payments. Retrying reuses the same key, so it can only ever be credited
                once.
              </p>
              <button
                type="button"
                onClick={() => retryFailed(outcome.payment)}
                disabled={retrying}
                className={cn(buttonCls("secondary"), "w-full")}
              >
                {retrying ? <Spinner /> : <RotateCw size={14} />}
                {retrying ? "Retrying…" : "Retry now"}
              </button>
            </>
          )}

          {outcome.kind === "unknown" && (
            <>
              <ResultBlock
                headingRef={resultHeadingRef}
                tone="amber"
                icon={<TriangleAlert size={22} />}
                title="Couldn't confirm the payment"
              >
                {outcome.message}
              </ResultBlock>
              <p className="text-xs text-[#66667f]">
                Trying again is safe: it resends this same payment, so the customer can&apos;t be credited twice.
              </p>
              <button type="button" onClick={submit} className={cn(buttonCls("secondary"), "w-full")}>
                <RotateCw size={14} /> Try again
              </button>
            </>
          )}

          <button type="button" onClick={resetForNewPayment} className={cn(buttonCls("primary"), "w-full")}>
            Record another payment
          </button>
        </div>
      )}
    </section>
  );
}

function ResultBlock({
  tone,
  icon,
  title,
  children,
  headingRef,
}: {
  tone: "emerald" | "sky" | "rose" | "amber";
  icon: ReactNode;
  title: string;
  children: ReactNode;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const toneCls = {
    emerald: "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-300",
    sky: "border-sky-500/25 bg-sky-500/[0.07] text-sky-300",
    rose: "border-rose-500/25 bg-rose-500/[0.07] text-rose-300",
    amber: "border-amber-500/25 bg-amber-500/[0.07] text-amber-300",
  }[tone];

  return (
    <div className={cn("rounded-xl border px-4 py-4", toneCls)}>
      <div className="flex items-start gap-3">
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 ref={headingRef} tabIndex={-1} className="font-semibold text-white focus:outline-none">
            {title}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-[#c4c4d8]">{children}</p>
        </div>
      </div>
    </div>
  );
}
