"use client";

import { useEffect, useState } from "react";
import { getHealth, logout } from "@/lib/api";
import { CheckCircle, XCircle, RefreshCw, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

export default function SettingsPage() {
  const router = useRouter();
  const [health, setHealth] = useState<{ status: string; mongo: boolean } | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  const checkHealth = () => {
    setHealthLoading(true);
    getHealth()
      .then(setHealth)
      .catch(() => setHealth({ status: "error", mongo: false }))
      .finally(() => setHealthLoading(false));
  };

  useEffect(() => { checkHealth(); }, []);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      router.push("/login");
    }
  };

  const sectionCls = "bg-[#0d0d14] rounded-xl border border-[#1e1e2e] p-5 space-y-4";

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-[#666880] mt-1">Adapter configuration and health</p>
      </div>

      {/* Health */}
      <section className={sectionCls}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-white">System Health</h2>
          <button
            onClick={checkHealth}
            className="flex items-center gap-1.5 text-xs text-[#8888aa] border border-[#2a2a3a] px-3 py-1.5 rounded-lg hover:bg-[#1a1a26] hover:text-white transition-colors"
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
        {healthLoading ? (
          <p className="text-sm text-[#44445a]">Checking...</p>
        ) : (
          <div className="space-y-0">
            <div className="flex items-center justify-between py-3 border-b border-[#1a1a26]">
              <span className="text-sm text-[#c0c0d8]">Adapter API</span>
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

      {/* Webhook endpoints */}
      <section className={sectionCls}>
        <h2 className="font-semibold text-white">Webhook Endpoints</h2>
        <div className="space-y-0">
          {[
            {
              label: "Twilio WhatsApp Webhook",
              path: "/whatsapp",
              method: "POST",
              hint: "Set this in Twilio console",
            },
            {
              label: "Afterlife Lead Data Webhook",
              path: "/webhook/lead-data",
              method: "POST",
              hint: "Set this in Afterlife workflow webhook node",
            },
          ].map((w) => (
            <div key={w.path} className="py-3 border-b border-[#1a1a26] last:border-0">
              <div className="flex items-center justify-between">
                <p className="font-medium text-[#e0e0f0] text-sm">{w.label}</p>
                <span className="text-xs bg-indigo-500/15 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded font-mono">
                  {w.method}
                </span>
              </div>
              <p className="text-xs text-indigo-400/70 font-mono mt-1">
                {"<your-adapter-url>"}
                {w.path}
              </p>
              <p className="text-xs text-[#44445a] mt-0.5">{w.hint}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Session */}
      <section className={sectionCls}>
        <h2 className="font-semibold text-white">Session</h2>
        <p className="text-sm text-[#8888aa]">
          You are logged in as administrator. Sessions expire after 12 hours.
        </p>
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="flex items-center gap-2 text-sm bg-[#1a1a28] border border-[#2a2a3a] text-[#8888aa] px-4 py-2 rounded-lg hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors disabled:opacity-50"
        >
          <LogOut size={14} />
          {loggingOut ? "Logging out…" : "Log out"}
        </button>
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
