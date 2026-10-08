"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Building2,
  CircleAlert,
  KeyRound,
  Mail,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  apiErrorMessage,
  createBillingAccount,
  getAgents,
  resolveBillingAccount,
  type Agent,
  type BillingAccount,
  type WalletBalance,
} from "@/lib/api";
import { formatMoney, formatUsdPrecise } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  Notice,
  Skeleton,
  Spinner,
  SummaryRow,
  buttonCls,
  focusRing,
  inputCls,
  labelCls,
} from "@/components/billing/ui";

interface Props {
  onClose: () => void;
  accounts: BillingAccount[];
  onCreated: (account: BillingAccount) => void;
}

type Step = "choose" | "confirm";

/** Render only while open: each mount starts from a clean state. */
export default function AddAccountDialog({ onClose, accounts, onCreated }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentsError, setAgentsError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [step, setStep] = useState<Step>("choose");
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<WalletBalance | null>(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const busy = resolving || saving;

  // Load agents, lock page scroll, and return focus to the opener on close.
  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    let current = true;
    getAgents()
      .then((list) => current && setAgents(list))
      .catch((e) => current && setAgentsError(apiErrorMessage(e)));

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      current = false;
      document.body.style.overflow = originalOverflow;
      restoreFocus.current?.focus?.();
    };
  }, []);

  // Move focus into the dialog when the step changes.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]");
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [step, agents]);

  // Escape closes; Tab stays inside the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  /** Agent phone number -> the billing account it already belongs to. */
  const linkedTo = useMemo(() => {
    const map = new Map<string, BillingAccount>();
    for (const account of accounts) {
      for (const number of account.agent_numbers ?? []) map.set(number, account);
    }
    return map;
  }, [accounts]);

  const visibleAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = agents ?? [];
    if (!q) return list;
    return list.filter(
      (a) => a.agent_name.toLowerCase().includes(q) || a.phone_number.toLowerCase().includes(q)
    );
  }, [agents, query]);

  const selectedAgent = agents?.find((a) => a.phone_number === selected) ?? null;
  const existingAccount = resolved
    ? accounts.find((a) => a.organization_id === resolved.organization_id) ?? null
    : null;

  const handleResolve = async () => {
    if (!selectedAgent) return;
    setError("");
    setResolving(true);
    try {
      const result = await resolveBillingAccount(selectedAgent.phone_number);
      setResolved(result);
      setLabel(selectedAgent.agent_name);
      setStep("confirm");
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setResolving(false);
    }
  };

  const handleSave = async () => {
    if (!selectedAgent || !resolved || existingAccount) return;
    setError("");
    setSaving(true);
    try {
      const account = await createBillingAccount(selectedAgent.phone_number, label.trim());
      onCreated(account);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm"
        aria-hidden="true"
        onClick={() => !busy && onClose()}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative my-8 w-full max-w-lg overflow-hidden rounded-2xl border border-[#262636] bg-[#0d0d14] shadow-2xl shadow-black/60"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[#1e1e2e] px-6 py-5">
          <div className="flex items-start gap-3">
            {step === "confirm" && (
              <button
                type="button"
                onClick={() => {
                  setStep("choose");
                  setError("");
                }}
                disabled={saving}
                aria-label="Back to agent list"
                className={cn("-ml-1 mt-0.5 rounded-md p-1 text-[#66667f] hover:bg-[#1a1a26] hover:text-white", focusRing)}
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-indigo-300/80">
                Step {step === "choose" ? "1" : "2"} of 2
              </p>
              <h2 id={titleId} className="mt-0.5 text-lg font-semibold text-white">
                {step === "choose" ? "Add a billing account" : "Confirm the account owner"}
              </h2>
              <p id={descriptionId} className="mt-1 text-sm text-[#8888aa]">
                {step === "choose"
                  ? "Pick the agent this customer uses. AgentX finds their organization from the agent's API key, so you never type an org id."
                  : "Check this is the right customer before you save. Payments will credit this organization."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className={cn("rounded-md p-1 text-[#66667f] hover:bg-[#1a1a26] hover:text-white", focusRing)}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-6 py-5">
          {step === "choose" ? (
            <>
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#44445a]" />
                <input
                  data-autofocus
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search agents by name or number"
                  aria-label="Search agents"
                  className={cn(inputCls, "pl-9")}
                />
              </div>

              {agentsError ? (
                <Notice tone="rose" icon={<CircleAlert size={16} />} title="Couldn't load agents" role="alert">
                  {agentsError}
                </Notice>
              ) : agents === null ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : agents.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#2a2a3a] px-4 py-8 text-center">
                  <Bot size={28} className="mx-auto text-[#2a2a3a]" />
                  <p className="mt-2 text-sm text-[#8888aa]">No agents yet</p>
                  <Link href="/agents/new" className="mt-1 inline-block text-xs text-indigo-400 hover:text-indigo-300">
                    Create an agent first
                  </Link>
                </div>
              ) : visibleAgents.length === 0 ? (
                <p className="py-6 text-center text-sm text-[#66667f]">No agents match “{query}”.</p>
              ) : (
                <div
                  role="radiogroup"
                  aria-label="Agent"
                  className="max-h-72 space-y-1.5 overflow-y-auto pr-1"
                >
                  {visibleAgents.map((agent) => {
                    const linked = linkedTo.get(agent.phone_number);
                    const hasKey = Boolean(agent.api_key);
                    const disabled = Boolean(linked) || !hasKey;
                    const checked = selected === agent.phone_number;
                    return (
                      <label
                        key={agent.phone_number}
                        className={cn(
                          "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                          disabled
                            ? "cursor-not-allowed border-[#1a1a26] opacity-60"
                            : checked
                              ? "cursor-pointer border-indigo-500/60 bg-indigo-500/[0.07]"
                              : "cursor-pointer border-[#1e1e2e] hover:border-[#2a2a3a] hover:bg-[#11111a]"
                        )}
                      >
                        <input
                          type="radio"
                          name="billing-agent"
                          value={agent.phone_number}
                          checked={checked}
                          disabled={disabled}
                          onChange={() => {
                            setSelected(agent.phone_number);
                            setError("");
                          }}
                          className="peer sr-only"
                        />
                        <span
                          aria-hidden="true"
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500/70",
                            checked ? "border-indigo-400" : "border-[#3a3a4c]"
                          )}
                        >
                          {checked && <span className="h-2 w-2 rounded-full bg-indigo-400" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-white">{agent.agent_name}</span>
                          <span className="block font-mono text-xs text-[#8888aa]">{agent.phone_number}</span>
                        </span>
                        {linked ? (
                          <span className="shrink-0 text-right text-[11px] text-[#66667f]">
                            Already in
                            <span className="block max-w-[9rem] truncate text-[#a0a0bc]">{linked.label}</span>
                          </span>
                        ) : !hasKey ? (
                          <span className="flex shrink-0 items-center gap-1 text-[11px] text-amber-300/80">
                            <KeyRound size={11} /> No API key
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              )}
            </>
          ) : resolved ? (
            <>
              <div className="rounded-xl border border-[#262636] bg-[#0a0a0f] p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-indigo-500/20 bg-indigo-500/10">
                    <Building2 size={18} className="text-indigo-300" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-[#66667f]">AgentX organization</p>
                    <p className="font-mono text-sm text-white">#{resolved.organization_id}</p>
                  </div>
                </div>

                <div className="mt-4 rounded-lg border border-[#1e1e2e] bg-[#0d0d14] px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[#66667f]">
                    <Mail size={11} /> Owner email
                  </p>
                  {resolved.email ? (
                    <p className="mt-0.5 break-all text-[15px] font-medium text-white">{resolved.email}</p>
                  ) : (
                    <p className="mt-0.5 text-sm text-amber-300">No owner email on file</p>
                  )}
                </div>

                <dl className="mt-3 divide-y divide-[#1a1a26]">
                  <SummaryRow label="Current balance">
                    {formatMoney(resolved.balance_display, resolved.display_currency)}
                    {resolved.display_currency !== "USD" && (
                      <span className="ml-1.5 text-xs text-[#66667f]">{formatUsdPrecise(resolved.balance_usd)}</span>
                    )}
                  </SummaryRow>
                  <SummaryRow label="Customer sees balances in">{resolved.display_currency}</SummaryRow>
                  <SummaryRow label="Agent">
                    {selectedAgent?.agent_name}{" "}
                    <span className="font-mono text-xs text-[#66667f]">{selectedAgent?.phone_number}</span>
                  </SummaryRow>
                </dl>
              </div>

              {existingAccount ? (
                <Notice
                  tone="amber"
                  icon={<CircleAlert size={16} />}
                  title="This organization already has a billing account"
                  action={
                    <Link
                      href={`/billing/${existingAccount.organization_id}`}
                      className={buttonCls("secondary", "sm")}
                    >
                      Open {existingAccount.label}
                    </Link>
                  }
                >
                  Record payments on the existing account instead of creating a second one.
                </Notice>
              ) : (
                <>
                  {!resolved.email && (
                    <Notice tone="amber" icon={<CircleAlert size={16} />}>
                      There is no email to confirm against. Check the organization number with the customer before
                      recording payments.
                    </Notice>
                  )}
                  <div>
                    <label htmlFor="billing-account-label" className={labelCls}>
                      Account name
                    </label>
                    <input
                      id="billing-account-label"
                      data-autofocus
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      maxLength={80}
                      placeholder="Rehabb Care"
                      className={inputCls}
                    />
                    <p className="mt-1 text-xs text-[#44445a]">Shown in this console only.</p>
                  </div>
                </>
              )}
            </>
          ) : null}

          {error && (
            <Notice tone="rose" icon={<CircleAlert size={16} />} role="alert">
              {error}
            </Notice>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-[#1e1e2e] bg-[#0b0b11] px-6 py-4">
          <p className="flex items-center gap-1.5 text-[11px] text-[#55556b]">
            <ShieldCheck size={12} /> Keys stay on the server
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy} className={buttonCls("ghost")}>
              Cancel
            </button>
            {step === "choose" ? (
              <button
                type="button"
                onClick={handleResolve}
                disabled={!selectedAgent || resolving}
                className={buttonCls("primary")}
              >
                {resolving ? <Spinner /> : null}
                {resolving ? "Looking up…" : "Look up account"}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !resolved || Boolean(existingAccount)}
                className={buttonCls("primary")}
              >
                {saving ? <Spinner /> : null}
                {saving ? "Saving…" : "Save account"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
