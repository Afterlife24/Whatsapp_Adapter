"use client";

import { useEffect, useState } from "react";
import { getAgents, getConversations, getHealth, type Agent, type Conversation } from "@/lib/api";
import { formatTime, formatPhone } from "@/lib/utils";
import { Bot, MessageSquare, UserCheck, Activity } from "lucide-react";
import Link from "next/link";

export default function OverviewPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [health, setHealth] = useState<{ status: string; mongo: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getAgents(), getConversations(), getHealth()])
      .then(([a, c, h]) => { setAgents(a); setConvos(c); setHealth(h); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const takeoverConvos = convos.filter((c) => c.human_takeover);
  const activeAgents = agents.filter((a) => a.is_active);

  const stats = [
    { label: "Active Agents", value: activeAgents.length, icon: Bot, color: "text-indigo-400", bg: "bg-indigo-500/10 border-indigo-500/20" },
    { label: "Total Conversations", value: convos.length, icon: MessageSquare, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
    { label: "Human Takeover", value: takeoverConvos.length, icon: UserCheck, color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
    {
      label: "System Status",
      value: health?.status === "ok" ? "Online" : "Offline",
      icon: Activity,
      color: health?.status === "ok" ? "text-emerald-400" : "text-red-400",
      bg: health?.status === "ok" ? "bg-emerald-500/10 border-emerald-500/20" : "bg-red-500/10 border-red-500/20",
    },
  ];

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-[#44445a] text-sm">Loading...</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Overview</h1>
        <p className="text-sm text-[#6666880] mt-1 text-[#666880]">Afterlife WhatsApp dashboard</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div key={s.label} className={`rounded-xl border p-4 bg-[#0d0d14] ${s.bg}`}>
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${s.bg}`}>
              <s.icon size={18} className={s.color} />
            </div>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-[#666880] mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Agents table */}
      <div className="bg-[#0d0d14] rounded-xl border border-[#1e1e2e]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e1e2e]">
          <h2 className="font-semibold text-white">Agents</h2>
          <Link href="/agents/new" className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-500 transition-colors">
            + Add Agent
          </Link>
        </div>
        {agents.length === 0 ? (
          <div className="p-8 text-center text-[#44445a] text-sm">
            No agents yet.{" "}
            <Link href="/agents/new" className="text-indigo-400 underline">Add your first agent</Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#1e1e2e] text-left text-xs text-[#44445a] uppercase tracking-wide">
                <th className="px-5 py-3">Agent</th>
                <th className="px-5 py-3">Phone</th>
                <th className="px-5 py-3">Follow-ups</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.phone_number} className="border-b border-[#1a1a26] hover:bg-[#13131c] transition-colors">
                  <td className="px-5 py-3 font-medium text-white">{a.agent_name}</td>
                  <td className="px-5 py-3 text-[#8888aa] font-mono text-xs">{a.phone_number}</td>
                  <td className="px-5 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${a.followups_enabled ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20" : "bg-[#1e1e2e] text-[#44445a]"}`}>
                      {a.followups_enabled ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${a.is_active ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20" : "bg-red-500/15 text-red-400 border border-red-500/20"}`}>
                      {a.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <Link href={`/agents/${encodeURIComponent(a.phone_number)}`} className="text-indigo-400 hover:text-indigo-300 text-xs">Edit</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent conversations */}
      <div className="bg-[#0d0d14] rounded-xl border border-[#1e1e2e]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e1e2e]">
          <h2 className="font-semibold text-white">Recent Conversations</h2>
          <Link href="/conversations" className="text-xs text-indigo-400 hover:text-indigo-300">View all</Link>
        </div>
        {convos.length === 0 ? (
          <div className="p-8 text-center text-[#44445a] text-sm">No conversations yet.</div>
        ) : (
          <div className="divide-y divide-[#1a1a26]">
            {convos.slice(0, 8).map((c) => (
              <Link key={c.phone_number} href={`/conversations?phone=${encodeURIComponent(c.phone_number)}`}
                className="flex items-center gap-4 px-5 py-3 hover:bg-[#13131c] transition-colors">
                <div className="w-9 h-9 rounded-full bg-[#1e1e2e] flex items-center justify-center text-[#8888aa] text-sm font-semibold flex-shrink-0">
                  {formatPhone(c.phone_number).slice(-2)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white text-sm">{formatPhone(c.phone_number)}</span>
                    {c.human_takeover && (
                      <span className="text-xs bg-orange-500/15 text-orange-400 border border-orange-500/20 px-1.5 py-0.5 rounded-full">Takeover</span>
                    )}
                  </div>
                  <p className="text-xs text-[#44445a] truncate mt-0.5">{c.last_message}</p>
                </div>
                <span className="text-xs text-[#44445a] flex-shrink-0">{formatTime(c.last_message_time)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
