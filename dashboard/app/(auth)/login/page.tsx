"use client";

import { useState, FormEvent } from "react";
import { login } from "@/lib/api";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(password);
      // Full navigation so middleware sees the new cookie on a fresh request.
      // Redirect to dashboard overview (basePath is /dashboard/whatsapp)
      window.location.href = "/dashboard/whatsapp";
    } catch (err: any) {
      setError(err.message || "Invalid password");
      setLoading(false);
    }
  };

  return (
    <div style={s.page}>
      {/* Animated orbs */}
      <div style={{ ...s.orb, width: 340, height: 340, top: "8%", left: "6%", background: "radial-gradient(circle, rgba(138,43,226,0.55) 0%, transparent 70%)", animationDelay: "0s" }} />
      <div style={{ ...s.orb, width: 220, height: 220, bottom: "12%", right: "10%", background: "radial-gradient(circle, rgba(168,85,247,0.5) 0%, transparent 70%)", animationDelay: "-6s" }} />
      <div style={{ ...s.orb, width: 260, height: 260, top: "45%", right: "18%", background: "radial-gradient(circle, rgba(107,33,168,0.5) 0%, transparent 70%)", animationDelay: "-3s" }} />

      {/* Card */}
      <div style={s.card}>
        <h1 style={s.title}>WhatsApp Adapter</h1>
        <p style={s.subtitle}>Enter your credentials to access the dashboard</p>

        <form onSubmit={handleSubmit} style={{ width: "100%" }}>
          <input
            type="password"
            placeholder="Administrator Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            autoFocus
            required
            style={s.input}
            onFocus={(e) => Object.assign(e.currentTarget.style, s.inputFocus)}
            onBlur={(e) => Object.assign(e.currentTarget.style, s.input)}
          />

          <button
            type="submit"
            disabled={loading}
            style={{ ...s.button, ...(loading ? s.buttonDisabled : {}) }}
          >
            {loading && <span style={s.spinner} />}
            {loading ? "Authenticating…" : "Enter Dashboard"}
          </button>

          {error && <div style={s.error}>{error}</div>}
        </form>
      </div>

      {/* Keyframe injection */}
      <style>{`
        @keyframes orbFloat {
          0%,100% { transform: translate(0,0) scale(1); }
          33%      { transform: translate(28px,-28px) scale(1.08); }
          66%      { transform: translate(-28px,28px) scale(0.93); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

/* ─── styles ─────────────────────────────────────────────────────────────── */
const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg,#0a0a0f 0%,#160826 50%,#0a0a0f 100%)",
    position: "relative",
    overflow: "hidden",
  },
  orb: {
    position: "absolute",
    borderRadius: "50%",
    filter: "blur(60px)",
    opacity: 0.6,
    // @ts-ignore — animation set via injected keyframe
    animation: "orbFloat 14s ease-in-out infinite",
    pointerEvents: "none",
  },
  card: {
    position: "relative",
    zIndex: 10,
    width: "100%",
    maxWidth: 420,
    margin: "0 1.25rem",
    padding: "3rem 2.5rem",
    background: "rgba(12,10,22,0.82)",
    backdropFilter: "blur(24px)",
    WebkitBackdropFilter: "blur(24px)",
    borderRadius: 24,
    border: "1px solid rgba(138,43,226,0.25)",
    boxShadow: "0 24px 60px -10px rgba(138,43,226,0.3), inset 0 1px 0 rgba(255,255,255,0.06)",
  },
  title: {
    margin: "0 0 0.5rem",
    fontSize: "2rem",
    fontWeight: 700,
    textAlign: "center",
    background: "linear-gradient(135deg,#fff 0%,#c084fc 55%,#a855f7 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    backgroundClip: "text",
    letterSpacing: "-0.02em",
  },
  subtitle: {
    margin: "0 0 2rem",
    textAlign: "center",
    color: "rgba(241,241,243,0.55)",
    fontSize: "0.9rem",
  },
  input: {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    marginBottom: "1.25rem",
    padding: "1rem 1.25rem",
    background: "rgba(18,16,32,0.7)",
    border: "1px solid rgba(138,43,226,0.3)",
    borderRadius: 12,
    color: "#f1f1f3",
    fontSize: "1rem",
    outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
  },
  inputFocus: {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    marginBottom: "1.25rem",
    padding: "1rem 1.25rem",
    background: "rgba(18,16,32,0.9)",
    border: "1px solid rgba(138,43,226,0.8)",
    borderRadius: 12,
    color: "#f1f1f3",
    fontSize: "1rem",
    outline: "none",
    boxShadow: "0 0 0 4px rgba(138,43,226,0.12), 0 8px 20px rgba(138,43,226,0.18)",
  },
  button: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    padding: "1rem",
    background: "linear-gradient(135deg,#8a2be2 0%,#6b21a8 100%)",
    border: "none",
    borderRadius: 12,
    color: "#fff",
    fontSize: "1rem",
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 10px 30px rgba(138,43,226,0.4)",
    transition: "opacity 0.2s, transform 0.2s",
  },
  buttonDisabled: {
    opacity: 0.6,
    cursor: "not-allowed",
  },
  spinner: {
    display: "inline-block",
    width: 17,
    height: 17,
    border: "2.5px solid rgba(255,255,255,0.2)",
    borderTopColor: "#fff",
    borderRadius: "50%",
    // @ts-ignore
    animation: "spin 0.65s linear infinite",
    flexShrink: 0,
  },
  error: {
    marginTop: "1rem",
    padding: "0.75rem 1rem",
    background: "rgba(239,68,68,0.1)",
    border: "1px solid rgba(239,68,68,0.3)",
    borderRadius: 8,
    color: "#fca5a5",
    fontSize: "0.875rem",
    textAlign: "center",
  },
};
