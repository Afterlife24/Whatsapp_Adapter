import { Workflow } from "lucide-react";
import type { OrgWorkflow } from "@/lib/api";
import { Badge, CardHeader, cardCls } from "@/components/billing/ui";

/**
 * The organization's AgentPlatform workflows (agents). Display only — billing
 * is per-org, so every workflow here draws from the one wallet. No per-workflow
 * charge is shown.
 */
export default function WorkflowsCard({ workflows }: { workflows?: OrgWorkflow[] }) {
  const list = workflows ?? [];
  const active = list.filter((w) => w.status === "active").length;

  return (
    <section className={cardCls} aria-labelledby="workflows-heading">
      <CardHeader
        title={
          <span id="workflows-heading" className="flex items-center gap-2">
            <Workflow size={16} className="text-indigo-300" aria-hidden="true" />
            Agents in this organization
          </span>
        }
        description={
          list.length === 0
            ? "Agents and workflows that run under this account."
            : `${list.length} total · ${active} active · all draw from this one wallet`
        }
      />

      {list.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-[#55556b]">
          No agents or workflows in this organization yet.
        </p>
      ) : (
        <ul className="divide-y divide-[#16161f]">
          {list.map((wf) => {
            const isActive = wf.status === "active";
            return (
              <li key={wf.id} className="flex items-center gap-3 px-5 py-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#262636] bg-[#13131c] text-[#8888aa]"
                  aria-hidden="true"
                >
                  <Workflow size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-white">
                    {wf.name || `Workflow #${wf.id}`}
                  </span>
                  <span className="font-mono text-[11px] text-[#55556b]">#{wf.id}</span>
                </span>
                <Badge tone={isActive ? "emerald" : "slate"} dot pulse={isActive}>
                  {isActive ? "Active" : wf.status || "—"}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
