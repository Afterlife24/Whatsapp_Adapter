"use client";

import { useEffect, useState } from "react";
import { getLeads, getAgents, type Lead, type Agent } from "@/lib/api";
import { formatTime } from "@/lib/utils";
import { Users, MapPin, RefreshCw, ExternalLink, ChevronDown } from "lucide-react";

const CONCERN_COLORS: Record<string, string> = {
  "Back & Neck Pain":        "bg-blue-500/15 text-blue-400 border-blue-500/20",
  "Knee & Ankle Pain":       "bg-purple-500/15 text-purple-400 border-purple-500/20",
  "Shoulder & Elbow Rehab":  "bg-indigo-500/15 text-indigo-400 border-indigo-500/20",
  "Post-Surgery Rehab":      "bg-orange-500/15 text-orange-400 border-orange-500/20",
  "Paralysis / Stroke Rehab":"bg-red-500/15 text-red-400 border-red-500/20",
  "Geriatric Physiotherapy": "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  "Sports Injury Rehab":     "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  "Other":                   "bg-gray-500/15 text-gray-400 border-gray-500/20",
};

function concernColor(concern: string): string {
  for (const [key, cls] of Object.entries(CONCERN_COLORS)) {
    if (concern?.toLowerCase().includes(key.split(" ")[0].toLowerCase())) return cls;
  }
  return "bg-[#1e1e2e] text-[#8888aa] border-[#2a2a3a]";
}

function getMapsUrl(lead: Lead): string | null {
  const u = lead.user_location;
  return u?.startsWith("http") ? u : null;
}

function getLocality(lead: Lead): string {
  return lead.locality || lead.city || lead.city_locality || lead.location || "—";
}

export default function LeadsPage() {
  const [leads, setLeads]     = useState<Lead[]>([]);
  const [agents, setAgents]   = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState("");
  const [filterConcern, setFilterConcern] = useState("all");

  // Load agents once
  useEffect(() => { getAgents().then(setAgents).catch(console.error); }, []);

  // Load leads whenever agent selection changes
  const load = (agentNum?: string) => {
    setLoading(true);
    getLeads(agentNum === "all" ? undefined : agentNum)
      .then(setLeads)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(selectedAgent); }, [selectedAgent]);

  const handleAgentChange = (val: string) => {
    setSelectedAgent(val);
    setSearch("");
    setFilterConcern("all");
  };

  // Unique concerns for filter dropdown
  const concerns = Array.from(new Set(leads.map((l) => l.concern).filter(Boolean)));

  const filtered = leads.filter((l) => {
    const matchSearch =
      !search ||
      l.patient_name?.toLowerCase().includes(search.toLowerCase()) ||
      l.phone_number?.includes(search) ||
      l.concern?.toLowerCase().includes(search.toLowerCase()) ||
      l.locality?.toLowerCase().includes(search.toLowerCase()) ||
      l.city?.toLowerCase().includes(search.toLowerCase());
    const matchConcern = filterConcern === "all" || l.concern === filterConcern;
    return matchSearch && matchConcern;
  });

  // Stats
  const withMaps    = leads.filter((l) => getMapsUrl(l)).length;
  const concernMap  = leads.reduce((a, l) => { if (l.concern) a[l.concern] = (a[l.concern] || 0) + 1; return a; }, {} as Record<string, number>);
  const topConcern  = Object.entries(concernMap).sort((a, b) => b[1] - a[1])[0];
  const activeAgent = agents.find((a) => a.phone_number === selectedAgent);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Leads</h1>
          <p className="text-sm text-[#666880] mt-1">Captured appointment requests</p>
        </div>
        <button onClick={() => load(selectedAgent)}
          className="flex items-center gap-1.5 text-sm text-[#8888aa] border border-[#2a2a3a] px-3 py-2 rounded-lg hover:bg-[#1a1a26] hover:text-white transition-colors">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Agent selector */}
      <div className="bg-[#0d0d14] rounded-xl border border-[#1e1e2e] p-4">
        <p className="text-xs text-[#44445a] mb-2 font-medium uppercase tracking-wide">Filter by Agent</p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => handleAgentChange("all")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              selectedAgent === "all"
                ? "bg-indigo-600 text-white"
                : "bg-[#13131c] text-[#8888aa] border border-[#2a2a3a] hover:text-white hover:bg-[#1a1a26]"
            }`}
          >
            All Agents ({leads.length})
          </button>
          {agents.map((a) => (
            <button
              key={a.phone_number}
              onClick={() => handleAgentChange(a.phone_number)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                selectedAgent === a.phone_number
                  ? "bg-indigo-600 text-white"
                  : "bg-[#13131c] text-[#8888aa] border border-[#2a2a3a] hover:text-white hover:bg-[#1a1a26]"
              }`}
            >
              {a.agent_name}
            </button>
          ))}
        </div>
        {activeAgent && (
          <p className="text-xs text-[#44445a] mt-2">
            {activeAgent.agent_name} · {activeAgent.phone_number}
          </p>
        )}
      </div>

      {/* Stats */}
      {leads.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-[#0d0d14] rounded-xl border border-[#1e1e2e] p-4">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-2">
              <Users size={15} className="text-indigo-400" />
            </div>
            <div className="text-2xl font-bold text-white">{leads.length}</div>
            <div className="text-xs text-[#666880] mt-0.5">Total Leads</div>
          </div>
          <div className="bg-[#0d0d14] rounded-xl border border-[#1e1e2e] p-4">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-2">
              <MapPin size={15} className="text-emerald-400" />
            </div>
            <div className="text-2xl font-bold text-white">{withMaps}</div>
            <div className="text-xs text-[#666880] mt-0.5">With Maps Location</div>
          </div>
          <div className="bg-[#0d0d14] rounded-xl border border-[#1e1e2e] p-4">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 border ${topConcern ? concernColor(topConcern[0]) : "bg-[#1e1e2e] border-[#2a2a3a]"}`}>
              <span className="text-[10px] font-bold">#1</span>
            </div>
            <div className="text-sm font-bold text-white truncate">{topConcern?.[0] || "—"}</div>
            <div className="text-xs text-[#666880] mt-0.5">Top concern ({topConcern?.[1] || 0})</div>
          </div>
        </div>
      )}

      {/* Search + concern filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, phone, concern, location..."
          className="flex-1 min-w-[200px] bg-[#0d0d14] border border-[#1e1e2e] rounded-lg px-3 py-2 text-sm text-white placeholder-[#44445a] focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20"
        />
        <select
          value={filterConcern}
          onChange={(e) => setFilterConcern(e.target.value)}
          className="bg-[#0d0d14] border border-[#1e1e2e] rounded-lg px-3 py-2 text-sm text-[#8888aa] focus:outline-none focus:border-indigo-500/50 cursor-pointer"
        >
          <option value="all">All Concerns</option>
          {concerns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="bg-[#0d0d14] rounded-xl border border-[#1e1e2e] overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-[#44445a] text-sm">Loading leads...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <Users size={36} className="text-[#2a2a3a] mx-auto mb-3" />
            <p className="text-[#44445a] text-sm">
              {leads.length === 0
                ? `No leads for ${activeAgent?.agent_name || "this agent"} yet.`
                : "No leads match your search."}
            </p>
            {leads.length === 0 && (
              <p className="text-xs text-[#2a2a3a] mt-1">
                Leads are captured when the workflow completes via the webhook node.
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1a1a26] text-left text-xs text-[#44445a] uppercase tracking-wide">
                  <th className="px-5 py-3">Patient</th>
                  <th className="px-5 py-3">Phone</th>
                  <th className="px-5 py-3">Concern</th>
                  <th className="px-5 py-3">Location</th>
                  <th className="px-5 py-3">Maps</th>
                  {selectedAgent === "all" && <th className="px-5 py-3">Agent</th>}
                  <th className="px-5 py-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((lead, idx) => {
                  const mapsUrl = getMapsUrl(lead);
                  const agentName = agents.find((a) =>
                    a.phone_number === lead.agent_number ||
                    a.phone_number === lead.agent_number?.replace("whatsapp:", "")
                  )?.agent_name;

                  return (
                    <tr key={idx} className="border-b border-[#131320] hover:bg-[#111120] transition-colors">
                      {/* Patient */}
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-full bg-indigo-600/20 border border-indigo-500/20 flex items-center justify-center text-xs font-semibold text-indigo-400 flex-shrink-0">
                            {(lead.patient_name || "?").charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-white">
                            {lead.patient_name || <span className="text-[#44445a]">Unknown</span>}
                          </span>
                        </div>
                      </td>
                      {/* Phone */}
                      <td className="px-5 py-3.5 font-mono text-xs text-[#8888aa]">
                        {lead.phone_number?.replace("whatsapp:", "") || "—"}
                      </td>
                      {/* Concern */}
                      <td className="px-5 py-3.5">
                        {lead.concern ? (
                          <span className={`text-xs px-2 py-1 rounded-lg border font-medium ${concernColor(lead.concern)}`}>
                            {lead.concern}
                          </span>
                        ) : <span className="text-[#44445a] text-xs">—</span>}
                      </td>
                      {/* Location */}
                      <td className="px-5 py-3.5 text-[#c0c0d8] text-sm">
                        {getLocality(lead)}
                      </td>
                      {/* Maps */}
                      <td className="px-5 py-3.5">
                        {mapsUrl ? (
                          <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors">
                            <MapPin size={12} /> View <ExternalLink size={10} />
                          </a>
                        ) : <span className="text-[#44445a] text-xs">—</span>}
                      </td>
                      {/* Agent (only when showing all) */}
                      {selectedAgent === "all" && (
                        <td className="px-5 py-3.5">
                          <span className="text-xs bg-[#1a1a26] text-[#8888aa] border border-[#2a2a3a] px-2 py-0.5 rounded-full">
                            {agentName || lead.agent_number?.replace("whatsapp:", "") || "—"}
                          </span>
                        </td>
                      )}
                      {/* Date */}
                      <td className="px-5 py-3.5 text-xs text-[#44445a]">
                        {formatTime(lead.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {filtered.length > 0 && (
        <p className="text-xs text-[#44445a] text-right">
          Showing {filtered.length} of {leads.length} lead{leads.length !== 1 ? "s" : ""}
        </p>
      )}
    </div>
  );
}
