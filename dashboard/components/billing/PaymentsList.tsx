"use client";

import { useState } from "react";
import { ArrowRight, CircleAlert, RotateCw } from "lucide-react";
import { apiErrorMessage, retryPayment, type Payment } from "@/lib/api";
import { formatMinor, formatMoney, trimRate } from "@/lib/money";
import { PAYMENT_STATUS_META, canRetryPayment, formatAbsolute, formatRelative } from "@/lib/billing";
import { cn } from "@/lib/utils";
import { Badge, CardHeader, Spinner, buttonCls, cardCls } from "@/components/billing/ui";

interface Props {
  payments: Payment[];
  onChanged: () => void;
}

export default function PaymentsList({ payments, onChanged }: Props) {
  const [retrying, setRetrying] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const attention = payments.filter((p) => p.status !== "confirmed").length;

  const retry = async (payment: Payment) => {
    if (retrying) return;
    setRetrying(payment.payment_id);
    setErrors((prev) => ({ ...prev, [payment.payment_id]: "" }));
    try {
      await retryPayment(payment.payment_id);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [payment.payment_id]: apiErrorMessage(e) }));
    } finally {
      setRetrying(null);
      onChanged();
    }
  };

  return (
    <section className={cardCls} aria-labelledby="payments-heading">
      <CardHeader
        title={<span id="payments-heading">Payments recorded here</span>}
        description="What operators entered in this console, and whether AgentX accepted it."
        actions={
          attention > 0 ? (
            <Badge tone="rose" dot>
              {attention} need{attention === 1 ? "s" : ""} attention
            </Badge>
          ) : undefined
        }
      />

      {payments.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-[#55556b]">No payments recorded from this console yet.</p>
      ) : (
        <ul className="divide-y divide-[#16161f]">
          {payments.map((payment) => {
            const meta = PAYMENT_STATUS_META[payment.status];
            const retryable = canRetryPayment(payment);
            const busy = retrying === payment.payment_id;
            const error = errors[payment.payment_id];
            return (
              <li key={payment.payment_id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Badge tone={meta.tone} dot pulse={payment.status === "pending"}>
                    {meta.label}
                  </Badge>
                  <span className="font-medium tabular-nums text-white">
                    {formatMinor(payment.paid_amount_minor, payment.paid_currency)}
                  </span>
                  {payment.status === "confirmed" && payment.credited_usd && (
                    <span className="flex items-center gap-1 text-sm tabular-nums text-emerald-300/90">
                      <ArrowRight size={12} className="text-[#44445a]" aria-label="credited as" />
                      {formatMoney(payment.credited_usd, "USD")}
                    </span>
                  )}
                  {payment.paid_currency === "INR" && payment.fx_rate_to_usd && (
                    <span className="text-xs text-[#55556b]">at {trimRate(payment.fx_rate_to_usd)}</span>
                  )}
                  <time
                    dateTime={payment.created_at}
                    title={formatAbsolute(payment.created_at)}
                    className="ml-auto text-xs text-[#55556b]"
                  >
                    {formatRelative(payment.created_at)}
                  </time>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-[#66667f]">
                  {payment.note && <span className="text-[#8888aa]">{payment.note}</span>}
                  {payment.note && payment.created_by && <span aria-hidden="true">·</span>}
                  {payment.created_by && <span>by {payment.created_by}</span>}
                  {payment.agentx_entry_id != null && (
                    <>
                      {(payment.note || payment.created_by) && <span aria-hidden="true">·</span>}
                      <span className="font-mono">entry #{payment.agentx_entry_id}</span>
                    </>
                  )}
                </div>

                {payment.status === "failed" && payment.error && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-md bg-rose-500/[0.06] px-2.5 py-1.5 text-xs text-rose-300">
                    <CircleAlert size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span className="break-words">{payment.error}</span>
                  </p>
                )}
                {payment.status === "pending" && !retryable && (
                  <p className="mt-2 text-xs text-amber-300/80">Waiting for AgentX to confirm…</p>
                )}
                {error && (
                  <p role="alert" className="mt-2 text-xs text-rose-300">
                    Retry failed: {error}
                  </p>
                )}

                {retryable && (
                  <div className="mt-2.5 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => retry(payment)}
                      disabled={Boolean(retrying)}
                      className={cn(buttonCls("secondary", "sm"))}
                    >
                      {busy ? <Spinner size={12} /> : <RotateCw size={12} />}
                      {busy ? "Retrying…" : "Retry"}
                    </button>
                    <span className="text-[11px] text-[#55556b]">Reuses the same key; can&apos;t double-credit.</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
