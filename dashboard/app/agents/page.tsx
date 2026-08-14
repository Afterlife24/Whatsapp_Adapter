"use client";

import { useEffect, useState } from "react";
import { getAgents, deleteAgent, type Agent } from "@/lib/api";
import Link from "next/link";
import { Plus, Pencil, Trash2, Bot } from "lucide-react";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = () => getAgents().then(setAgents).catch(console.error).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const handleDelete = async (phone: string, name: string) => {
    if (!confirm(`Delete agent "${name}"? This cannot be undone.`)) return;
    setDeleting(phone);
    try {
      await deleteAgent(phone);
      setAgents((prev) => prev.filter((a) => a.phone_number !== phone));
    } catch (e: any) {
      alert("Delete failed: " + e.message);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Agents</h1>
          <p className="text-sm text-[#666880] mt-1">Manage your WhatsApp AI agents</p>
        </div>
        <Link href="/agents/new"
          className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-500 transition-colors">
          <Plus size={16} /> Add Agent
        </Link>
      </div>

      {loading ? (
        <div className="text-center text-[#44445a] py-16 text-sm">Loading...</div>
      ) : agents.length === 0 ? (
        <div className="bg-[#0d0d14] rounded-xl border border-[#1e1e2e] p-16 text-center">
          <Bot size={40} className="text-[#2a2a3a] mx-auto mb-4" />
          <p className="text-[#8888aa] font-medium">No agents yet</p>
          <p className="text-[#44445a] text-sm mt-1">Add your first WhatsApp agent to get started.</p>
          <Link href="/agents/new"
            className="inline-flex items-center gap-2 mt-4 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-500 transition-colors">
            <Plus size={16} /> Add Agent
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {agents.map((a) => (
            <div key={a.phone_number} className="bg-[#0d0d14] rounded-xl border border-[#1e1e2e] p-5 flex items-center gap-4 hover:border-[#2a2a3a] transition-colors">
              <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
                <Bot size={22} className="text-indigo-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white">{a.agent_name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${a.is_active ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" : "bg-red-500/15 text-red-400 border-red-500/20"}`}>
                    {a.is_active ? "Active" : "Inactive"}
                  </span>
                  {a.followups_enabled && (
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20">
                      Follow-ups on
                    </span>
                  )}
                </div>
                <p className="text-sm text-[#8888aa] font-mono mt-0.5">{a.phone_number}</p>
                <div className="flex items-center gap-4 mt-1 text-xs text-[#44445a]">
                  <span>Greeting: {a.greeting_window_hours === 0 ? "Every message" : `Every ${a.greeting_window_hours}h`}</span>
                  <span>Delays: {a.followup_delays?.join(", ")}s</span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Link href={`/agents/${encodeURIComponent(a.phone_number)}`}
                  className="flex items-center gap-1.5 text-sm text-[#8888aa] border border-[#2a2a3a] px-3 py-1.5 rounded-lg hover:bg-[#1a1a26] hover:text-white transition-colors">
                  <Pencil size={13} /> Edit
                </Link>
                <button onClick={() => handleDelete(a.phone_number, a.agent_name)}
                  disabled={deleting === a.phone_number}
                  className="flex items-center gap-1.5 text-sm text-red-400 border border-red-500/20 px-3 py-1.5 rounded-lg hover:bg-red-500/10 transition-colors disabled:opacity-50">
                  <Trash2 size={13} />
                  {deleting === a.phone_number ? "..." : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
