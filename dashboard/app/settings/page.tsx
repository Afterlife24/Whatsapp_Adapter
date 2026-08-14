"use client";

import { useEffect, useState } from "react";
import { getHealth, getAdapterUrl, setAdapterUrl } from "@/lib/api";
import { CheckCircle, XCircle, RefreshCw, Save, Pencil } from "lucide-react";

export default function SettingsPage() {
  const [health, setHealth] = useState<{ status: string; mongo: boolean } | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [adapterUrl, setAdapterUrlState] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlSaved, setUrlSaved] = useState(false);

  useEffect(() => {
    const url = getAdapterUrl();
    setAdapterUrlState(url);
    setUrlInput(url);
    checkHealth();
  }, []);

  const checkHealth = () => {
    setHealthLoading(true);
    getHealth()
      .then(setHealth)
      .catch(() => setHealth({ status: "error", mongo: false }))
      .finally(() => setHealthLoading(false));
  };

  const handleSaveUrl = () => {
    const trimmed = urlInput.trim().replace(/\/$/, "");
    if (!trimmed) return;
    setAdapterUrl(trimmed);
    setAdapterUrlState(trimmed);
    setEditingUrl(false);
    setUrlSaved(true);
    setTimeout(() => setUrlSaved(false), 2000);
    // Re-check health with new URL
    setTimeout(() => checkHealth(), 300);
  };

  const sectionCls = "bg-[#0d0d14] rounded-xl border border-[#1e1e2e] p-5 space-y-4";

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-[#666880] mt-1">Adapter configuration and health</p>
      </div>

      {/* Adapter URL — editable */}
      <section className={sectionCls}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-white">Adapter URL</h2>
          {urlSaved && (
            <span className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 rounded-lg">
              ✓ Saved
            </span>
          )}
        </div>

        {editingUrl ? (
          <div className="space-y-3">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveUrl()}
              placeholder="https://your-domain.com or http://localhost:8001"
              className="w-full bg-[#0a0a0f] border border-indigo-500/50 rounded-lg px-3 py-2.5 text-sm text-white font-mono placeholder-[#44445a] focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button onClick={handleSaveUrl}
                className="flex items-center gap-1.5 text-sm bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-500 transition-colors">
                <Save size={13} /> Save
              </button>
              <button onClick={() => { setEditingUrl(false); setUrlInput(adapterUrl); }}
                className="text-sm text-[#44445a] hover:text-white transition-colors px-3 py-2">
                Cancel
              </button>
            </div>
            <p className="text-xs text-[#44445a]">
              Saved in browser localStorage — no restart needed. Works for both local and production.
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex-1 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg px-4 py-2.5 font-mono text-sm text-indigo-400 truncate">
              {adapterUrl}
            </div>
            <button onClick={() => setEditingUrl(true)}
              className="flex items-center gap-1.5 text-sm text-[#8888aa] border border-[#2a2a3a] px-3 py-2 rounded-lg hover:bg-[#1a1a26] hover:text-white transition-colors flex-shrink-0">
              <Pencil size={13} /> Edit
            </button>
          </div>
        )}

        <div className="text-xs text-[#44445a] space-y-1">
          <p><span className="text-[#8888aa]">Local dev:</span> http://localhost:8001</p>
          <p><span className="text-[#8888aa]">Production:</span> https://your-domain.com (set once, remembered)</p>
        </div>
      </section>

      {/* Health */}
      <section className={sectionCls}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-white">System Health</h2>
          <button onClick={checkHealth}
            className="flex items-center gap-1.5 text-xs text-[#8888aa] border border-[#2a2a3a] px-3 py-1.5 rounded-lg hover:bg-[#1a1a26] hover:text-white transition-colors">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
        {healthLoading ? (
          <p className="text-sm text-[#44445a]">Checking...</p>
        ) : (
          <div className="space-y-0">
            <div className="flex items-center justify-between py-3 border-b border-[#1a1a26]">
              <div>
                <span className="text-sm text-[#c0c0d8]">Adapter API</span>
                <p className="text-xs text-[#44445a] font-mono mt-0.5">{adapterUrl}/health</p>
              </div>
              {health?.status === "ok" ? (
                <span className="flex items-center gap-1.5 text-emerald-400 text-sm font-medium">
                  <CheckCircle size={15} /> Online
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-red-400 text-sm font-medium">
                  <XCircle size={15} /> Offline
                </span>
              )}
            </div>
            <div className="flex items-center justify-between py-3">
              <span className="text-sm text-[#c0c0d8]">MongoDB</span>
              {health?.mongo ? (
                <span className="flex items-center gap-1.5 text-emerald-400 text-sm font-medium">
                  <CheckCircle size={15} /> Connected
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-red-400 text-sm font-medium">
                  <XCircle size={15} /> Not connected
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Webhooks */}
      <section className={sectionCls}>
        <h2 className="font-semibold text-white">Webhook Endpoints</h2>
        <div className="space-y-0">
          {[
            { label: "Twilio WhatsApp Webhook", path: "/whatsapp", method: "POST", hint: "Set this in Twilio console" },
            { label: "Afterlife Lead Data Webhook", path: "/webhook/lead-data", method: "POST", hint: "Set this in Afterlife workflow webhook node" },
          ].map((w) => (
            <div key={w.path} className="py-3 border-b border-[#1a1a26] last:border-0">
              <div className="flex items-center justify-between">
                <p className="font-medium text-[#e0e0f0] text-sm">{w.label}</p>
                <span className="text-xs bg-indigo-500/15 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded font-mono">{w.method}</span>
              </div>
              <p className="text-xs text-indigo-400/70 font-mono mt-1 break-all">{adapterUrl}{w.path}</p>
              <p className="text-xs text-[#44445a] mt-0.5">{w.hint}</p>
            </div>
          ))}
        </div>
      </section>

      {/* About */}
      <section className={sectionCls}>
        <h2 className="font-semibold text-white">About</h2>
        <div className="space-y-1.5 text-sm text-[#8888aa]">
          <p>Afterlife WhatsApp Adapter v2 — Dynamic MongoDB agent config</p>
          <p className="text-xs text-[#44445a]">
            To add a new agent: Agents → Add Agent → fill in phone number, API key, workflow UUID. No restart needed.
          </p>
        </div>
      </section>
    </div>
  );
}
