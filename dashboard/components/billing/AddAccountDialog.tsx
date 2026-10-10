"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Building2,
  CircleAlert,
  Mail,
  Search,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react";
import {
  apiErrorMessage,
  createBillingAccount,
  listOrganizations,
  type BillingAccount,
  type OrgDirectoryEntry,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Notice,
  Skeleton,
  Spinner,
  buttonCls,
  focusRing,
  inputCls,
  labelCls,
} from "@/components/billing/ui";

interface Props {
  onClose: () => void;
  onCreated: (account: BillingAccount) => void;
}

/**
 * Pick an AgentX organization to add as a billing account. Billing is
 * per-org: the operator chooses the org (shown as "email · Org #id"), not an
 * agent/workflow. Render only while open — each mount starts clean.
 */
export default function AddAccountDialog({ onClose, onCreated }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const [orgs, setOrgs] = useState<OrgDirectoryEntry[] | null>(null);
  const [orgsError, setOrgsError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Load the org directory on open; lock scroll; restore focus on close.
  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    let current = true;
    listOrganizations()
      .then((list) => current && setOrgs(list))
      .catch((e) => current && setOrgsError(apiErrorMessage(e)));

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      current = false;
      document.body.style.overflow = originalOverflow;
      restoreFocus.current?.focus?.();
    };
  }, []);

  // Autofocus the search once orgs arrive.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [orgs]);

  // Escape closes; Tab stays within the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
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
  }, [saving, onClose]);

  const visibleOrgs = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = orgs ?? [];
    if (!q) return list;
    return list.filter(
      (o) =>
        (o.email ?? "").toLowerCase().includes(q) ||
        String(o.organization_id).includes(q) ||
        `org #${o.organization_id}`.includes(q)
    );
  }, [orgs, query]);

  const selectedOrg = orgs?.find((o) => o.organization_id === selected) ?? null;

  const handleSave = async () => {
    if (!selectedOrg || selectedOrg.already_added) return;
    setError("");
    setSaving(true);
    try {
      const account = await createBillingAccount(
        selectedOrg.organization_id,
        label.trim() || selectedOrg.email || `Org #${selectedOrg.organization_id}`
      );
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
        onClick={() => !saving && onClose()}
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
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-white">
              Add a billing account
            </h2>
            <p id={descriptionId} className="mt-1 text-sm text-[#8888aa]">
              Pick the organization to bill. You pay per organization — every agent and workflow in it draws
              from one wallet.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className={cn("rounded-md p-1 text-[#66667f] hover:bg-[#1a1a26] hover:text-white", focusRing)}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-6 py-5">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#44445a]" />
            <input
              data-autofocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by email or org id"
              aria-label="Search organizations"
              className={cn(inputCls, "pl-9")}
            />
          </div>

          {orgsError ? (
            <Notice tone="rose" icon={<CircleAlert size={16} />} title="Couldn't load organizations" role="alert">
              {orgsError}
            </Notice>
          ) : orgs === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : orgs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#2a2a3a] px-4 py-8 text-center">
              <Building2 size={28} className="mx-auto text-[#2a2a3a]" />
              <p className="mt-2 text-sm text-[#8888aa]">No organizations found</p>
            </div>
          ) : visibleOrgs.length === 0 ? (
            <p className="py-6 text-center text-sm text-[#66667f]">No organizations match “{query}”.</p>
          ) : (
            <div role="radiogroup" aria-label="Organization" className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
              {visibleOrgs.map((org) => {
                const disabled = org.already_added;
                const checked = selected === org.organization_id;
                return (
                  <label
                    key={org.organization_id}
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
                      name="billing-org"
                      value={org.organization_id}
                      checked={checked}
                      disabled={disabled}
                      onChange={() => {
                        setSelected(org.organization_id);
                        setLabel(org.email ?? `Org #${org.organization_id}`);
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
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#262636] bg-[#13131c] text-[#8888aa]">
                      <Building2 size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-white">
                        <Mail size={12} className="shrink-0 text-[#55556b]" aria-hidden="true" />
                        <span className="truncate">{org.email ?? "No owner email"}</span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-[#66667f]">
                        <span className="font-mono">Org #{org.organization_id}</span>
                        <span aria-hidden="true">·</span>
                        <span className="flex items-center gap-1">
                          <Workflow size={11} aria-hidden="true" />
                          {org.workflow_count} workflow{org.workflow_count === 1 ? "" : "s"}
                        </span>
                      </span>
                    </span>
                    {disabled && (
                      <span className="shrink-0 text-[11px] text-[#66667f]">Already added</span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {/* Label for the chosen org */}
          {selectedOrg && !selectedOrg.already_added && (
            <div>
              <label htmlFor="billing-account-label" className={labelCls}>
                Account name
              </label>
              <input
                id="billing-account-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={80}
                placeholder={selectedOrg.email ?? `Org #${selectedOrg.organization_id}`}
                className={inputCls}
              />
              <p className="mt-1 text-xs text-[#44445a]">Shown in this console only.</p>
            </div>
          )}

          {error && (
            <Notice tone="rose" icon={<CircleAlert size={16} />} role="alert">
              {error}
            </Notice>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-[#1e1e2e] bg-[#0b0b11] px-6 py-4">
          <p className="flex items-center gap-1.5 text-[11px] text-[#55556b]">
            <ShieldCheck size={12} /> Per-organization billing
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={saving} className={buttonCls("ghost")}>
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !selectedOrg || selectedOrg.already_added}
              className={buttonCls("primary")}
            >
              {saving ? <Spinner /> : null}
              {saving ? "Saving…" : "Add account"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
