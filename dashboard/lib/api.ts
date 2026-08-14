const DEFAULT_URL = process.env.NEXT_PUBLIC_ADAPTER_URL || "http://localhost:8001";

export function getAdapterUrl(): string {
  if (typeof window === "undefined") return DEFAULT_URL;
  return localStorage.getItem("adapter_url") || DEFAULT_URL;
}

export function setAdapterUrl(url: string): void {
  localStorage.setItem("adapter_url", url.replace(/\/$/, "")); // strip trailing slash
}

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const base = getAdapterUrl();
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

// ---- Health ----
export const getHealth = () => req<{ status: string; mongo: boolean }>("/health");

// ---- Agents ----
export interface Agent {
  phone_number: string;
  agent_name: string;
  collection_prefix: string;
  api_key: string;
  trigger_path: string;
  followups_enabled: boolean;
  followup_delays: number[];
  followup_messages: string[];
  greeting_message: string;
  greeting_image_url: string;
  greeting_window_hours: number;
  store_leads: boolean;
  quota_enabled: boolean;
  quota_limit: number;
  quota_used: number;
  quota_reset_date?: string;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export const getAgents = () => req<Agent[]>("/agents");
export const getAgent = (phone: string) =>
  req<Agent>(`/agents/${encodeURIComponent(phone)}`);
export const createAgent = (data: Partial<Agent>) =>
  req<Agent>("/agents", { method: "POST", body: JSON.stringify(data) });
export const updateAgent = (phone: string, data: Partial<Agent>) =>
  req<Agent>(`/agents/${encodeURIComponent(phone)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
export const deleteAgent = (phone: string) =>
  req<{ success: boolean }>(`/agents/${encodeURIComponent(phone)}`, {
    method: "DELETE",
  });
export const resetQuota = (phone: string) =>
  req<{ success: boolean }>(`/agents/${encodeURIComponent(phone)}/reset-quota`, {
    method: "POST",
  });

// ---- Conversations ----
export interface Conversation {
  phone_number: string;
  agent_number?: string;
  human_takeover: boolean;
  lead_status?: string;
  last_message: string;
  last_message_time: string;
}

export const getConversations = (agentNumber?: string) =>
  req<Conversation[]>(`/conversations${agentNumber ? `?agent_number=${encodeURIComponent(agentNumber)}` : ""}`);

// ---- Messages ----
export interface Message {
  sender: string;
  content: string;
  timestamp: string;
  type: string;
}

export const getMessages = (phone: string) =>
  req<Message[]>(`/messages/${encodeURIComponent(phone)}`);

// ---- Takeover ----
export const takeover = (phone: string) =>
  req<{ success: boolean }>("/takeover", {
    method: "POST",
    body: JSON.stringify({ phone_number: phone }),
  });

export const release = (phone: string) =>
  req<{ success: boolean }>("/release", {
    method: "POST",
    body: JSON.stringify({ phone_number: phone }),
  });

export const sendMessage = (phone: string, message: string) =>
  req<{ success: boolean; error?: string; error_code?: string }>(
    "/send-message",
    {
      method: "POST",
      body: JSON.stringify({ phone_number: phone, message }),
    }
  );

// ---- Leads ----
export interface Lead {
  phone_number: string;
  agent_number?: string;
  patient_name: string;
  concern: string;
  city?: string;
  locality?: string;
  location?: string;
  user_location: string;
  notes?: string;
  city_locality?: string;
  lead_status?: string;
  workflow_run_id?: string;
  created_at: string;
}

export const getLeads = (agentNumber?: string) =>
  req<Lead[]>(`/leads${agentNumber ? `?agent_number=${encodeURIComponent(agentNumber)}` : ""}`);
