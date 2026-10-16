// All adapter API calls go through the Next.js rewrite proxy at /api/adapter/*
// so the browser stays on one origin (localhost:3001) and Set-Cookie works.
// The proxy is configured in next.config.ts rewrites().
const PROXY_BASE = "/api/adapter";

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${PROXY_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin", // same origin — cookies sent automatically
    ...options,
  });

  // Redirect to login on 401
  if (
    res.status === 401 &&
    typeof window !== "undefined" &&
    !window.location.pathname.includes("/login")
  ) {
    window.location.href = "/login";
    throw new Error("Not authenticated");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

// ---- Auth ----
export const login = async (password: string): Promise<void> => {
  const res = await fetch(`${PROXY_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail || "Invalid password");
  }
};

export const logout = async (): Promise<void> => {
  await fetch(`${PROXY_BASE}/auth/logout`, {
    method: "POST",
    credentials: "same-origin",
  });
};

// ---- Health ----
export const getHealth = () =>
  req<{ status: string; mongo: boolean }>("/health");

// ---- Agents ----
export interface Agent {
  phone_number: string;
  agent_name: string;
  collection_prefix: string;
  api_key: string;
  trigger_path: string;
  followups_enabled: boolean;
  followup_delays: number[];
  followup_messages: { message: string; template_sid: string }[];
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
  req<{ success: boolean }>(
    `/agents/${encodeURIComponent(phone)}/reset-quota`,
    { method: "POST" }
  );

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
  req<Conversation[]>(
    `/conversations${agentNumber ? `?agent_number=${encodeURIComponent(agentNumber)}` : ""}`
  );

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
  req<Lead[]>(
    `/leads${agentNumber ? `?agent_number=${encodeURIComponent(agentNumber)}` : ""}`
  );

// ---- Billing (Phase 6) ----
// Money fields arrive as decimal strings (exact). Format them with lib/money,
// never with parseFloat.

/** Live wallet fields AgentX returns for an organization. */
export interface WalletBalance {
  organization_id: number;
  email: string | null;
  balance_usd: string;
  display_currency: string;
  /** 1 display-currency unit = this many USD. */
  display_fx_rate_to_usd: string;
  balance_display: string;
  is_blocked: boolean;
  low_balance_threshold_usd: string;
}

export interface BillingAccount extends Partial<Omit<WalletBalance, "organization_id">> {
  organization_id: number;
  label: string;
  agent_numbers: string[];
  created_at?: string;
  updated_at?: string;
  /** Set when AgentX could not be reached for this row. */
  balance_error?: string;
}

export type LedgerEntryType =
  | "initial_balance"
  | "topup"
  | "debit_call"
  | "refund"
  | "adjustment";

export interface LedgerEntry {
  id: number;
  entry_type: LedgerEntryType | string;
  amount_usd: string;
  balance_after_usd: string;
  idempotency_key: string;
  workflow_run_id: number | null;
  tokens_charged: number | null;
  paid_amount_minor: number | null;
  paid_currency: string | null;
  fx_rate_to_usd: string | null;
  payment_provider_reference: string | null;
  memo: string | null;
  created_at: string;
}

export interface Ledger {
  organization_id: number;
  balance_usd: string;
  entries: LedgerEntry[];
  total_count: number;
  page: number;
  limit: number;
  total_pages: number;
}

export type PaymentStatus = "pending" | "confirmed" | "failed";

export interface Payment {
  payment_id: string;
  organization_id: number;
  paid_amount_minor: number;
  paid_currency: string;
  fx_rate_to_usd: string | null;
  note: string | null;
  created_by: string | null;
  status: PaymentStatus;
  agentx_entry_id: number | null;
  credited_usd: string | null;
  duplicate?: boolean;
  error: string | null;
  created_at: string;
}

export interface OrgWorkflow {
  id: number;
  name: string | null;
  status: string | null;
  workflow_uuid: string | null;
}

export interface BillingAccountDetail {
  account: BillingAccount;
  ledger: Ledger;
  payments: Payment[];
  /** The org's AgentPlatform workflows — display only; billing is per-org. */
  workflows: OrgWorkflow[];
}

/** An AgentX organization in the directory picker. */
export interface OrgDirectoryEntry {
  organization_id: number;
  email: string | null;
  workflow_count: number;
  /** True when this org already has a billing account in this console. */
  already_added: boolean;
}

export interface RecordPaymentInput {
  /** Integer minor units: ₹500.00 is 50000. */
  paid_amount_minor: number;
  paid_currency: "INR" | "USD";
  /** Decimal string; required for INR, omitted for USD. */
  fx_rate_to_usd?: string;
  note?: string;
  created_by?: string;
  /** Reused on resubmit so one form submission is one payment. */
  client_request_id: string;
}

export const getBillingAccounts = () =>
  req<BillingAccount[]>("/adapter/billing/accounts");

/** List every AgentX organization for the 'Add account' picker. */
export const listOrganizations = () =>
  req<{ organizations: OrgDirectoryEntry[] }>("/adapter/billing/organizations").then(
    (r) => r.organizations,
  );

/** Create a billing account for an organization (chosen by org id). */
export const createBillingAccount = (organizationId: number, label: string) =>
  req<BillingAccount>("/adapter/billing/accounts", {
    method: "POST",
    body: JSON.stringify({ organization_id: organizationId, label }),
  });

export const getBillingAccount = (organizationId: number) =>
  req<BillingAccountDetail>(`/adapter/billing/accounts/${organizationId}`);

export const recordPayment = (organizationId: number, input: RecordPaymentInput) =>
  req<Payment>(`/adapter/billing/accounts/${organizationId}/payments`, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const retryPayment = (paymentId: string) =>
  req<Payment>(`/adapter/billing/payments/${encodeURIComponent(paymentId)}/retry`, {
    method: "POST",
  });

export interface SetCurrencyInput {
  currency: "INR" | "USD";
  /** Decimal string; required for INR, omitted/ignored for USD. */
  fx_rate_to_usd?: string;
}

export interface SetCurrencyResult {
  organization_id: number;
  display_currency: string;
  display_fx_rate_to_usd: string;
  balance_usd: string;
  balance_display: string;
}

/** Set the account's display currency — the one the customer sees AND the only
 *  currency payments may be recorded in for this account. */
export const setAccountCurrency = (organizationId: number, input: SetCurrencyInput) =>
  req<SetCurrencyResult>(`/adapter/billing/accounts/${organizationId}/currency`, {
    method: "POST",
    body: JSON.stringify(input),
  });

/**
 * Turn a thrown `req` error ("409: {\"detail\": ...}") into a readable message.
 * Unwraps FastAPI `detail` fields, including AgentX errors the adapter relays.
 */
export function apiErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/^(\d{3}):\s*([\s\S]*)$/);
  if (!match) return raw || "Something went wrong.";

  const [, status, body] = match;
  let message = body.trim();
  for (let depth = 0; depth < 3; depth++) {
    const jsonStart = message.indexOf("{");
    if (jsonStart === -1) break;
    try {
      const detail = JSON.parse(message.slice(jsonStart))?.detail;
      if (Array.isArray(detail)) {
        // FastAPI validation errors: [{ loc, msg, type }, ...]
        message = detail
          .map((d) => (typeof d?.msg === "string" ? d.msg : ""))
          .filter(Boolean)
          .join("; ");
        break;
      }
      if (typeof detail !== "string") break;
      message = detail;
    } catch {
      break;
    }
  }
  message = message.replace(/^AgentX credits API error:\s*/i, "");

  if (!message) {
    if (status === "502" || status === "503" || status === "504") {
      return "The billing service is unreachable. Try again in a moment.";
    }
    return `Request failed (${status}).`;
  }
  return message;
}
