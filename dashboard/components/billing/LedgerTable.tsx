import type { ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, BookOpen, Scale } from "lucide-react";
import type { Ledger, LedgerEntry } from "@/lib/api";
import { formatMinor, formatUsdPrecise, isPositive, trimRate } from "@/lib/money";
import { TONE, formatAbsolute, formatRelative, ledgerActivity } from "@/lib/billing";
import { cn } from "@/lib/utils";
import { CardHeader, cardCls } from "@/components/billing/ui";

const numberFormat = new Intl.NumberFormat("en-IN");

function ActivityIcon({ entry }: { entry: LedgerEntry }) {
  const size = 13;
  if (entry.entry_type === "adjustment") return <Scale size={size} />;
  if (entry.entry_type === "debit_call" && entry.idempotency_key.startsWith("kb:")) return <BookOpen size={size} />;
  return isPositive(entry.amount_usd) ? <ArrowDownLeft size={size} /> : <ArrowUpRight size={size} />;
}

function Details({ entry }: { entry: LedgerEntry }) {
  const parts: ReactNode[] = [];

  if (entry.entry_type === "topup" && entry.paid_amount_minor != null && entry.paid_currency) {
    parts.push(
      <span key="paid" className="text-[#c4c4d8]">
        {formatMinor(entry.paid_amount_minor, entry.paid_currency)}
        {entry.paid_currency !== "USD" && entry.fx_rate_to_usd && (
          <span className="text-[#66667f]"> at {trimRate(entry.fx_rate_to_usd)}</span>
        )}
      </span>
    );
  }

  if (entry.entry_type === "debit_call") {
    if (entry.idempotency_key.startsWith("kb:")) {
      parts.push(<span key="kb">Document {entry.idempotency_key.slice(3)}</span>);
    } else if (entry.workflow_run_id != null) {
      parts.push(
        <span key="run" className="font-mono">
          Run #{entry.workflow_run_id}
        </span>
      );
    }
    if (entry.tokens_charged != null) {
      parts.push(<span key="tokens">{numberFormat.format(entry.tokens_charged)} tokens</span>);
    }
  }

  if (entry.memo && !(entry.entry_type === "debit_call" && entry.idempotency_key.startsWith("kb:"))) {
    parts.push(
      <span key="memo" className="text-[#8888aa]">
        {entry.memo}
      </span>
    );
  }

  if (parts.length === 0) return <span className="text-[#44445a]">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true" className="text-[#33334a]">·</span>}
          {part}
        </span>
      ))}
    </span>
  );
}

export default function LedgerTable({ ledger }: { ledger: Ledger }) {
  const { entries, total_count: total } = ledger;

  return (
    <section className={cardCls} aria-labelledby="ledger-heading">
      <CardHeader
        title={<span id="ledger-heading">AgentX ledger</span>}
        description={
          total > entries.length
            ? `Latest ${entries.length} of ${numberFormat.format(total)} entries · amounts in USD`
            : `${numberFormat.format(total)} ${total === 1 ? "entry" : "entries"} · amounts in USD`
        }
      />

      {entries.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-[#55556b]">
          No ledger entries yet. Top-ups and call usage will appear here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">AgentX ledger entries, newest first</caption>
            <thead>
              <tr className="border-b border-[#1e1e2e] text-left text-[11px] uppercase tracking-wider text-[#55556b]">
                <th scope="col" className="px-5 py-2.5 font-medium">When</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Activity</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Details</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Amount</th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">Balance after</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#16161f]">
              {entries.map((entry) => {
                const activity = ledgerActivity(entry);
                const credit = isPositive(entry.amount_usd);
                return (
                  <tr key={entry.id} className="transition-colors hover:bg-[#11111a]">
                    <td className="whitespace-nowrap px-5 py-3 text-xs text-[#8888aa]">
                      <time dateTime={entry.created_at} title={formatAbsolute(entry.created_at)}>
                        {formatRelative(entry.created_at)}
                      </time>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", TONE[activity.tone].text)}>
                        <span
                          className={cn(
                            "flex h-5 w-5 items-center justify-center rounded-md border",
                            TONE[activity.tone].soft
                          )}
                          aria-hidden="true"
                        >
                          <ActivityIcon entry={entry} />
                        </span>
                        {activity.label}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-xs text-[#8888aa]">
                      <Details entry={entry} />
                    </td>
                    <td
                      className={cn(
                        "whitespace-nowrap px-3 py-3 text-right font-medium tabular-nums",
                        credit ? "text-emerald-300" : "text-rose-300"
                      )}
                    >
                      {formatUsdPrecise(entry.amount_usd, true)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-[#c4c4d8]">
                      {formatUsdPrecise(entry.balance_after_usd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
