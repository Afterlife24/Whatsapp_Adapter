"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getAgent, updateAgent, createAgent, resetQuota, type Agent } from "@/lib/api";
import { ArrowLeft, Save, Plus, X, RefreshCw } from "lucide-react";
import Link from "next/link";

const DEFAULT_AGENT: Partial<Agent> = {
  phone_number: "",
  agent_name: "",
  api_key: "",
  trigger_path: "",
  followups_enabled: false,
  followup_delays: [300, 900, 1800],
  followup_messages: ["", "", ""],
  greeting_message: "",
  greeting_image_url: "",
  greeting_window_hours: 12,
  store_leads: false,
  quota_enabled: false,
  quota_limit: 500,
  quota_used: 0,
};

const DELAY_PRESETS = [
  { label: "1 min", value: 60 },
  { label: "5 min", value: 300 },
  { label: "15 min", value: 900 },
  { label: "30 min", value: 1800 },
  { label: "1 hr", value: 3600 },
  { label: "3 hr", value: 10800 },
  { label: "6 hr", value: 21600 },
  { label: "12 hr", value: 43200 },
  { label: "24 hr", value: 86400 },
];

function formatDelay(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

const inputCls = "w-full bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg px-3 py-2 text-sm text-white placeholder-[#44445a] focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
const labelCls = "block text-xs font-medium text-[#8888aa] mb-1";
const sectionCls = "bg-[#0d0d14] rounded-xl border border-[#1e1e2e] p-5 space-y-4";

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const isNew = params.phone === "new";
  const phoneParam = isNew ? "" : decodeURIComponent(params.phone as string);

  const [form, setForm] = useState<Partial<Agent>>(DEFAULT_AGENT);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [newDelay, setNewDelay] = useState("");
  const [resettingQuota, setResettingQuota] = useState(false);

  useEffect(() => {
    if (!isNew) {
      getAgent(phoneParam)
        .then(setForm)
        .catch(() => setError("Agent not found"))
        .finally(() => setLoading(false));
    }
  }, [phoneParam, isNew]);

  const set = (key: keyof Agent, val: any) => setForm((prev) => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    setError(""); setSuccess(""); setSaving(true);
    try {
      if (isNew) { await createAgent(form); router.push("/agents"); }
      else { await updateAgent(phoneParam, form); setSuccess("Saved!"); setTimeout(() => setSuccess(""), 3000); }
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const addDelay = (val: number) => {
    const d = [...(form.followup_delays || [])];
    if (!d.includes(val)) { d.push(val); d.sort((a, b) => a - b); set("followup_delays", d); }
  };
  const removeDelay = (val: number) => set("followup_delays", (form.followup_delays || []).filter((d) => d !== val));  const addCustomDelay = () => { const v = parseInt(newDelay); if (!isNaN(v) && v > 0) { addDelay(v); setNewDelay(""); } };

  const handleResetQuota = async () => {
    if (!confirm("Reset quota to 0? This will allow messages again.")) return;
    setResettingQuota(true);
    try {
      await resetQuota(phoneParam);
      setForm((prev) => ({ ...prev, quota_used: 0 }));
      setSuccess("Quota reset to 0!");
      setTimeout(() => setSuccess(""), 3000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setResettingQuota(false);
    }
  };

  if (loading) return <div className="p-6 text-[#44445a] text-sm">Loading...</div>;

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/agents" className="text-[#44445a] hover:text-white transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white">{isNew ? "New Agent" : form.agent_name || "Edit Agent"}</h1>
          <p className="text-sm text-[#666880] mt-0.5">{isNew ? "Configure a new WhatsApp agent" : phoneParam}</p>
        </div>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm">{error}</div>}
      {success && <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-4 py-3 rounded-lg text-sm">{success}</div>}

      {/* Basic Info */}
      <section className={sectionCls}>
        <h2 className="font-semibold text-white">Basic Info</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Agent Name</label>
            <input value={form.agent_name || ""} onChange={(e) => set("agent_name", e.target.value)} placeholder="Rehabb Care" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>WhatsApp Number</label>
            <input value={form.phone_number || ""} onChange={(e) => set("phone_number", e.target.value)} placeholder="+17178976546"
              className={inputCls} />
            {!isNew && <p className="text-xs text-[#44445a] mt-1">Changing the number will create a new agent entry.</p>}
          </div>
        </div>
      </section>

      {/* Afterlife Config */}
      <section className={sectionCls}>
        <h2 className="font-semibold text-white">Afterlife Config</h2>
        <div>
          <label className={labelCls}>API Key</label>
          <input value={form.api_key || ""} onChange={(e) => set("api_key", e.target.value)} placeholder="dgr_xxx..." type="password" className={`${inputCls} font-mono`} />
        </div>
        <div>
          <label className={labelCls}>Workflow UUID (Trigger Path)</label>
          <input value={form.trigger_path || ""} onChange={(e) => set("trigger_path", e.target.value)} placeholder="a7279869-d57c-4e60-884e-7ffddbf8ae1f" className={`${inputCls} font-mono`} />
        </div>
      </section>

      {/* Greeting */}
      <section className={sectionCls}>
        <h2 className="font-semibold text-white">Greeting Message</h2>

        {/* Image URL */}
        <div>
          <label className={labelCls}>Greeting Image URL <span className="text-[#44445a] font-normal">(optional)</span></label>
          <input
            value={form.greeting_image_url || ""}
            onChange={(e) => set("greeting_image_url", e.target.value)}
            placeholder="https://your-cdn.com/banner.jpg"
            className={inputCls}
          />
          {form.greeting_image_url && (
            <div className="mt-2 rounded-lg overflow-hidden border border-[#2a2a3a] max-w-xs">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={form.greeting_image_url}
                alt="Greeting preview"
                className="w-full object-cover max-h-40"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </div>
          )}
          <p className="text-xs text-[#44445a] mt-1">
            Image sent first, then greeting text. Must be a publicly accessible URL (jpg/png/gif).
          </p>
        </div>

        {/* Greeting text */}
        <div>
          <label className={labelCls}>Greeting Text</label>
          <textarea value={form.greeting_message || ""} onChange={(e) => set("greeting_message", e.target.value)}
            placeholder={"Greetings from Rehabb Care! 👋\n\nMay I ask where you are from and your name?"} rows={4}
            className={`${inputCls} resize-none`} />
          <p className="text-xs text-[#44445a] mt-1">Leave empty to disable greeting.</p>
        </div>

        {/* Greeting window */}
        <div>
          <label className={labelCls}>Greeting Window (hours)</label>
          <div className="flex items-center gap-3">
            <input type="number" min={0} value={form.greeting_window_hours ?? 12}
              onChange={(e) => set("greeting_window_hours", parseInt(e.target.value) || 0)}
              className={`${inputCls} w-24`} />
            <span className="text-xs text-[#44445a]">
              {form.greeting_window_hours === 0
                ? "⚡ Greet on every message (testing mode)"
                : `Greet if no agent message in last ${form.greeting_window_hours}h`}
            </span>
          </div>
        </div>
      </section>

      {/* Follow-ups */}
      <section className={sectionCls}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-white">Follow-up Messages</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[#44445a]">Enable</span>
            <button
              type="button"
              onClick={() => set("followups_enabled", !form.followups_enabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none ${
                form.followups_enabled ? "bg-indigo-600" : "bg-[#2a2a3a]"
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
                form.followups_enabled ? "translate-x-6" : "translate-x-1"
              }`} />
            </button>
          </div>
        </div>
        <div>
          <label className={labelCls}>Follow-up Delays &amp; Messages</label>
          <p className="text-xs text-[#44445a] mb-3">
            Leave message empty → AI generated through Afterlife (contextual).<br/>
            Set message → sent directly as custom text (Afterlife still called to keep session in sync).
          </p>

          {/* Per-delay rows */}
          <div className="space-y-3 mb-4">
            {(form.followup_delays || []).map((d, idx) => {
              const messages = form.followup_messages || [];
              const msg = messages[idx] || "";
              return (
                <div key={d} className="bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-indigo-400">
                      Follow-up {idx + 1} — after {formatDelay(d)}
                    </span>
                    <button onClick={() => {
                      removeDelay(d);
                      const msgs = [...(form.followup_messages || [])];
                      msgs.splice(idx, 1);
                      set("followup_messages", msgs);
                    }} className="text-[#44445a] hover:text-red-400 transition-colors">
                      <X size={13} />
                    </button>
                  </div>
                  <textarea
                    value={msg}
                    onChange={(e) => {
                      const msgs = [...(form.followup_messages || [])];
                      while (msgs.length <= idx) msgs.push("");
                      msgs[idx] = e.target.value;
                      set("followup_messages", msgs);
                    }}
                    placeholder="Leave empty for AI generated follow-up..."
                    rows={2}
                    className={`${inputCls} resize-none text-xs`}
                  />
                  <p className="text-[10px] text-[#44445a]">
                    {msg.trim() ? "📝 Custom text — will override AI reply" : "🤖 AI generated — Afterlife will create contextual message"}
                  </p>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-[#44445a] mb-2">Add preset:</p>
          <div className="flex flex-wrap gap-2 mb-3">
            {DELAY_PRESETS.map((p) => (
              <button key={p.value} onClick={() => {
                addDelay(p.value);
                const msgs = [...(form.followup_messages || [])];
                msgs.push("");
                set("followup_messages", msgs);
              }}
                className="text-xs border border-[#2a2a3a] px-2.5 py-1 rounded-lg hover:bg-[#1a1a26] text-[#8888aa] hover:text-white transition-colors">
                {p.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input type="number" value={newDelay} onChange={(e) => setNewDelay(e.target.value)}
              placeholder="Custom (seconds)"
              className={`${inputCls} w-40`}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addCustomDelay();
                  const msgs = [...(form.followup_messages || [])];
                  msgs.push("");
                  set("followup_messages", msgs);
                }
              }} />
            <button onClick={() => {
              addCustomDelay();
              const msgs = [...(form.followup_messages || [])];
              msgs.push("");
              set("followup_messages", msgs);
            }}
              className="flex items-center gap-1 text-xs border border-[#2a2a3a] text-[#8888aa] px-3 py-1.5 rounded-lg hover:bg-[#1a1a26] hover:text-white transition-colors">
              <Plus size={12} /> Add
            </button>
          </div>
        </div>
      </section>

      {/* Quota / Billing */}
      <section className={sectionCls}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-white">Message Quota</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[#44445a]">Enable limit</span>
            <button
              type="button"
              onClick={() => set("quota_enabled", !form.quota_enabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none ${
                form.quota_enabled ? "bg-indigo-600" : "bg-[#2a2a3a]"
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
                form.quota_enabled ? "translate-x-6" : "translate-x-1"
              }`} />
            </button>
          </div>
        </div>

        {form.quota_enabled && (
          <>
            {/* Usage bar */}
            {!isNew && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#8888aa]">Usage this period</span>
                  <span className={`font-mono font-semibold ${
                    (form.quota_used ?? 0) >= (form.quota_limit ?? 500)
                      ? "text-red-400"
                      : (form.quota_used ?? 0) >= (form.quota_limit ?? 500) * 0.8
                      ? "text-orange-400"
                      : "text-emerald-400"
                  }`}>
                    {form.quota_used ?? 0} / {form.quota_limit ?? 500} msgs
                  </span>
                </div>
                <div className="w-full bg-[#1a1a28] rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                      (form.quota_used ?? 0) >= (form.quota_limit ?? 500)
                        ? "bg-red-500"
                        : (form.quota_used ?? 0) >= (form.quota_limit ?? 500) * 0.8
                        ? "bg-orange-500"
                        : "bg-emerald-500"
                    }`}
                    style={{
                      width: `${Math.min(100, ((form.quota_used ?? 0) / (form.quota_limit ?? 500)) * 100)}%`,
                    }}
                  />
                </div>
                {(form.quota_used ?? 0) >= (form.quota_limit ?? 500) && (
                  <p className="text-xs text-red-400">⚠️ Quota exceeded — messages are being blocked.</p>
                )}
                {form.quota_reset_date && (
                  <p className="text-xs text-[#44445a]">Last reset: {form.quota_reset_date}</p>
                )}
              </div>
            )}

            {/* Limit input */}
            <div>
              <label className={labelCls}>Message Limit</label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={1}
                  value={form.quota_limit ?? 500}
                  onChange={(e) => set("quota_limit", parseInt(e.target.value) || 500)}
                  className={`${inputCls} w-32`}
                />
                <span className="text-xs text-[#44445a]">messages per period</span>
              </div>
            </div>

            {/* Reset button — only on edit */}
            {!isNew && (
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleResetQuota}
                  disabled={resettingQuota}
                  className="flex items-center gap-2 text-sm bg-[#1a1a28] border border-[#2a2a3a] text-[#8888aa] px-4 py-2 rounded-lg hover:bg-[#222230] hover:text-white transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={13} className={resettingQuota ? "animate-spin" : ""} />
                  {resettingQuota ? "Resetting..." : "Reset Quota to 0"}
                </button>
                <span className="text-xs text-[#44445a]">Use after payment/renewal</span>
              </div>
            )}
          </>
        )}

        {!form.quota_enabled && (
          <p className="text-xs text-[#44445a]">Unlimited messages — no quota enforced.</p>
        )}
      </section>

      {/* Lead Storage */}
      <section className={sectionCls}>
        <h2 className="font-semibold text-white">Lead Storage</h2>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={form.store_leads ?? false} onChange={(e) => set("store_leads", e.target.checked)}
            className="rounded border-[#2a2a3a] bg-[#0a0a0f] accent-indigo-500" />
          <span className="text-sm text-[#8888aa]">Parse and store lead data from chat on completion</span>
        </label>
        <p className="text-xs text-[#44445a]">Lead data is also stored automatically via the Afterlife webhook.</p>
      </section>

      {/* Save */}
      <div className="flex items-center gap-3 pb-6">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-indigo-500 transition-colors disabled:opacity-50">
          <Save size={16} />
          {saving ? "Saving..." : isNew ? "Create Agent" : "Save Changes"}
        </button>
        <Link href="/agents" className="text-sm text-[#44445a] hover:text-white transition-colors">Cancel</Link>
      </div>
    </div>
  );
}
