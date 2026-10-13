"""WhatsApp ↔ Dograh Adapter Service.

This lightweight service sits between Twilio (WhatsApp webhooks) and
Dograh's public text-chat API. It translates inbound WhatsApp messages
into Dograh workflow executions and sends the assistant's reply back
via Twilio.

Includes:
- Conversation tracking in PostgreSQL (single source of truth with AgentX)
- Human takeover mode (pause AI, let human respond from dashboard)
- Dashboard API endpoints for viewing/managing conversations
- Operator billing console (reads wallet data from AgentX via internal API)

Supports multiple agents/numbers: configure AGENT_MAPPINGS to map
each Twilio WhatsApp number to its Dograh API key + trigger UUID.
"""

import asyncio
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import asyncpg
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request, Response, Cookie, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from itsdangerous import TimestampSigner, BadSignature, SignatureExpired
from loguru import logger
from twilio.rest import Client as TwilioClient
from twilio.twiml.messaging_response import MessagingResponse
from twilio.request_validator import RequestValidator

load_dotenv()


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Dograh backend base URL (the /api/v1 prefix)
DOGRAH_API_BASE = os.getenv("DOGRAH_API_BASE", "http://localhost:8000/api/v1")

# AgentX (AgentPlatform) internal credits API — used by the operator billing
# console (Phase 6). The internal secret authenticates service-to-service calls
# and MUST never be exposed to the dashboard/browser (R7.10).
AGENTX_INTERNAL_BASE = os.getenv("AGENTX_INTERNAL_BASE", "http://api:8000/api/v1")
DOGRAH_INTERNAL_SECRET = os.getenv("DOGRAH_INTERNAL_SECRET", "")

# Default agent config (single-agent setup)
DOGRAH_API_KEY = os.getenv("DOGRAH_API_KEY", "")
DOGRAH_TRIGGER_PATH = os.getenv("DOGRAH_TRIGGER_PATH", "")

# Twilio account-level credentials (same for all numbers; per-number routing comes from DB)
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")

# PostgreSQL — same database as AgentX (single source of truth)
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@postgres:5432/postgres",
)

# Adapter authentication (Phase 1)
ADAPTER_ADMIN_PASSWORD = os.getenv("ADAPTER_ADMIN_PASSWORD")
ADAPTER_SESSION_SECRET = os.getenv("ADAPTER_SESSION_SECRET")

# Fail-fast validation
if not ADAPTER_ADMIN_PASSWORD:
    raise RuntimeError("ADAPTER_ADMIN_PASSWORD must be set in .env")
if not ADAPTER_SESSION_SECRET:
    raise RuntimeError("ADAPTER_SESSION_SECRET must be set in .env")

# Session config
SESSION_COOKIE = "adapter_session"
SESSION_MAX_AGE = 12 * 60 * 60  # 12 hours
signer = TimestampSigner(ADAPTER_SESSION_SECRET)

# Initialize Twilio client
twilio_client: TwilioClient | None = None
twilio_validator: RequestValidator | None = None
if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN:
    twilio_client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    twilio_validator = RequestValidator(TWILIO_AUTH_TOKEN)
    logger.info("Twilio client initialized")

# For multi-agent setups, define a JSON mapping in the env:
#   AGENT_MAPPINGS='{ "+14155551234": { "api_key": "dgr_xxx", "trigger_path": "uuid", ... } }'
# Used ONLY for one-time migration to PostgreSQL on first deploy.
AGENT_MAPPINGS: dict = {}
_raw_mappings = os.getenv("AGENT_MAPPINGS", "").strip()
if _raw_mappings:
    try:
        AGENT_MAPPINGS = json.loads(_raw_mappings)
        logger.info(f"Loaded {len(AGENT_MAPPINGS)} agent mapping(s) for migration")
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse AGENT_MAPPINGS: {e}")

# Follow-up defaults
DEFAULT_FOLLOWUP_DELAYS = [300, 900, 1800]  # 5m, 15m, 30m


# ---------------------------------------------------------------------------
# PostgreSQL connection pool
# ---------------------------------------------------------------------------

pg_pool: asyncpg.Pool | None = None


# In-memory fallback (if PostgreSQL is unavailable)
SESSIONS_STORE: dict = {}  # phone_number -> session dict
MESSAGE_STORE: dict = {}  # phone_number -> list of messages

# Conversations cache (30s TTL)
CONVERSATIONS_CACHE: dict = {"data": None, "expires_at": 0}


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="WhatsApp-Dograh Adapter")

# CORS — allow the dashboard and AgentX UI to connect.
# Supports multiple origins via comma-separated ADAPTER_CORS_ORIGINS env var.
_cors_raw = os.getenv("ADAPTER_CORS_ORIGINS") or os.getenv("DASHBOARD_ORIGIN") or ""
ALLOWED_ORIGINS = [o.strip() for o in _cors_raw.split(",") if o.strip()] or [
    "http://localhost:3000",              # AgentX UI (via nginx)
    "http://localhost:3001",              # Adapter dashboard
    "http://localhost:3010",              # AgentX UI (direct)
    "https://devagents.afterlife.org.in", # Production
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Authentication (Phase 1)
# ---------------------------------------------------------------------------

async def require_operator(adapter_session: Optional[str] = Cookie(None)):
    """Dependency: require valid session cookie."""
    if not adapter_session:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        signer.unsign(adapter_session, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return True


@app.post("/adapter/auth/login")
async def login(request: Request):
    """Login endpoint for dashboard operators."""
    data = await request.json()
    password = data.get("password", "")
    if password != ADAPTER_ADMIN_PASSWORD:
        logger.warning(f"Failed login attempt from {request.client.host}")
        raise HTTPException(status_code=401, detail="Invalid password")

    # Create signed session cookie
    token = signer.sign(b"operator").decode()
    response = JSONResponse({"success": True, "message": "Logged in"})
    is_secure = os.getenv("ADAPTER_COOKIE_SECURE", "").lower() not in ("", "0", "false", "no")
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=is_secure,
        samesite="lax",
    )
    logger.info(f"✅ Operator logged in from {request.client.host}")
    return response


@app.post("/adapter/auth/logout")
async def logout():
    """Logout endpoint — clears session cookie."""
    response = JSONResponse({"success": True, "message": "Logged out"})
    response.delete_cookie(key=SESSION_COOKIE)
    logger.info("Operator logged out")
    return response


# ---------------------------------------------------------------------------
# PostgreSQL startup — create tables and connect
# ---------------------------------------------------------------------------

_CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS wa_agents (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(50) UNIQUE NOT NULL,
    agent_name VARCHAR(200) DEFAULT '',
    api_key TEXT DEFAULT '',
    trigger_path TEXT DEFAULT '',
    collection_prefix VARCHAR(100) DEFAULT '',
    greeting_message TEXT DEFAULT '',
    greeting_image_url TEXT DEFAULT '',
    greeting_window_hours INTEGER DEFAULT 0,
    completion_message TEXT DEFAULT '',
    followups_enabled BOOLEAN DEFAULT FALSE,
    followup_delays JSONB DEFAULT '[300, 900, 1800]'::jsonb,
    followup_messages JSONB DEFAULT '[]'::jsonb,
    store_leads BOOLEAN DEFAULT FALSE,
    quota_enabled BOOLEAN DEFAULT FALSE,
    quota_limit INTEGER DEFAULT 500,
    quota_used INTEGER DEFAULT 0,
    quota_reset_date VARCHAR(20) DEFAULT '',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wa_sessions (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(100) UNIQUE NOT NULL,
    agent_number VARCHAR(100) DEFAULT '',
    human_takeover BOOLEAN DEFAULT FALSE,
    takeover_context TEXT DEFAULT '',
    pending_handoff BOOLEAN DEFAULT FALSE,
    lead_status VARCHAR(20) DEFAULT 'active',
    followup_stage INTEGER DEFAULT 0,
    last_activity TIMESTAMPTZ DEFAULT NOW(),
    last_agent_reply_at TIMESTAMPTZ DEFAULT NOW(),
    message_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wa_chats (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(100) NOT NULL,
    sender VARCHAR(100) NOT NULL,
    content TEXT DEFAULT '',
    type VARCHAR(20) DEFAULT 'user',
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wa_leads (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(100) DEFAULT '',
    agent_number VARCHAR(100) DEFAULT '',
    patient_name VARCHAR(200) DEFAULT '',
    concern TEXT DEFAULT '',
    city VARCHAR(200) DEFAULT '',
    locality VARCHAR(200) DEFAULT '',
    city_locality VARCHAR(200) DEFAULT '',
    user_location TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    lead_status VARCHAR(20) DEFAULT 'completed',
    workflow_run_id VARCHAR(200) DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wa_chats_phone_ts ON wa_chats(phone_number, timestamp);
CREATE INDEX IF NOT EXISTS idx_wa_chats_phone_sender ON wa_chats(phone_number, sender);
CREATE INDEX IF NOT EXISTS idx_wa_sessions_agent ON wa_sessions(agent_number);
CREATE INDEX IF NOT EXISTS idx_wa_sessions_status ON wa_sessions(lead_status);
CREATE INDEX IF NOT EXISTS idx_wa_leads_created ON wa_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_leads_agent ON wa_leads(agent_number);
"""


@app.on_event("startup")
async def startup():
    """Initialize PostgreSQL connection pool and create tables."""
    global pg_pool
    try:
        pg_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
        async with pg_pool.acquire() as conn:
            await conn.execute(_CREATE_TABLES_SQL)
        logger.info("✅ Connected to PostgreSQL")

        # One-time migration: .env AGENT_MAPPINGS → PostgreSQL
        await _migrate_env_agents_to_db()
    except Exception as e:
        logger.warning(f"⚠️ PostgreSQL unavailable ({e}), using in-memory storage")
        pg_pool = None

    # Start follow-up scheduler
    asyncio.create_task(_followup_loop())


# ---------------------------------------------------------------------------
# Agent helpers
# ---------------------------------------------------------------------------

async def _get_agent_doc(to_number: str) -> dict:
    """Look up agent config from wa_agents table by phone number."""
    clean = to_number.replace("whatsapp:", "").strip()
    if pg_pool is not None:
        row = await pg_pool.fetchrow(
            "SELECT * FROM wa_agents WHERE phone_number = $1 AND is_active = true",
            clean,
        )
        if row:
            return _row_to_dict(row)
    raise ValueError(
        f"No agent found for number {to_number}. Add it via the dashboard."
    )


async def _get_agent_config(to_number: str) -> tuple[str, str]:
    """Resolve which API key + trigger to use for a given Twilio number."""
    doc = await _get_agent_doc(to_number)
    return doc["api_key"], doc["trigger_path"]


async def _get_agent_mapping(to_number: str) -> dict:
    """Get the full agent config dict for a Twilio number."""
    try:
        return await _get_agent_doc(to_number)
    except ValueError:
        return {}


def _row_to_dict(row) -> dict:
    """Convert an asyncpg Record to a plain dict, deserializing JSONB fields."""
    if row is None:
        return {}
    d = dict(row)
    # asyncpg returns JSONB as Python objects already — no extra parsing needed
    return d


async def _migrate_env_agents_to_db() -> None:
    """One-time migration: move AGENT_MAPPINGS from .env into wa_agents table.

    Runs at startup. If the wa_agents table already has documents, skip.
    This ensures existing agents are preserved after the first deploy.
    """
    if pg_pool is None or not AGENT_MAPPINGS:
        return
    count = await pg_pool.fetchval("SELECT COUNT(*) FROM wa_agents")
    if count > 0:
        logger.info(f"✅ wa_agents has {count} agent(s) — skipping migration")
        return

    logger.info(f"🔄 Migrating {len(AGENT_MAPPINGS)} agents from env to PostgreSQL...")
    for phone_number, config in AGENT_MAPPINGS.items():
        clean = phone_number.replace("whatsapp:", "").strip()
        agent_name = config.get("agent_name", clean)
        prefix = config.get("collection_prefix", "")
        if not prefix:
            prefix = re.sub(r"[^a-z0-9]+", "_", agent_name.lower().strip()).strip("_")
        now = datetime.now(timezone.utc)
        try:
            await pg_pool.execute(
                """INSERT INTO wa_agents (
                    phone_number, agent_name, api_key, trigger_path,
                    collection_prefix, greeting_message, greeting_image_url,
                    greeting_window_hours, followups_enabled, followup_delays,
                    followup_messages, store_leads, quota_enabled, quota_limit,
                    is_active, created_at, updated_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17)
                ON CONFLICT (phone_number) DO NOTHING""",
                clean,
                agent_name,
                config.get("api_key", ""),
                config.get("trigger_path", ""),
                prefix,
                config.get("greeting_message", ""),
                config.get("greeting_image_url", ""),
                config.get("greeting_window_hours", 0),
                config.get("followups_enabled", False),
                json.dumps(config.get("followup_delays", DEFAULT_FOLLOWUP_DELAYS)),
                json.dumps(config.get("followup_messages", [])),
                config.get("store_leads", False),
                config.get("quota_enabled", False),
                config.get("quota_limit", 500),
                config.get("is_active", True),
                now, now,
            )
            logger.info(f"  ✅ Migrated agent: {agent_name} ({clean})")
        except Exception as e:
            logger.error(f"  ❌ Failed to migrate {clean}: {e}")

    logger.info("✅ Agent migration complete")


# ---------------------------------------------------------------------------
# Database helpers — sessions
# ---------------------------------------------------------------------------

async def get_or_create_session(phone_number: str, agent_number: str = "") -> dict:
    """Get or create a session for the given phone number."""
    if pg_pool is not None:
        row = await pg_pool.fetchrow(
            "SELECT * FROM wa_sessions WHERE phone_number = $1", phone_number
        )
        if row:
            return _row_to_dict(row)
        now = datetime.now(timezone.utc)
        row = await pg_pool.fetchrow(
            """INSERT INTO wa_sessions (
                phone_number, agent_number, human_takeover, lead_status,
                followup_stage, last_activity, last_agent_reply_at, created_at
            ) VALUES ($1,$2,false,'active',0,$3,$3,$3)
            ON CONFLICT (phone_number) DO UPDATE SET phone_number = wa_sessions.phone_number
            RETURNING *""",
            phone_number, agent_number, now,
        )
        return _row_to_dict(row)
    else:
        if phone_number not in SESSIONS_STORE:
            SESSIONS_STORE[phone_number] = {
                "phone_number": phone_number,
                "agent_number": agent_number,
                "human_takeover": False,
                "lead_status": "active",
                "followup_stage": 0,
                "last_activity": datetime.now(timezone.utc),
                "last_agent_reply_at": datetime.now(timezone.utc),
            }
        return SESSIONS_STORE[phone_number]


# ---------------------------------------------------------------------------
# Database helpers — chats
# ---------------------------------------------------------------------------

async def store_message(
    phone_number: str, sender: str, content: str, msg_type: str
) -> None:
    """Store a message in the database."""
    now = datetime.now(timezone.utc)

    if pg_pool is not None:
        await pg_pool.execute(
            """INSERT INTO wa_chats (phone_number, sender, content, type, timestamp)
               VALUES ($1, $2, $3, $4, $5)""",
            phone_number, sender, content, msg_type, now,
        )
        # Update session last_activity
        await pg_pool.execute(
            """UPDATE wa_sessions SET last_activity = $2, message_count = message_count + 1
               WHERE phone_number = $1""",
            phone_number, now,
        )
    else:
        if phone_number not in MESSAGE_STORE:
            MESSAGE_STORE[phone_number] = []
        MESSAGE_STORE[phone_number].append(
            {
                "sender": sender,
                "content": content,
                "timestamp": now.isoformat() + "Z",
                "type": msg_type,
            }
        )

    # Invalidate conversations cache
    CONVERSATIONS_CACHE.clear()


# ---------------------------------------------------------------------------
# Database helpers — session state
# ---------------------------------------------------------------------------

async def get_human_takeover_status(phone_number: str) -> bool:
    """Check if a conversation is in human takeover mode."""
    if pg_pool is not None:
        val = await pg_pool.fetchval(
            "SELECT human_takeover FROM wa_sessions WHERE phone_number = $1",
            phone_number,
        )
        return bool(val)
    else:
        session = SESSIONS_STORE.get(phone_number)
        return session.get("human_takeover", False) if session else False


async def set_human_takeover(phone_number: str, status: bool, takeover_context: str = "") -> None:
    """Set human takeover status for a conversation."""
    now = datetime.now(timezone.utc)
    if pg_pool is not None:
        if status and takeover_context:
            await pg_pool.execute(
                """INSERT INTO wa_sessions (phone_number, human_takeover, takeover_context, last_activity)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (phone_number) DO UPDATE
                   SET human_takeover = $2, takeover_context = $3, last_activity = $4""",
                phone_number, status, takeover_context, now,
            )
        else:
            await pg_pool.execute(
                """INSERT INTO wa_sessions (phone_number, human_takeover, last_activity)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (phone_number) DO UPDATE
                   SET human_takeover = $2, last_activity = $3""",
                phone_number, status, now,
            )
    else:
        if phone_number not in SESSIONS_STORE:
            SESSIONS_STORE[phone_number] = {"phone_number": phone_number}
        SESSIONS_STORE[phone_number]["human_takeover"] = status
        SESSIONS_STORE[phone_number]["last_activity"] = now
        if status and takeover_context:
            SESSIONS_STORE[phone_number]["takeover_context"] = takeover_context

    CONVERSATIONS_CACHE.clear()


async def _reset_followup(phone_number: str) -> None:
    """Reset follow-up stage when user replies (they're active again)."""
    now = datetime.now(timezone.utc)
    if pg_pool is not None:
        await pg_pool.execute(
            """UPDATE wa_sessions SET followup_stage = 0,
               last_activity = $2, last_agent_reply_at = $2
               WHERE phone_number = $1""",
            phone_number, now,
        )
    else:
        session = SESSIONS_STORE.get(phone_number)
        if session:
            session["followup_stage"] = 0
            session["last_activity"] = now
            session["last_agent_reply_at"] = now


async def _mark_agent_replied(phone_number: str) -> None:
    """Track when the agent last replied (for follow-up timing)."""
    now = datetime.now(timezone.utc)
    if pg_pool is not None:
        await pg_pool.execute(
            "UPDATE wa_sessions SET last_agent_reply_at = $2 WHERE phone_number = $1",
            phone_number, now,
        )
    else:
        session = SESSIONS_STORE.get(phone_number)
        if session:
            session["last_agent_reply_at"] = now


async def _set_lead_status(phone_number: str, status: str) -> None:
    """Update lead status (active, completed, not_qualified, inactive)."""
    if pg_pool is not None:
        await pg_pool.execute(
            "UPDATE wa_sessions SET lead_status = $2 WHERE phone_number = $1",
            phone_number, status,
        )
    else:
        session = SESSIONS_STORE.get(phone_number)
        if session:
            session["lead_status"] = status
    CONVERSATIONS_CACHE.clear()


async def _increment_followup(phone_number: str, stage: int) -> None:
    """Set the follow-up stage for a session."""
    if pg_pool is not None:
        await pg_pool.execute(
            "UPDATE wa_sessions SET followup_stage = $2 WHERE phone_number = $1",
            phone_number, stage,
        )
    else:
        session = SESSIONS_STORE.get(phone_number)
        if session:
            session["followup_stage"] = stage


async def _update_session_field(phone_number: str, **kwargs) -> None:
    """Update one or more fields on a session row."""
    if pg_pool is None:
        session = SESSIONS_STORE.get(phone_number)
        if session:
            session.update(kwargs)
        return
    sets = []
    vals = [phone_number]
    idx = 2
    for k, v in kwargs.items():
        sets.append(f"{k} = ${idx}")
        vals.append(v)
        idx += 1
    if not sets:
        return
    sql = f"UPDATE wa_sessions SET {', '.join(sets)} WHERE phone_number = $1"
    await pg_pool.execute(sql, *vals)


async def _get_session(phone_number: str) -> dict | None:
    """Fetch a session by phone number."""
    if pg_pool is not None:
        row = await pg_pool.fetchrow(
            "SELECT * FROM wa_sessions WHERE phone_number = $1", phone_number
        )
        return _row_to_dict(row) if row else None
    return SESSIONS_STORE.get(phone_number)


async def _store_lead_from_chat(phone_number: str) -> None:
    """Store lead data. Uses Dograh's gathered_context if available, else chat parsing."""
    if pg_pool is None:
        return

    # Get session for agent_number
    session = await _get_session(phone_number)

    # Fallback: parse from chat messages
    messages = []
    rows = await pg_pool.fetch(
        "SELECT sender, content FROM wa_chats WHERE phone_number = $1 ORDER BY timestamp ASC LIMIT 100",
        phone_number,
    )
    messages = [{"sender": r["sender"], "content": r["content"]} for r in rows]

    user_msgs = [m["content"] for m in messages if m["sender"] == "user"]

    # Location (Google Maps URL)
    location = ""
    for msg in reversed(user_msgs):
        if "maps.google.com" in msg or "maps.app.goo.gl" in msg or "goo.gl" in msg:
            location = msg.strip()
            break

    # Name: reply after bot asks "name"
    name = ""
    for i, m in enumerate(messages):
        if m["sender"] == "agent" and "name" in m["content"].lower():
            for j in range(i + 1, len(messages)):
                if messages[j]["sender"] == "user":
                    c = messages[j]["content"].strip()
                    if (len(c) < 30 and not c.startswith("http")
                            and not c.isdigit() and c.lower() not in ("no", "yes", "ok", "yah", "yeah")):
                        name = c.split(" from ")[0].strip() if " from " in c.lower() else c
                    break
            if name:
                break

    # City: reply after bot asks "location" or "where you are from"
    city_locality = ""
    for i, m in enumerate(messages):
        if m["sender"] == "agent" and any(kw in m["content"].lower() for kw in ["your location", "where you are from", "your city"]):
            for j in range(i + 1, len(messages)):
                if messages[j]["sender"] == "user":
                    c = messages[j]["content"].strip()
                    if (not c.startswith("http") and len(c) < 80
                            and c.lower() not in ("no", "yes", "ok")
                            and "hyderabad" not in c.lower()):
                        city_locality = c
                    break
            if city_locality:
                break
    # Second pass: "from X" pattern
    if not city_locality:
        for msg in user_msgs[:3]:
            if " from " in msg.lower():
                city_locality = msg.split(" from ", 1)[1].strip()
                break

    # Concern: reply after "issue" or "problem"
    concern = ""
    for i, m in enumerate(messages):
        if m["sender"] == "agent" and any(kw in m["content"].lower() for kw in ["issue", "problem", "what kind"]):
            for j in range(i + 1, len(messages)):
                if messages[j]["sender"] == "user":
                    concern = messages[j]["content"].strip()
                    break
            if concern:
                break

    now = datetime.now(timezone.utc)
    await pg_pool.execute(
        """INSERT INTO wa_leads (
            phone_number, agent_number, patient_name, concern,
            city_locality, user_location, lead_status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'completed',$7)""",
        phone_number,
        session.get("agent_number", "") if session else "",
        name,
        concern,
        city_locality,
        location,
        now,
    )
    logger.info(f"💾 Lead stored: {name} | {concern[:50]} | {city_locality} | {location[:50]}")


# ---------------------------------------------------------------------------
# Webhook endpoint
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {"status": "ok", "db": pg_pool is not None}


@app.post("/whatsapp")
async def whatsapp_webhook(
    request: Request,
    From: str = Form(...),
    To: str = Form(...),
    Body: str = Form(""),
    Latitude: str = Form(None),
    Longitude: str = Form(None),
    MediaUrl0: str = Form(None),
    MediaContentType0: str = Form(None),
):
    """Twilio WhatsApp webhook handler.

    Receives inbound messages, forwards them to Dograh's public text-chat
    API, and sends the assistant's reply back via Twilio API.

    If human_takeover is active for this conversation, the message is stored
    but NOT forwarded to Dograh — a human will respond from the dashboard.
    """
    # Validate Twilio signature (Task 1.4)
    # Disabled locally when TWILIO_VALIDATE_SIGNATURE is not "true" (e.g. behind ngrok)
    _validate_sig = os.getenv("TWILIO_VALIDATE_SIGNATURE", "false").lower() == "true"
    if twilio_validator and _validate_sig:
        proto = request.headers.get("X-Forwarded-Proto", "https")
        host = request.headers.get("Host", request.url.hostname or "")
        full_url = f"{proto}://{host}{request.url.path}"
        signature = request.headers.get("X-Twilio-Signature", "")
        form_data = await request.form()
        params = {key: value for key, value in form_data.items()}
        if not twilio_validator.validate(full_url, params, signature):
            logger.warning(f"⚠️ Invalid Twilio signature from {request.client.host}")
            raise HTTPException(status_code=403, detail="Invalid request signature")

    user_message = Body.strip()
    sender = From   # e.g. "whatsapp:+919876543210"
    receiver = To   # e.g. "whatsapp:+14155551234"

    # Handle WhatsApp location pins (Twilio sends lat/lng separately)
    if not user_message and Latitude and Longitude:
        user_message = f"https://maps.google.com/?q={Latitude},{Longitude}"
        logger.info(f"📍 Location pin from {sender}: {user_message}")

    logger.info(f"📩 Incoming from {sender}: {user_message[:100]}")

    if not user_message:
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Ensure session exists and agent_number is always current receiver
    await get_or_create_session(sender, agent_number=receiver)
    # Always sync agent_number to the number that received this message
    await _update_session_field(sender, agent_number=receiver)

    # User replied — reset follow-up timer and stage
    await _reset_followup(sender)

    # Store the user's message
    await store_message(sender, "user", user_message, "user")

    # Check if human has taken over — if so, don't forward to Dograh
    if await get_human_takeover_status(sender):
        logger.info(f"🧑 Human takeover active for {sender}, skipping AI")
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Resolve which Dograh agent handles this number
    try:
        api_key, trigger_path = await _get_agent_config(receiver)
    except ValueError as e:
        logger.error(str(e))
        _send_twilio_reply(
            sender, "Sorry, this service is not configured. Please try again later.",
            from_number=receiver
        )
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Check quota before calling Dograh
    agent_doc = await _get_agent_mapping(receiver)
    allowed, quota_reason = await check_quota(agent_doc)
    if not allowed:
        logger.warning(f"🚫 Quota exceeded for {receiver}: {quota_reason}")
        _send_twilio_reply(sender, "Sorry, this service is temporarily unavailable. Please try again later.", from_number=receiver)
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Check if user is responding to a pending handoff confirmation (BEFORE Dograh call)
    pending_session = await _get_session(sender)
    if pending_session and pending_session.get("pending_handoff"):
        msg_lower = user_message.lower().strip()
        yes_words = ["yes", "yeah", "ok", "okay", "sure", "please", "connect", "transfer", "ya", "yep", "fine"]
        no_words  = ["no", "nope", "nah", "cancel", "don't", "dont", "back", "continue", "proceed"]
        is_yes = any(w in msg_lower for w in yes_words)
        is_no  = any(w in msg_lower for w in no_words)

        if is_yes:
            takeover_ctx = pending_session.get("takeover_context", "")
            await _update_session_field(sender, pending_handoff=False)
            await set_human_takeover(sender, True, takeover_context=takeover_ctx)
            confirm_reply = "Our executive will be with you shortly. 🙏 Please hold on."
            _send_twilio_reply(sender, confirm_reply, from_number=receiver)
            await store_message(sender, "agent", confirm_reply, "system")
            logger.info(f"✅ User confirmed handoff — human takeover activated for {sender}")
            resp = MessagingResponse()
            return Response(content=str(resp), media_type="application/xml")

        elif is_no:
            await _update_session_field(sender, pending_handoff=False, takeover_context="")
            no_reply = "No problem! Our standard fee is Rs.800 per session. Would you like to proceed with booking?"
            _send_twilio_reply(sender, no_reply, from_number=receiver)
            await store_message(sender, "agent", no_reply, "ai")
            await _mark_agent_replied(sender)
            logger.info(f"❌ User declined handoff — AI continues for {sender}")
            resp = MessagingResponse()
            return Response(content=str(resp), media_type="application/xml")

        else:
            retry_msg = "I didn't quite catch that. Would you like to be connected to an executive? Please reply Yes or No."
            _send_twilio_reply(sender, retry_msg, from_number=receiver)
            await store_message(sender, "agent", retry_msg, "system")
            await _mark_agent_replied(sender)
            resp = MessagingResponse()
            return Response(content=str(resp), media_type="application/xml")

    # If lead already completed/inactive/not_qualified — re-engage with fresh greeting
    existing_session = await _get_session(sender)
    if existing_session and existing_session.get("lead_status") in ["completed", "inactive", "not_qualified"]:
        old_status = existing_session.get("lead_status")
        logger.info(f"🔄 Re-engaging {sender} (was {old_status}) — resetting session")
        await _set_lead_status(sender, "active")
        await _reset_followup(sender)
        await _update_session_field(sender, agent_number=receiver)
        logger.info(f"🔄 Updated agent_number to {receiver} for {sender}")
        # Send greeting + image if configured
        mapping = await _get_agent_mapping(receiver)
        if mapping.get("greeting_message"):
            image_url = mapping.get("greeting_image_url", "")
            _send_twilio_reply(sender, mapping["greeting_message"], media_url=image_url, from_number=receiver)
            await store_message(sender, "agent", mapping["greeting_message"], "ai")
            await _mark_agent_replied(sender)
            logger.info(f"👋 Re-engagement greeting sent to {sender}")
            resp = MessagingResponse()
            return Response(content=str(resp), media_type="application/xml")

    # Maps link interception
    maps_keywords = ["maps.app.goo.gl", "maps.google.com", "goo.gl", "https://maps", "maps.app"]
    user_sent_maps = any(kw in user_message.lower() for kw in maps_keywords)

    # Call Dograh's public text-chat endpoint
    dograh_response = await _send_to_dograh(
        api_key=api_key,
        trigger_path=trigger_path,
        session_key=sender,
        text=user_message,
    )
    assistant_text = dograh_response["assistant_text"]
    is_completed = dograh_response["is_completed"]

    # If user sent maps but Dograh didn't complete — force completion
    if user_sent_maps and not is_completed:
        cur_session = await _get_session(sender)
        if cur_session and cur_session.get("lead_status") == "active":
            logger.info(f"📍 Maps link detected, Dograh didn't complete — forcing completion for {sender}")
            is_completed = True

    # Strip [SEND_EXACT]: prefix if Dograh returns it
    if assistant_text and assistant_text.startswith("[SEND_EXACT]:"):
        assistant_text = assistant_text[len("[SEND_EXACT]:"):].strip()

    # Send greeting only on the very first message ever in this conversation.
    mapping = await _get_agent_mapping(receiver)
    greeting_sent = False
    if assistant_text and mapping.get("greeting_message"):
        should_greet = False
        if pg_pool is not None:
            total_agent_msgs = await pg_pool.fetchval(
                "SELECT COUNT(*) FROM wa_chats WHERE phone_number = $1 AND sender = 'agent'",
                sender,
            )
            should_greet = total_agent_msgs == 0
            logger.debug(f"Greeting check: {sender} has {total_agent_msgs} agent msgs total, should_greet={should_greet}")
        else:
            should_greet = len(MESSAGE_STORE.get(sender, [])) == 0

        if should_greet and not assistant_text.startswith("Greetings"):
            image_url = mapping.get("greeting_image_url", "")
            _send_twilio_reply(sender, mapping["greeting_message"], media_url=image_url, from_number=receiver)
            await store_message(sender, "agent", mapping["greeting_message"], "ai")
            await _mark_agent_replied(sender)
            greeting_sent = True
            logger.info(f"👋 Greeting sent to {sender}{' (with image)' if image_url else ''} — skipping Dograh reply")

    if greeting_sent:
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Check if the agent is requesting a human handoff
    if assistant_text and "TRANSFER_TO_HUMAN" in assistant_text:
        clean_text = assistant_text.replace("TRANSFER_TO_HUMAN", "").strip()
        takeover_context = (
            f"The user was in the middle of a conversation. "
            f"Last AI message before handoff: {clean_text or 'Pricing/discount discussion'}. "
            f"When AI resumes, continue from where the conversation was — "
            f"do not restart from the beginning."
        )
        await _update_session_field(sender, pending_handoff=True, takeover_context=takeover_context)

        confirm_msg = (
            "I'd like to connect you with our team executive who can assist you better. "
            "Would you like me to transfer you to an executive? (Yes/No)"
        )
        _send_twilio_reply(sender, confirm_msg, from_number=receiver)
        await store_message(sender, "agent", confirm_msg, "system")
        await _mark_agent_replied(sender)
        logger.info(f"🔀 Pending handoff — confirmation requested for {sender}")

        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Check if user is responding to a pending handoff confirmation (post-Dograh path)
    current_session = await _get_session(sender)
    if current_session and current_session.get("pending_handoff"):
        msg_lower = user_message.lower().strip()
        yes_words = ["yes", "yeah", "ok", "okay", "sure", "please", "connect", "transfer", "ya", "yep", "fine"]
        no_words = ["no", "nope", "nah", "cancel", "don't", "dont", "back", "continue", "proceed"]
        is_yes = any(w in msg_lower for w in yes_words)
        is_no  = any(w in msg_lower for w in no_words)

        if is_yes:
            takeover_context = current_session.get("takeover_context", "")
            await _update_session_field(sender, pending_handoff=False)
            await set_human_takeover(sender, True, takeover_context=takeover_context)
            confirm_reply = "Our executive will be with you shortly. 🙏 Please hold on."
            _send_twilio_reply(sender, confirm_reply, from_number=receiver)
            await store_message(sender, "agent", confirm_reply, "system")
            logger.info(f"✅ User confirmed handoff — human takeover activated for {sender}")
            resp = MessagingResponse()
            return Response(content=str(resp), media_type="application/xml")

        elif is_no:
            await _update_session_field(sender, pending_handoff=False, takeover_context="")
            logger.info(f"❌ User declined handoff — resuming AI flow for {sender}")

        else:
            retry_msg = "I didn't quite catch that. Would you like to be connected to an executive? Please reply Yes or No."
            _send_twilio_reply(sender, retry_msg, from_number=receiver)
            await store_message(sender, "agent", retry_msg, "system")
            await _mark_agent_replied(sender)
            resp = MessagingResponse()
            return Response(content=str(resp), media_type="application/xml")

    # Send reply via Twilio API
    if user_sent_maps and is_completed and assistant_text:
        completion_indicators = ["received your appointment", "confirm your appointment", "reach out to you soon", "take care"]
        is_completion_msg = any(kw in assistant_text.lower() for kw in completion_indicators)
        if not is_completion_msg:
            completion_msg = mapping.get("completion_message", "") or "We've received your appointment request! We'll confirm your appointment shortly and our executive will reach out to you soon. Take care! 🙏"
            assistant_text = completion_msg
            logger.info(f"📍 Overriding Dograh reply with completion message for {sender}")

    if assistant_text:
        _send_twilio_reply(sender, assistant_text, from_number=receiver)
        await store_message(sender, "agent", assistant_text, "ai")
        await _mark_agent_replied(sender)
        clean_receiver = receiver.replace("whatsapp:", "").strip()
        await consume_quota(clean_receiver)

        if is_completed:
            await _set_lead_status(sender, "completed")
            if mapping.get("store_leads"):
                await _store_lead_from_chat(sender)
            logger.info(f"✅ Lead {sender} marked COMPLETED (is_completed=True)")
    else:
        if is_completed:
            await _set_lead_status(sender, "completed")
            if mapping.get("store_leads"):
                await _store_lead_from_chat(sender)
            logger.info(f"✅ Lead {sender} marked COMPLETED (silent completion)")
        else:
            fallback = "I'm sorry, I couldn't process your message. Please try again."
            _send_twilio_reply(sender, fallback, from_number=receiver)
            await store_message(sender, "agent", fallback, "ai")

    resp = MessagingResponse()
    return Response(content=str(resp), media_type="application/xml")


# ---------------------------------------------------------------------------
# Twilio helpers
# ---------------------------------------------------------------------------

def _split_message(body: str, max_len: int = 1500) -> list[str]:
    """Split a long message into chunks that fit within WhatsApp's 1600 char limit."""
    if len(body) <= max_len:
        return [body]

    chunks: list[str] = []
    while body:
        if len(body) <= max_len:
            chunks.append(body)
            break
        split_idx = body.rfind("\n", 0, max_len)
        if split_idx == -1 or split_idx < max_len // 2:
            split_idx = body.rfind(" ", 0, max_len)
        if split_idx == -1:
            split_idx = max_len
        chunks.append(body[:split_idx].rstrip())
        body = body[split_idx:].lstrip("\n ")
    return chunks


def _send_twilio_reply(to: str, body: str, media_url: str = "", content_sid: str = "", from_number: str = "") -> None:
    """Send a WhatsApp message via Twilio API."""
    if not twilio_client:
        logger.error("Twilio client not configured — cannot send reply")
        return

    if not from_number:
        from_number = f"whatsapp:{os.getenv('TWILIO_WHATSAPP_NUMBER', '')}"
    elif not from_number.startswith("whatsapp:"):
        from_number = f"whatsapp:{from_number}"

    # Template message
    if content_sid:
        try:
            msg = twilio_client.messages.create(from_=from_number, to=to, content_sid=content_sid)
            logger.info(f"📋 Template sent to {to} (SID: {msg.sid}, template: {content_sid})")
        except Exception as e:
            logger.error(f"❌ Failed to send template to {to}: {e}")
        return

    # Image + caption
    if media_url:
        try:
            msg = twilio_client.messages.create(from_=from_number, to=to, media_url=[media_url], body=body)
            logger.info(f"🖼️ Image+caption sent to {to} (SID: {msg.sid})")
        except Exception as e:
            logger.error(f"❌ Failed to send image to {to}: {e}")
            if body:
                _send_twilio_reply(to, body)
        return

    # Text only — split if needed
    chunks = _split_message(body)
    for chunk in chunks:
        try:
            message = twilio_client.messages.create(from_=from_number, to=to, body=chunk)
            logger.info(f"✅ Reply sent to {to} (SID: {message.sid})")
        except Exception as e:
            logger.error(f"❌ Failed to send reply to {to}: {e}")


# ---------------------------------------------------------------------------
# Dograh API
# ---------------------------------------------------------------------------

async def _send_to_dograh(
    *,
    api_key: str,
    trigger_path: str,
    session_key: str,
    text: str,
) -> dict:
    """Send a message to Dograh's public text-chat API and return the response."""
    url = f"{DOGRAH_API_BASE}/public/agent/text-chat/test/workflow/{trigger_path}/message"
    payload = {"session_key": session_key, "text": text}
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, json=payload, headers=headers)
        if response.status_code == 200:
            data = response.json()
            assistant_text = data.get("assistant_text")
            is_completed = data.get("is_completed", False)
            workflow_run_id = data.get("workflow_run_id")
            logger.info(
                f"🤖 Dograh reply for {session_key}: "
                f"{assistant_text[:80] if assistant_text else '(empty)'}"
                f"{' [COMPLETED]' if is_completed else ''}"
            )
            return {"assistant_text": assistant_text, "is_completed": is_completed, "workflow_run_id": workflow_run_id}
        else:
            logger.error(f"Dograh API error {response.status_code}: {response.text[:200]}")
            return {"assistant_text": None, "is_completed": False, "workflow_run_id": None}
    except httpx.TimeoutException:
        logger.error(f"Dograh API timeout for session {session_key}")
        return {"assistant_text": None, "is_completed": False, "workflow_run_id": None}
    except Exception as e:
        logger.error(f"Dograh API call failed: {e}")
        return {"assistant_text": None, "is_completed": False, "workflow_run_id": None}


# ---------------------------------------------------------------------------
# AgentX internal credits API
# ---------------------------------------------------------------------------

async def _agentx_internal(
    method: str, path: str, payload: dict | None = None
) -> dict:
    """Call AgentX's internal credits API, authenticating with the shared secret."""
    url = f"{AGENTX_INTERNAL_BASE}/internal/credits{path}"
    headers = {
        "X-Dograh-Internal-Secret": DOGRAH_INTERNAL_SECRET,
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.request(method, url, json=payload, headers=headers)
    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"AgentX credits API error: {response.text[:300]}",
        )
    return response.json()


# ---------------------------------------------------------------------------
# Quota
# ---------------------------------------------------------------------------

async def check_quota(agent_doc: dict) -> tuple[bool, str]:
    """Check if agent has quota remaining. Returns (allowed, reason)."""
    if not agent_doc.get("quota_enabled", False):
        return True, ""
    limit = agent_doc.get("quota_limit", 500)
    used = agent_doc.get("quota_used", 0)
    if used >= limit:
        return False, f"Quota exceeded ({used}/{limit} messages used)"
    return True, ""


async def consume_quota(phone_number: str) -> None:
    """Increment quota_used for the agent after a successful message."""
    if pg_pool is None:
        return
    row = await pg_pool.fetchrow(
        """UPDATE wa_agents SET quota_used = quota_used + 1
           WHERE phone_number = $1
           RETURNING quota_used, quota_limit, quota_enabled, agent_name""",
        phone_number,
    )
    if row and row["quota_enabled"]:
        logger.debug(f"💳 Quota: {row['quota_used']}/{row['quota_limit']} msgs used for '{row['agent_name']}'")


# ---------------------------------------------------------------------------
# Follow-up scheduler
# ---------------------------------------------------------------------------

FOLLOWUP_PROMPTS = [
    "[SYSTEM: The user has not replied for a while. Send a gentle follow-up based on where the conversation left off. If you were waiting for their name, ask for it again. If waiting for location, remind them. If waiting for confirmation, ask again. Keep it short, friendly, 1-2 lines. Don't repeat your exact last message — rephrase it.]",
    "[SYSTEM: Second follow-up. The user still hasn't replied. Send another brief reminder about whatever you last asked them. Different wording from before. Keep it warm and zero-pressure.]",
    "[SYSTEM: Final follow-up. The user hasn't responded after two reminders. Send a last gentle message saying you're here whenever they're ready, no rush. This is the final attempt.]",
]


async def _followup_loop() -> None:
    """Background loop: checks for idle sessions and sends follow-ups."""
    logger.info("🔄 Follow-up scheduler started.")
    while True:
        await asyncio.sleep(60)
        try:
            await _process_followups()
        except Exception as e:
            logger.error(f"Follow-up loop error: {e}")


async def _process_followups() -> None:
    """Scan sessions and send follow-ups where due."""
    now = datetime.now(timezone.utc)

    # Load enabled agents
    if pg_pool is not None:
        rows = await pg_pool.fetch(
            "SELECT * FROM wa_agents WHERE followups_enabled = true AND is_active = true"
        )
        agent_docs = [_row_to_dict(r) for r in rows]
    else:
        agent_docs = [
            {**v, "phone_number": k}
            for k, v in AGENT_MAPPINGS.items()
            if v.get("followups_enabled")
        ]

    if not agent_docs:
        return

    followup_agents = {doc["phone_number"] for doc in agent_docs}
    agent_map = {doc["phone_number"]: doc for doc in agent_docs}

    # Query eligible sessions
    if pg_pool is not None:
        # Build a WHERE clause that matches agent_number containing any of the followup agent numbers
        agent_patterns = [f"%{a}%" for a in followup_agents]
        placeholders = " OR ".join(f"agent_number LIKE ${i+1}" for i in range(len(agent_patterns)))
        query = f"""
            SELECT * FROM wa_sessions
            WHERE (lead_status IN ('active') OR lead_status IS NULL)
              AND (human_takeover = false OR human_takeover IS NULL)
              AND ({placeholders})
        """
        sessions_rows = await pg_pool.fetch(query, *agent_patterns)
        sessions = [_row_to_dict(r) for r in sessions_rows]
    else:
        sessions = [
            s for s in SESSIONS_STORE.values()
            if s.get("lead_status", "active") == "active"
            and not s.get("human_takeover")
            and any(a in s.get("agent_number", "") for a in followup_agents)
        ]

    logger.debug(f"🔍 Follow-up scan: found {len(sessions)} eligible session(s)")

    for session in sessions:
        phone_number = session["phone_number"]
        agent_number = session.get("agent_number", "")
        stage = session.get("followup_stage", 0)
        last_reply = session.get("last_agent_reply_at") or session.get("last_activity")

        if not last_reply or stage >= len(FOLLOWUP_PROMPTS):
            continue

        # Get agent doc for this session
        clean_agent = agent_number.replace("whatsapp:", "").strip()
        mapping = agent_map.get(clean_agent)
        if not mapping:
            if len(followup_agents) == 1:
                mapping = next(iter(agent_map.values()))
            else:
                continue

        delays = mapping.get("followup_delays", DEFAULT_FOLLOWUP_DELAYS)
        if isinstance(delays, str):
            delays = json.loads(delays)

        if stage >= len(delays):
            continue

        # Check if enough time has passed since last agent reply
        if isinstance(last_reply, str):
            last_reply = datetime.fromisoformat(last_reply.replace("Z", "+00:00"))
        if last_reply.tzinfo is None:
            last_reply = last_reply.replace(tzinfo=timezone.utc)

        elapsed = (now - last_reply).total_seconds()

        # Skip truly stale sessions (idle > 7 days)
        if elapsed > 86400 * 7:
            continue
        if elapsed < delays[stage]:
            continue

        # Skip if lead already completed/inactive/not_qualified
        current_session = await _get_session(phone_number)
        if current_session and current_session.get("lead_status") in ["completed", "inactive", "not_qualified"]:
            logger.debug(f"⏭️ Skipping follow-up for {phone_number} — lead_status={current_session.get('lead_status')}")
            continue

        logger.info(
            f"⏰ Follow-up {stage + 1} for {phone_number} "
            f"(idle {int(elapsed)}s, threshold {delays[stage]}s)"
        )

        try:
            api_key = mapping["api_key"]
            trigger_path = mapping["trigger_path"]
        except KeyError:
            continue

        followup_messages = mapping.get("followup_messages", [])
        if isinstance(followup_messages, str):
            followup_messages = json.loads(followup_messages)
        followup_item: dict = {}
        if stage < len(followup_messages):
            item = followup_messages[stage]
            if isinstance(item, dict):
                followup_item = item
            elif isinstance(item, str):
                followup_item = {"message": item, "template_sid": ""}

        custom_text  = (followup_item.get("message") or "").strip()
        template_sid = (followup_item.get("template_sid") or "").strip()
        is_over_24h  = delays[stage] >= 86400

        if is_over_24h:
            if not template_sid:
                logger.warning(
                    f"⏭️ Skipping follow-up {stage + 1} for {phone_number} — "
                    f"delay ≥24h ({delays[stage]}s) but no template_sid set."
                )
                await _increment_followup(phone_number, stage + 1)
                continue
            logger.info(f"📋 Using template follow-up {stage + 1} for {phone_number} (delay={delays[stage]}s ≥24h)")
            _send_twilio_reply(phone_number, "", content_sid=template_sid, from_number=agent_number)
            await store_message(phone_number, "agent", f"[Template: {template_sid}]", "followup")
            await _mark_agent_replied(phone_number)

        elif template_sid:
            logger.info(f"📋 Using template follow-up {stage + 1} for {phone_number} (optional, <24h)")
            _send_twilio_reply(phone_number, "", content_sid=template_sid, from_number=agent_number)
            await store_message(phone_number, "agent", f"[Template: {template_sid}]", "followup")
            await _mark_agent_replied(phone_number)

        elif custom_text:
            logger.info(f"📝 Using custom follow-up {stage + 1} for {phone_number}")
            _send_twilio_reply(phone_number, custom_text, from_number=agent_number)
            await store_message(phone_number, "agent", custom_text, "followup")
            await _mark_agent_replied(phone_number)

        else:
            dograh_response = await _send_to_dograh(
                api_key=api_key,
                trigger_path=trigger_path,
                session_key=phone_number,
                text=FOLLOWUP_PROMPTS[stage],
            )
            followup_text = dograh_response["assistant_text"]
            if followup_text:
                _send_twilio_reply(phone_number, followup_text, from_number=agent_number)
                await store_message(phone_number, "agent", followup_text, "followup")
                await _mark_agent_replied(phone_number)
            else:
                logger.warning(f"Dograh returned no text for follow-up {stage + 1}")

        new_stage = stage + 1
        await _increment_followup(phone_number, new_stage)

        if new_stage >= len(FOLLOWUP_PROMPTS):
            await _set_lead_status(phone_number, "inactive")
            logger.info(f"💤 Lead {phone_number} marked INACTIVE after {new_stage} follow-ups")


# ---------------------------------------------------------------------------
# Dashboard API endpoints
# ---------------------------------------------------------------------------


@app.get("/conversations")
async def get_conversations(agent_number: str = "", _auth: bool = Depends(require_operator)):
    """Get all conversations for the dashboard (cached 30s)."""
    now_mono = time.monotonic()
    cache_key = agent_number or "all"
    if CONVERSATIONS_CACHE.get(cache_key) and now_mono < CONVERSATIONS_CACHE.get(f"{cache_key}_expires", 0):
        return CONVERSATIONS_CACHE[cache_key]

    conversations = []

    if pg_pool is not None:
        if agent_number:
            clean = agent_number.replace("whatsapp:", "").strip()
            sessions_rows = await pg_pool.fetch(
                "SELECT * FROM wa_sessions WHERE agent_number LIKE $1 OR agent_number LIKE $2",
                clean, f"whatsapp:{clean}",
            )
        else:
            sessions_rows = await pg_pool.fetch("SELECT * FROM wa_sessions")

        for row in sessions_rows:
            phone_number = row["phone_number"]
            last_chat = await pg_pool.fetchrow(
                "SELECT content, timestamp FROM wa_chats WHERE phone_number = $1 ORDER BY timestamp DESC LIMIT 1",
                phone_number,
            )
            timestamp_str = ""
            if last_chat and last_chat["timestamp"]:
                ts = last_chat["timestamp"]
                timestamp_str = ts.isoformat() + ("Z" if ts.tzinfo is None else "").replace("+00:00", "Z")
            conversations.append({
                "phone_number": phone_number,
                "agent_number": (row.get("agent_number") or "").replace("whatsapp:", ""),
                "human_takeover": row.get("human_takeover", False),
                "lead_status": row.get("lead_status", "active"),
                "last_message": last_chat["content"] if last_chat else "",
                "last_message_time": timestamp_str,
            })
    else:
        for phone_number, session in SESSIONS_STORE.items():
            if agent_number:
                clean = agent_number.replace("whatsapp:", "").strip()
                ag = session.get("agent_number", "").replace("whatsapp:", "")
                if ag != clean:
                    continue
            messages = MESSAGE_STORE.get(phone_number, [])
            last_msg = messages[-1] if messages else None
            conversations.append({
                "phone_number": phone_number,
                "agent_number": session.get("agent_number", "").replace("whatsapp:", ""),
                "human_takeover": session.get("human_takeover", False),
                "lead_status": session.get("lead_status", "active"),
                "last_message": last_msg["content"] if last_msg else "",
                "last_message_time": last_msg["timestamp"] if last_msg else "",
            })

    conversations.sort(key=lambda x: x.get("last_message_time", ""), reverse=True)
    CONVERSATIONS_CACHE[cache_key] = conversations
    CONVERSATIONS_CACHE[f"{cache_key}_expires"] = now_mono + 30
    return conversations


@app.get("/messages/{phone_number:path}")
async def get_messages(phone_number: str, _auth: bool = Depends(require_operator)):
    """Get all messages for a specific conversation."""
    phone_number = phone_number.replace("%3A", ":")
    if pg_pool is not None:
        rows = await pg_pool.fetch(
            "SELECT sender, content, type, timestamp FROM wa_chats WHERE phone_number = $1 ORDER BY timestamp ASC",
            phone_number,
        )
        return [
            {
                "sender": r["sender"],
                "content": r["content"],
                "timestamp": r["timestamp"].isoformat() + "Z" if r["timestamp"] else "",
                "type": r["type"],
            }
            for r in rows
        ]
    else:
        return MESSAGE_STORE.get(phone_number, [])


@app.post("/takeover")
async def takeover_conversation(request: Request, _auth: bool = Depends(require_operator)):
    """Human agent takes over a conversation (AI stops responding)."""
    data = await request.json()
    phone_number = data.get("phone_number")
    if not phone_number:
        raise HTTPException(status_code=400, detail="phone_number is required")

    await set_human_takeover(phone_number, True)
    logger.info(f"🧑 Human takeover activated for {phone_number}")
    await store_message(phone_number, "agent", "A human agent has joined the conversation.", "system")
    return {"success": True, "message": "Takeover successful"}


@app.post("/release")
async def release_conversation(request: Request, _auth: bool = Depends(require_operator)):
    """Release conversation back to AI."""
    data = await request.json()
    phone_number = data.get("phone_number")
    if not phone_number:
        raise HTTPException(status_code=400, detail="phone_number is required")

    # Fetch stored takeover context before clearing
    takeover_context = ""
    session = await _get_session(phone_number)
    if session:
        takeover_context = session.get("takeover_context", "")

    await set_human_takeover(phone_number, False)
    logger.info(f"🤖 AI mode restored for {phone_number}")
    await store_message(phone_number, "agent", "Conversation returned to AI.", "system")

    # Send resume context to Dograh so AI picks up from the right step
    if takeover_context:
        try:
            agent_number = ""
            session = await _get_session(phone_number)
            if session:
                agent_number = (session.get("agent_number") or "").replace("whatsapp:", "")

            if agent_number:
                agent_doc = await _get_agent_doc(f"whatsapp:{agent_number}")
                api_key = agent_doc.get("api_key", "")
                trigger_path = agent_doc.get("trigger_path", "")

                if api_key and trigger_path:
                    resume_prompt = (
                        f"[SYSTEM: A human agent just handled part of this conversation. "
                        f"Context: {takeover_context} "
                        f"The human has now handed back control to you. "
                        f"Do NOT restart from the beginning. "
                        f"Resume naturally from where the conversation was. "
                        f"Send the appropriate next message to continue the flow.]"
                    )
                    resume_response = await _send_to_dograh(
                        api_key=api_key,
                        trigger_path=trigger_path,
                        session_key=phone_number,
                        text=resume_prompt,
                    )
                    resume_text = resume_response.get("assistant_text", "")
                    if resume_text and resume_text.startswith("[SEND_EXACT]:"):
                        resume_text = resume_text[len("[SEND_EXACT]:"):].strip()
                    if resume_text and "TRANSFER_TO_HUMAN" not in resume_text:
                        _send_twilio_reply(phone_number, resume_text, from_number=agent_number)
                        await store_message(phone_number, "agent", resume_text, "ai")
                        await _mark_agent_replied(phone_number)
                        logger.info(f"🔄 AI resumed for {phone_number}: {resume_text[:60]}")

            # Clear takeover context after using it
            await _update_session_field(phone_number, takeover_context="")
        except Exception as e:
            logger.warning(f"Failed to send resume context to Dograh: {e}")

    return {"success": True, "message": "Released to AI"}


@app.post("/webhook/lead-data")
async def receive_lead_data(request: Request):
    """Webhook endpoint called by Dograh's webhook node when a conversation completes."""
    data = await request.json()
    logger.info(f"📋 Lead data received: {json.dumps(data)[:200]}")

    gathered = data.get("gathered_context", {})
    initial = data.get("initial_context", {})
    phone_number = initial.get("phone_number", "")

    # Resolve agent_number from sessions
    agent_number = ""
    if phone_number and pg_pool is not None:
        row = await pg_pool.fetchrow(
            "SELECT agent_number FROM wa_sessions WHERE phone_number = $1 OR phone_number = $2",
            phone_number, f"whatsapp:{phone_number}",
        )
        if row:
            agent_number = (row["agent_number"] or "").replace("whatsapp:", "")

    now = datetime.now(timezone.utc)

    if pg_pool is not None:
        await pg_pool.execute(
            """INSERT INTO wa_leads (
                phone_number, agent_number, patient_name, concern, city, locality,
                user_location, notes, workflow_run_id, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)""",
            phone_number,
            agent_number,
            gathered.get("patient_name", ""),
            gathered.get("concern", ""),
            gathered.get("city", ""),
            gathered.get("locality", ""),
            gathered.get("user_location", ""),
            gathered.get("notes", ""),
            str(data.get("workflow_run_id", "")),
            now,
        )
        logger.info(f"💾 Lead stored: {gathered.get('patient_name', '')} - {gathered.get('concern', '')} - agent: {agent_number}")
    else:
        logger.warning("PostgreSQL unavailable — lead data not stored")

    return {"success": True}


@app.post("/send-message")
async def send_message(request: Request, _auth: bool = Depends(require_operator)):
    """Human agent sends a message via the dashboard."""
    data = await request.json()
    phone_number = data.get("phone_number")
    message = data.get("message")
    if not phone_number or not message:
        raise HTTPException(status_code=400, detail="phone_number and message are required")

    if not await get_human_takeover_status(phone_number):
        raise HTTPException(status_code=403, detail="Must take over conversation first")

    if not twilio_client:
        raise HTTPException(status_code=500, detail="Twilio client not configured")

    # Look up which agent number owns this conversation
    agent_number = None
    session = await _get_session(phone_number)
    if session:
        agent_number = session.get("agent_number")
    if not agent_number:
        raise HTTPException(
            status_code=500,
            detail=f"No agent number found for conversation with {phone_number}.",
        )
    from_number = f"whatsapp:{agent_number}" if not agent_number.startswith("whatsapp:") else agent_number
    try:
        twilio_message = twilio_client.messages.create(from_=from_number, to=phone_number, body=message)
        await store_message(phone_number, "agent", message, "human")
        logger.info(f"✅ Human agent sent message to {phone_number}")
        return {"success": True, "message": "Message sent", "sid": twilio_message.sid}
    except Exception as e:
        error_str = str(e)
        logger.error(f"❌ Error sending message: {error_str}")
        if "63016" in error_str:
            return {
                "success": False,
                "error": "Outside 24-hour messaging window. User must message first.",
                "error_code": "63016",
            }
        raise HTTPException(status_code=500, detail=error_str)


# ---------------------------------------------------------------------------
# Agents CRUD endpoints (for dashboard)
# ---------------------------------------------------------------------------


def _make_agent_prefix(agent_name: str) -> str:
    """Generate collection prefix from agent name."""
    prefix = agent_name.lower().strip()
    prefix = re.sub(r"[^a-z0-9]+", "_", prefix)
    prefix = prefix.strip("_")
    return prefix


def _serialize_agent(doc: dict) -> dict:
    """Serialize an agent dict for JSON response (mask API key)."""
    doc = dict(doc)
    doc.pop("id", None)
    for key in ("created_at", "updated_at"):
        val = doc.get(key)
        if isinstance(val, datetime):
            doc[key] = val.isoformat() + "Z" if val.tzinfo is None else val.isoformat().replace("+00:00", "Z")
    # Mask API key: show first 8 + last 4 chars
    if doc.get("api_key"):
        key = doc["api_key"]
        if len(key) > 12:
            doc["api_key"] = f"{key[:8]}...{key[-4:]}"
        else:
            doc["api_key"] = "***"
    # Ensure JSONB fields are serializable
    for jf in ("followup_delays", "followup_messages"):
        if isinstance(doc.get(jf), str):
            doc[jf] = json.loads(doc[jf])
    return doc


@app.get("/agents")
async def list_agents(_auth: bool = Depends(require_operator)):
    """List all agents."""
    if pg_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    rows = await pg_pool.fetch("SELECT * FROM wa_agents ORDER BY created_at DESC")
    return [_serialize_agent(_row_to_dict(r)) for r in rows]


@app.post("/agents")
async def create_agent(request: Request, _auth: bool = Depends(require_operator)):
    """Create a new agent."""
    if pg_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    data = await request.json()

    phone_number = data.get("phone_number", "").strip()
    agent_name = data.get("agent_name", "").strip()
    if not phone_number or not agent_name:
        raise HTTPException(status_code=400, detail="phone_number and agent_name are required")

    existing = await pg_pool.fetchrow(
        "SELECT id FROM wa_agents WHERE phone_number = $1", phone_number
    )
    if existing:
        raise HTTPException(status_code=409, detail=f"Agent with number {phone_number} already exists")

    collection_prefix = data.get("collection_prefix") or _make_agent_prefix(agent_name)
    now = datetime.now(timezone.utc)

    row = await pg_pool.fetchrow(
        """INSERT INTO wa_agents (
            phone_number, agent_name, collection_prefix, api_key, trigger_path,
            followups_enabled, followup_delays, followup_messages,
            greeting_message, greeting_image_url, greeting_window_hours,
            completion_message, store_leads, quota_enabled, quota_limit,
            quota_used, quota_reset_date, is_active, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,0,$16,$17,$18,$19)
        RETURNING *""",
        phone_number, agent_name, collection_prefix,
        data.get("api_key", ""), data.get("trigger_path", ""),
        data.get("followups_enabled", False),
        json.dumps(data.get("followup_delays", DEFAULT_FOLLOWUP_DELAYS)),
        json.dumps(data.get("followup_messages", [])),
        data.get("greeting_message", ""), data.get("greeting_image_url", ""),
        data.get("greeting_window_hours", 12),
        data.get("completion_message", ""),
        data.get("store_leads", False), data.get("quota_enabled", False),
        data.get("quota_limit", 500),
        now.strftime("%Y-%m-%d"),
        data.get("is_active", True),
        now, now,
    )
    logger.info(f"✅ Agent created: {agent_name} ({phone_number})")
    return _serialize_agent(_row_to_dict(row))


@app.get("/agents/{phone_number:path}")
async def get_agent(phone_number: str, _auth: bool = Depends(require_operator)):
    """Get a single agent by phone number."""
    if pg_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    phone_number = phone_number.replace("%2B", "+").strip()
    row = await pg_pool.fetchrow("SELECT * FROM wa_agents WHERE phone_number = $1", phone_number)
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found")
    return _serialize_agent(_row_to_dict(row))


@app.put("/agents/{phone_number:path}")
async def update_agent(phone_number: str, request: Request, _auth: bool = Depends(require_operator)):
    """Update an agent's config."""
    if pg_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    phone_number = phone_number.replace("%2B", "+").strip()
    data = await request.json()

    allowed_fields = {
        "agent_name", "api_key", "trigger_path",
        "followups_enabled", "followup_delays", "followup_messages",
        "greeting_message", "greeting_image_url", "greeting_window_hours",
        "completion_message", "store_leads", "is_active",
        "quota_enabled", "quota_limit",
    }
    update = {k: v for k, v in data.items() if k in allowed_fields}
    if not update:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    # Sanitize strings
    def _sanitize(obj):
        if isinstance(obj, str):
            return obj.encode("utf-8", errors="replace").decode("utf-8")
        if isinstance(obj, list):
            return [_sanitize(i) for i in obj]
        if isinstance(obj, dict):
            return {k: _sanitize(v) for k, v in obj.items()}
        return obj
    update = _sanitize(update)
    update["updated_at"] = datetime.now(timezone.utc)

    # Build dynamic UPDATE
    sets = []
    vals = [phone_number]
    idx = 2
    jsonb_fields = {"followup_delays", "followup_messages"}
    for k, v in update.items():
        if k in jsonb_fields:
            sets.append(f"{k} = ${idx}::jsonb")
            vals.append(json.dumps(v))
        else:
            sets.append(f"{k} = ${idx}")
            vals.append(v)
        idx += 1

    result = await pg_pool.execute(
        f"UPDATE wa_agents SET {', '.join(sets)} WHERE phone_number = $1",
        *vals,
    )
    if "UPDATE 0" in result:
        raise HTTPException(status_code=404, detail="Agent not found")

    row = await pg_pool.fetchrow("SELECT * FROM wa_agents WHERE phone_number = $1", phone_number)
    logger.info(f"✅ Agent updated: {phone_number} — fields: {list(update.keys())}")
    return _serialize_agent(_row_to_dict(row))


@app.delete("/agents/{phone_number:path}")
async def delete_agent(phone_number: str, _auth: bool = Depends(require_operator)):
    """Delete an agent."""
    if pg_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    phone_number = phone_number.replace("%2B", "+").strip()
    result = await pg_pool.execute("DELETE FROM wa_agents WHERE phone_number = $1", phone_number)
    if "DELETE 0" in result:
        raise HTTPException(status_code=404, detail="Agent not found")
    logger.info(f"🗑️ Agent deleted: {phone_number}")
    return {"success": True, "message": f"Agent {phone_number} deleted"}


@app.post("/agents/{phone_number:path}/reset-quota")
async def reset_agent_quota(phone_number: str, _auth: bool = Depends(require_operator)):
    """Reset quota_used to 0 for an agent."""
    if pg_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    phone_number = phone_number.replace("%2B", "+").strip()
    result = await pg_pool.execute(
        """UPDATE wa_agents SET quota_used = 0,
           quota_reset_date = $2, updated_at = $3
           WHERE phone_number = $1""",
        phone_number,
        datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        datetime.now(timezone.utc),
    )
    if "UPDATE 0" in result:
        raise HTTPException(status_code=404, detail="Agent not found")
    logger.info(f"🔄 Quota reset for {phone_number}")
    return {"success": True, "message": f"Quota reset for {phone_number}"}


# ---------------------------------------------------------------------------
# Leads endpoint
# ---------------------------------------------------------------------------

@app.get("/leads")
async def get_leads(limit: int = 100, skip: int = 0, agent_number: str = "", _auth: bool = Depends(require_operator)):
    """Get all captured leads, newest first."""
    if pg_pool is None:
        return []

    if agent_number:
        clean = agent_number.replace("whatsapp:", "").strip()
        rows = await pg_pool.fetch(
            """SELECT * FROM wa_leads
               WHERE agent_number = $1 OR agent_number = $2
               ORDER BY created_at DESC OFFSET $3 LIMIT $4""",
            clean, f"whatsapp:{clean}", skip, limit,
        )
    else:
        rows = await pg_pool.fetch(
            "SELECT * FROM wa_leads ORDER BY created_at DESC OFFSET $1 LIMIT $2",
            skip, limit,
        )

    result = []
    for row in rows:
        d = _row_to_dict(row)
        d.pop("id", None)
        if isinstance(d.get("created_at"), datetime):
            d["created_at"] = d["created_at"].isoformat() + "Z"
        result.append(d)
    return result


# ---------------------------------------------------------------------------
# Phase 6 — Operator billing console
#
# All routes are namespaced under /adapter/billing/ and gated by
# require_operator. The browser never holds the AgentX secret: these handlers
# forward to AgentX via _agentx_internal over the internal Docker network.
#
# No local billing storage — PostgreSQL (via AgentX) is the single source of
# truth for wallets, ledger entries, and payments.
# ---------------------------------------------------------------------------


_LIVE_BALANCE_FIELDS = (
    "email",
    "balance_usd",
    "display_currency",
    "display_fx_rate_to_usd",
    "balance_display",
    "is_blocked",
    "low_balance_threshold_usd",
)


def _apply_live_balance(account: dict, resolved: dict) -> dict:
    """Copy AgentX's live balance fields onto an account dict."""
    for field in _LIVE_BALANCE_FIELDS:
        value = resolved.get(field)
        if field == "email" and not value:
            continue
        account[field] = value
    return account


@app.post("/adapter/billing/resolve")
async def billing_resolve(
    request: Request, _auth: bool = Depends(require_operator)
):
    """Preview the AgentX account for an agent's phone number WITHOUT saving."""
    data = await request.json()
    agent_phone = (data.get("agent_phone") or "").strip()
    if not agent_phone:
        raise HTTPException(status_code=400, detail="agent_phone is required")

    # Look up agent from PostgreSQL
    clean = agent_phone.replace("%2B", "+").replace("whatsapp:", "").strip()
    if pg_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    agent = await pg_pool.fetchrow("SELECT api_key FROM wa_agents WHERE phone_number = $1", clean)
    if not agent:
        raise HTTPException(status_code=404, detail=f"No agent found for {clean}")
    api_key = (agent["api_key"] or "").strip()
    if not api_key:
        raise HTTPException(status_code=400, detail=f"Agent {clean} has no API key configured")

    return await _agentx_internal("POST", "/resolve-account", {"api_key": api_key})


@app.get("/adapter/billing/accounts")
async def billing_list_accounts(_auth: bool = Depends(require_operator)):
    """List all AgentX organizations directly from PostgreSQL via internal API.

    Reads live from AgentX so every org is always visible without manual steps.
    """
    try:
        orgs = await _agentx_internal("GET", "/organizations")
    except HTTPException as e:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach AgentX organizations API ({e.status_code}): {e.detail}",
        )

    accounts = []
    for org in orgs.get("organizations", []):
        organization_id = org.get("organization_id")
        email = org.get("email") or f"Org {organization_id}"
        account = {
            "organization_id": organization_id,
            "email": email,
            "label": email,
            "agent_numbers": [],
            "created_at": None,
            "updated_at": None,
        }
        try:
            live = await _agentx_internal(
                "POST", "/resolve-account", {"organization_id": organization_id},
            )
            _apply_live_balance(account, live)
        except HTTPException as e:
            account["balance_error"] = f"Could not fetch balance ({e.status_code})"
        accounts.append(account)

    return accounts


@app.get("/adapter/billing/accounts/{organization_id}")
async def billing_account_detail(
    organization_id: int, _auth: bool = Depends(require_operator)
):
    """Return an org's live balance and ledger from AgentX."""
    # Live balance
    resolved = await _agentx_internal(
        "POST", "/resolve-account", {"organization_id": organization_id}
    )
    account = {
        "organization_id": organization_id,
        "email": resolved.get("email", ""),
        "label": resolved.get("email", f"Org {organization_id}"),
    }
    _apply_live_balance(account, resolved)

    # Ledger from AgentX
    ledger = await _agentx_internal(
        "GET", f"/{organization_id}/ledger?page=1&limit=50"
    )

    return {"account": account, "ledger": ledger, "payments": []}


@app.post("/adapter/billing/accounts/{organization_id}/payments")
async def billing_record_payment(
    organization_id: int, request: Request, _auth: bool = Depends(require_operator)
):
    """Record a payment by calling AgentX /grant directly.

    The grant endpoint is idempotent (keyed by idempotency_key), so retries
    are safe. No local payment storage needed.
    """
    data = await request.json()

    paid_amount_minor = data.get("paid_amount_minor")
    if not isinstance(paid_amount_minor, int) or paid_amount_minor <= 0:
        raise HTTPException(
            status_code=400,
            detail="paid_amount_minor must be a positive integer (minor units)",
        )

    paid_currency = (data.get("paid_currency") or "").strip().upper()
    if len(paid_currency) != 3:
        raise HTTPException(status_code=400, detail="paid_currency must be a 3-letter code")

    # Generate idempotency key from client_request_id or a fresh UUID
    client_request_id = data.get("client_request_id") or str(uuid.uuid4())

    grant_payload = {
        "organization_id": organization_id,
        "idempotency_key": f"grant:{client_request_id}",
        "paid_amount_minor": paid_amount_minor,
        "paid_currency": paid_currency,
        "note": (data.get("note") or "").strip() or None,
    }

    fx_rate = data.get("fx_rate_to_usd")
    if fx_rate is not None:
        grant_payload["fx_rate_to_usd"] = str(fx_rate)

    try:
        result = await _agentx_internal("POST", "/grant", grant_payload)
    except HTTPException as e:
        logger.error(f"Grant failed for org {organization_id}: {e.detail}")
        raise

    logger.info(
        f"✅ Grant confirmed for org {organization_id}: "
        f"${result.get('credited_usd')} (duplicate={result.get('duplicate')})"
    )
    return {
        "status": "confirmed",
        "organization_id": organization_id,
        "credited_usd": result.get("credited_usd"),
        "balance_usd": result.get("balance_usd"),
        "entry_id": result.get("entry_id"),
        "duplicate": result.get("duplicate", False),
    }
