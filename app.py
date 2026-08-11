"""WhatsApp ↔ Dograh Adapter Service.

This lightweight service sits between Twilio (WhatsApp webhooks) and
Dograh's public text-chat API. It translates inbound WhatsApp messages
into Dograh workflow executions and sends the assistant's reply back
via Twilio.

Includes:
- Conversation tracking in MongoDB (for dashboard visibility)
- Human takeover mode (pause AI, let human respond from dashboard)
- Dashboard API endpoints for viewing/managing conversations

Supports multiple agents/numbers: configure AGENT_MAPPINGS to map
each Twilio WhatsApp number to its Dograh API key + trigger UUID.
"""

import asyncio
import json
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger
from motor.motor_asyncio import AsyncIOMotorClient
from twilio.rest import Client as TwilioClient
from twilio.twiml.messaging_response import MessagingResponse

load_dotenv()


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Dograh backend base URL (the /api/v1 prefix)
DOGRAH_API_BASE = os.getenv("DOGRAH_API_BASE", "http://localhost:8000/api/v1")

# Default agent config (single-agent setup)
DOGRAH_API_KEY = os.getenv("DOGRAH_API_KEY", "")
DOGRAH_TRIGGER_PATH = os.getenv("DOGRAH_TRIGGER_PATH", "")

# Twilio config
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_WHATSAPP_NUMBER = os.getenv("TWILIO_WHATSAPP_NUMBER", "")

# MongoDB config
MONGODB_URL = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
MONGODB_DATABASE = os.getenv("MONGODB_DATABASE", "whatsapp_adapter")

# Initialize Twilio client
twilio_client: TwilioClient | None = None
if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN:
    twilio_client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    logger.info("Twilio client initialized")

# For multi-agent setups, define a JSON mapping in the env:
# AGENT_MAPPINGS = {
#   "+14155551234": {"api_key": "dk_xxx", "trigger_path": "uuid-xxx"},
#   "+14155555678": {"api_key": "dk_yyy", "trigger_path": "uuid-yyy"}
# }

AGENT_MAPPINGS: dict = {}
_raw_mappings = os.getenv("AGENT_MAPPINGS", "")
if _raw_mappings:
    try:
        AGENT_MAPPINGS = json.loads(_raw_mappings)
        logger.info(f"Loaded {len(AGENT_MAPPINGS)} agent mapping(s)")
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse AGENT_MAPPINGS: {e}")


def _get_agent_config(to_number: str) -> tuple[str, str]:
    """Resolve which API key + trigger to use for a given Twilio number."""
    clean = to_number.replace("whatsapp:", "").strip()

    if clean in AGENT_MAPPINGS:
        mapping = AGENT_MAPPINGS[clean]
        return mapping["api_key"], mapping["trigger_path"]

    if DOGRAH_API_KEY and DOGRAH_TRIGGER_PATH:
        return DOGRAH_API_KEY, DOGRAH_TRIGGER_PATH

    raise ValueError(
        f"No agent mapping found for number {to_number}. "
        f"Set DOGRAH_API_KEY + DOGRAH_TRIGGER_PATH or configure AGENT_MAPPINGS."
    )


def _get_agent_mapping(to_number: str) -> dict:
    """Get the full agent mapping dict for a Twilio number."""
    clean = to_number.replace("whatsapp:", "").strip()
    if clean in AGENT_MAPPINGS:
        return AGENT_MAPPINGS[clean]
    return {"api_key": DOGRAH_API_KEY, "trigger_path": DOGRAH_TRIGGER_PATH}


# Follow-up delays (in seconds). Per-agent override via "followup_delays" key.
DEFAULT_FOLLOWUP_DELAYS = [300, 900, 1800, 10800]  # 5m, 15m, 30m, 3h


# ---------------------------------------------------------------------------
# MongoDB
# ---------------------------------------------------------------------------

mongo_client: AsyncIOMotorClient | None = None
db = None
sessions_collection = None
chats_collection = None

# In-memory fallback (if MongoDB is unavailable)
SESSIONS_STORE: dict = {}  # phone_number -> session dict
MESSAGE_STORE: dict = {}  # phone_number -> list of messages

# Dashboard cache
CONVERSATIONS_CACHE: dict = {"data": None, "expires_at": 0}


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="WhatsApp-Dograh Adapter")

# CORS — allow dashboard to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    """Initialize MongoDB connection and indexes."""
    global mongo_client, db, sessions_collection, chats_collection

    try:
        mongo_client = AsyncIOMotorClient(
            MONGODB_URL, serverSelectionTimeoutMS=5000)
        # Verify connection
        await mongo_client.admin.command("ping")
        db = mongo_client[MONGODB_DATABASE]
        sessions_collection = db["sessions"]
        chats_collection = db["chats"]

        # Create indexes
        await sessions_collection.create_index("phone_number", unique=True)
        await chats_collection.create_index([("phone_number", 1), ("timestamp", 1)])

        logger.info(f"✅ Connected to MongoDB: {MONGODB_DATABASE}")
    except Exception as e:
        logger.warning(
            f"⚠️ MongoDB unavailable ({e}), using in-memory storage")
        mongo_client = None

    # Start follow-up scheduler
    asyncio.create_task(_followup_loop())


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------


async def get_or_create_session(phone_number: str, agent_number: str = "") -> dict:
    """Get or create a session for the given phone number."""
    if sessions_collection is not None:
        session = await sessions_collection.find_one({"phone_number": phone_number})
        if session:
            return session
        new_session = {
            "phone_number": phone_number,
            "agent_number": agent_number,
            "human_takeover": False,
            "lead_status": "active",  # active | completed | not_qualified | inactive
            "followup_stage": 0,  # 0 = no followup sent yet, 1-3 = followup N sent
            "last_activity": datetime.now(timezone.utc),
            "last_agent_reply_at": datetime.now(timezone.utc),
            "created_at": datetime.now(timezone.utc),
        }
        await sessions_collection.insert_one(new_session)
        return new_session
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


async def store_message(
    phone_number: str, sender: str, content: str, msg_type: str
) -> None:
    """Store a message in the database."""
    now = datetime.now(timezone.utc)

    if chats_collection is not None:
        await chats_collection.insert_one(
            {
                "phone_number": phone_number,
                "sender": sender,
                "content": content,
                "timestamp": now,
                "type": msg_type,
            }
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

    # Update session last_activity
    if sessions_collection is not None:
        await sessions_collection.update_one(
            {"phone_number": phone_number},
            {"$set": {"last_activity": now}, "$inc": {"message_count": 1}},
            upsert=True,
        )

    # Invalidate conversations cache
    CONVERSATIONS_CACHE["data"] = None


async def get_human_takeover_status(phone_number: str) -> bool:
    """Check if a conversation is in human takeover mode."""
    if sessions_collection is not None:
        session = await sessions_collection.find_one({"phone_number": phone_number})
        return session.get("human_takeover", False) if session else False
    else:
        session = SESSIONS_STORE.get(phone_number)
        return session.get("human_takeover", False) if session else False


async def set_human_takeover(phone_number: str, status: bool) -> None:
    """Set human takeover status for a conversation."""
    now = datetime.now(timezone.utc)
    if sessions_collection is not None:
        await sessions_collection.update_one(
            {"phone_number": phone_number},
            {"$set": {"human_takeover": status, "last_activity": now}},
            upsert=True,
        )
    else:
        if phone_number not in SESSIONS_STORE:
            SESSIONS_STORE[phone_number] = {"phone_number": phone_number}
        SESSIONS_STORE[phone_number]["human_takeover"] = status
        SESSIONS_STORE[phone_number]["last_activity"] = now

    CONVERSATIONS_CACHE["data"] = None


async def _reset_followup(phone_number: str) -> None:
    """Reset follow-up stage when user replies (they're active again)."""
    now = datetime.now(timezone.utc)
    if sessions_collection is not None:
        await sessions_collection.update_one(
            {"phone_number": phone_number},
            {"$set": {
                "followup_stage": 0,
                "last_activity": now,
                "last_agent_reply_at": now,
            }},
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
    if sessions_collection is not None:
        await sessions_collection.update_one(
            {"phone_number": phone_number},
            {"$set": {"last_agent_reply_at": now}},
        )
    else:
        session = SESSIONS_STORE.get(phone_number)
        if session:
            session["last_agent_reply_at"] = now


async def _set_lead_status(phone_number: str, status: str) -> None:
    """Update lead status (active, completed, not_qualified, inactive)."""
    if sessions_collection is not None:
        await sessions_collection.update_one(
            {"phone_number": phone_number},
            {"$set": {"lead_status": status}},
        )
    else:
        session = SESSIONS_STORE.get(phone_number)
        if session:
            session["lead_status"] = status
    CONVERSATIONS_CACHE["data"] = None


async def _increment_followup(phone_number: str, stage: int) -> None:
    """Set the follow-up stage for a session."""
    if sessions_collection is not None:
        await sessions_collection.update_one(
            {"phone_number": phone_number},
            {"$set": {"followup_stage": stage}},
        )
    else:
        session = SESSIONS_STORE.get(phone_number)
        if session:
            session["followup_stage"] = stage


async def _store_lead_from_chat(phone_number: str) -> None:
    """Extract lead data from chat messages and store in 'leads' collection.

    Parses the full conversation to find: patient name, concern/pain area,
    city, locality, and location link. Uses simple pattern matching on the
    bot's questions and user's replies.
    """
    if db is None:
        return

    messages = []
    if chats_collection is not None:
        cursor = chats_collection.find(
            {"phone_number": phone_number}).sort("timestamp", 1)
        messages = await cursor.to_list(length=100)

    if not messages:
        return

    # Build full conversation text for extraction
    user_msgs = [m["content"] for m in messages if m["sender"] == "user"]
    all_text = " ".join(user_msgs).lower()

    # Extract location (Google Maps URL or coordinates)
    location = ""
    for msg in reversed(user_msgs):
        if "maps.google.com" in msg or "maps.app.goo.gl" in msg or "goo.gl" in msg:
            location = msg.strip()
            break

    # Extract name: usually a short reply (1-2 words) after bot asks for name
    name = ""
    for i, m in enumerate(messages):
        if m["sender"] == "agent" and "name" in m["content"].lower() and "please" in m["content"].lower():
            # Next user message is likely the name
            for j in range(i + 1, len(messages)):
                if messages[j]["sender"] == "user":
                    candidate = messages[j]["content"].strip()
                    # Name is usually short, not a number or URL
                    if len(candidate) < 40 and not candidate.startswith("http") and not candidate.isdigit():
                        name = candidate
                    break
            if name:
                break

    # Extract city/locality: reply after bot asks for city/area
    city_locality = ""
    for i, m in enumerate(messages):
        if m["sender"] == "agent" and ("city" in m["content"].lower() or "area" in m["content"].lower() or "locality" in m["content"].lower()):
            for j in range(i + 1, len(messages)):
                if messages[j]["sender"] == "user":
                    candidate = messages[j]["content"].strip()
                    if not candidate.startswith("http") and len(candidate) < 100:
                        city_locality = candidate
                    break
            if city_locality:
                break

    # Extract concern: first substantive user message about pain
    concern = ""
    for msg in user_msgs[0:5]:  # Check first few user messages
        pain_keywords = ["pain", "hurt", "ache", "injury", "surgery",
                         "paralysis", "stroke", "rehab", "stiff", "swell"]
        if any(kw in msg.lower() for kw in pain_keywords):
            concern = msg.strip()
            break

    lead_doc = {
        "phone_number": phone_number,
        "patient_name": name,
        "concern": concern,
        "city_locality": city_locality,
        "user_location": location,
        "lead_status": "completed",
        "created_at": datetime.now(timezone.utc),
    }

    leads_collection = db["leads"]
    await leads_collection.insert_one(lead_doc)
    logger.info(
        f"💾 Lead stored: {name} | {concern[:50]} | {city_locality} | {location[:50]}")


# ---------------------------------------------------------------------------
# Webhook endpoint
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {"status": "ok", "mongo": mongo_client is not None}


@app.post("/whatsapp")
async def whatsapp_webhook(
    request: Request,
    From: str = Form(...),
    To: str = Form(...),
    Body: str = Form(""),
    Latitude: str = Form(None),
    Longitude: str = Form(None),
):
    """Twilio WhatsApp webhook handler.

    Receives inbound messages, forwards them to Dograh's public text-chat
    API, and sends the assistant's reply back via Twilio API.

    If human_takeover is active for this conversation, the message is stored
    but NOT forwarded to Dograh — a human will respond from the dashboard.
    """
    user_message = Body.strip()
    sender = From  # e.g. "whatsapp:+919876543210"
    receiver = To  # e.g. "whatsapp:+14155551234"

    # Handle location pins (Twilio sends lat/lng separately, not in Body)
    if not user_message and Latitude and Longitude:
        user_message = f"https://maps.google.com/?q={Latitude},{Longitude}"
        logger.info(f"📍 Location pin from {sender}: {user_message}")

    logger.info(f"📩 Incoming from {sender}: {user_message[:100]}")

    if not user_message:
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Ensure session exists
    await get_or_create_session(sender, agent_number=receiver)

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
        api_key, trigger_path = _get_agent_config(receiver)
    except ValueError as e:
        logger.error(str(e))
        _send_twilio_reply(
            sender, "Sorry, this service is not configured. Please try again later."
        )
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Call Dograh's public text-chat endpoint
    dograh_response = await _send_to_dograh(
        api_key=api_key,
        trigger_path=trigger_path,
        session_key=sender,
        text=user_message,
    )
    assistant_text = dograh_response["assistant_text"]
    is_completed = dograh_response["is_completed"]

    # Send greeting on first interaction (only for agents with greeting configured)
    mapping = _get_agent_mapping(receiver)
    if assistant_text and mapping.get("greeting"):
        # Check if this is the first bot reply for this session
        is_first = True
        if chats_collection is not None:
            agent_msg_count = await chats_collection.count_documents(
                {"phone_number": sender, "sender": "agent"}
            )
            is_first = agent_msg_count == 0
            logger.debug(
                f"Greeting check: {sender} has {agent_msg_count} agent msgs, is_first={is_first}")
        if is_first and not assistant_text.startswith("Greetings"):
            _send_twilio_reply(sender, mapping["greeting"])
            await store_message(sender, "agent", mapping["greeting"], "ai")

    # Check if the agent is requesting a human handoff
    if assistant_text and "TRANSFER_TO_HUMAN" in assistant_text:
        # Activate human takeover mode
        await set_human_takeover(sender, True)
        handoff_msg = (
            "Connecting you to a support executive... "
            "Someone from our team will be with you shortly. 🙏"
        )
        _send_twilio_reply(sender, handoff_msg)
        await store_message(sender, "agent", handoff_msg, "system")
        logger.info(f"🔀 Human handoff triggered for {sender}")

        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Send reply via Twilio API
    if assistant_text:
        _send_twilio_reply(sender, assistant_text)
        await store_message(sender, "agent", assistant_text, "ai")
        await _mark_agent_replied(sender)

        # Use Dograh's is_completed flag (workflow transitioned to end node)
        if is_completed:
            await _set_lead_status(sender, "completed")
            await _store_lead_from_chat(sender)
            logger.info(
                f"✅ Lead {sender} marked COMPLETED (is_completed=True)")
        else:
            # Fallback: keyword detection for end states
            text_lower = assistant_text.lower()
            if any(kw in text_lower for kw in [
                "therapist will be assigned",
                "noted your location",
                "assign a therapist",
                "will assign",
                "session is now booked",
                "confirm your appointment",
                "confirm the appointment",
                "reach out to you soon",
                "thank you for sharing the location",
                "thank you for sharing your location",
            ]):
                await _set_lead_status(sender, "completed")
                await _store_lead_from_chat(sender)
                logger.info(
                    f"✅ Lead {sender} marked COMPLETED (keyword match)")
            elif any(kw in text_lower for kw in [
                "wishing you good health",
                "no worries at all",
                "feel free to reach out anytime",
                "change your mind",
                "wish you well",
            ]):
                await _set_lead_status(sender, "not_qualified")
                logger.info(f"🚫 Lead {sender} marked NOT_QUALIFIED")
    else:
        fallback = "I'm sorry, I couldn't process your message. Please try again."
        _send_twilio_reply(sender, fallback)
        await store_message(sender, "agent", fallback, "ai")

    resp = MessagingResponse()
    return Response(content=str(resp), media_type="application/xml")


def _split_message(body: str, max_len: int = 1500) -> list[str]:
    """Split a long message into chunks that fit within WhatsApp's 1600 char limit.

    Splits at newlines when possible to keep formatting intact.
    Uses 1500 as threshold to leave room for any Twilio overhead.
    """
    if len(body) <= max_len:
        return [body]

    chunks: list[str] = []
    while body:
        if len(body) <= max_len:
            chunks.append(body)
            break

        # Find a newline to split at (prefer splitting at paragraph/line boundaries)
        split_idx = body.rfind("\n", 0, max_len)
        if split_idx == -1 or split_idx < max_len // 2:
            # No good newline — split at last space
            split_idx = body.rfind(" ", 0, max_len)
        if split_idx == -1:
            # No space either — hard cut
            split_idx = max_len

        chunks.append(body[:split_idx].rstrip())
        body = body[split_idx:].lstrip("\n ")

    return chunks


def _send_twilio_reply(to: str, body: str) -> None:
    """Send a WhatsApp message via Twilio API.

    Automatically splits messages exceeding WhatsApp's 1600 char limit
    into multiple messages.
    """
    if not twilio_client:
        logger.error("Twilio client not configured — cannot send reply")
        return

    from_number = f"whatsapp:{TWILIO_WHATSAPP_NUMBER}"
    chunks = _split_message(body)

    for chunk in chunks:
        try:
            message = twilio_client.messages.create(
                from_=from_number,
                to=to,
                body=chunk,
            )
            logger.info(f"✅ Reply sent to {to} (SID: {message.sid})")
        except Exception as e:
            logger.error(f"❌ Failed to send reply to {to}: {e}")


async def _send_to_dograh(
    *,
    api_key: str,
    trigger_path: str,
    session_key: str,
    text: str,
) -> dict:
    """Send a message to Dograh's public text-chat API and return the response.

    Returns dict with keys: assistant_text, is_completed, workflow_run_id.
    """
    url = f"{DOGRAH_API_BASE}/public/agent/text-chat/test/workflow/{trigger_path}/message"

    payload = {
        "session_key": session_key,
        "text": text,
    }

    headers = {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
    }

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
            return {
                "assistant_text": assistant_text,
                "is_completed": is_completed,
                "workflow_run_id": workflow_run_id,
            }
        else:
            logger.error(
                f"Dograh API error {response.status_code}: {response.text[:200]}"
            )
            return {"assistant_text": None, "is_completed": False, "workflow_run_id": None}

    except httpx.TimeoutException:
        logger.error(f"Dograh API timeout for session {session_key}")
        return {"assistant_text": None, "is_completed": False, "workflow_run_id": None}
    except Exception as e:
        logger.error(f"Dograh API call failed: {e}")
        return {"assistant_text": None, "is_completed": False, "workflow_run_id": None}


# ---------------------------------------------------------------------------
# Follow-up Scheduler
# ---------------------------------------------------------------------------

FOLLOWUP_PROMPTS = [
    "[SYSTEM: The user has not replied for a while. Send a gentle follow-up based on where the conversation left off. If you were waiting for their name, ask for it again. If waiting for location, remind them. If waiting for confirmation, ask again. Keep it short, friendly, 1-2 lines. Don't repeat your exact last message — rephrase it.]",
    "[SYSTEM: Second follow-up. The user still hasn't replied. Send another brief reminder about whatever you last asked them. Different wording from before. Keep it warm and zero-pressure.]",
    "[SYSTEM: Final follow-up. The user hasn't responded after two reminders. Send a last gentle message saying you're here whenever they're ready, no rush. This is the final attempt.]",
]


async def _followup_loop() -> None:
    """Background loop: checks for idle sessions and sends follow-ups.

    Runs every 60s. Only fires for agents with followups_enabled=true.
    """
    # Log startup info
    followup_agents = [n for n, m in AGENT_MAPPINGS.items()
                       if m.get("followups_enabled")]
    logger.info(
        f"🔄 Follow-up scheduler started. Enabled agents: {followup_agents}")
    greeting_agents = {n: m.get("greeting")
                       for n, m in AGENT_MAPPINGS.items() if m.get("greeting")}
    logger.info(f"👋 Greeting configured: {greeting_agents}")

    while True:
        await asyncio.sleep(60)
        try:
            await _process_followups()
        except Exception as e:
            logger.error(f"Follow-up loop error: {e}")


async def _process_followups() -> None:
    """Scan sessions and send follow-ups where due."""
    now = datetime.now(timezone.utc)

    # Build set of agent numbers that have followups enabled
    followup_agents = set()
    for number, mapping in AGENT_MAPPINGS.items():
        if mapping.get("followups_enabled"):
            followup_agents.add(number)

    if not followup_agents:
        return

    # Query sessions that are active and have an agent_number in followup_agents
    if sessions_collection is not None:
        query = {
            # Sessions without lead_status are also "active" (old sessions)
            "lead_status": {"$in": ["active", None]},
            "human_takeover": {"$ne": True},
            "agent_number": {"$regex": "|".join(
                a.replace("+", "\\+") for a in followup_agents
            )},
        }
        sessions = await sessions_collection.find(query).to_list(length=500)
        # Also include sessions that don't have lead_status field at all
        no_status_query = {
            "lead_status": {"$exists": False},
            "human_takeover": {"$ne": True},
        }
        no_status_sessions = await sessions_collection.find(no_status_query).to_list(length=500)
        # Merge, dedup by phone_number
        seen = {s["phone_number"] for s in sessions}
        for s in no_status_sessions:
            if s["phone_number"] not in seen:
                sessions.append(s)
                seen.add(s["phone_number"])
    else:
        sessions = [
            s for s in SESSIONS_STORE.values()
            if s.get("lead_status", "active") == "active"
            and not s.get("human_takeover")
            and any(a in s.get("agent_number", "") for a in followup_agents)
        ]

    logger.debug(
        f"🔍 Follow-up scan: found {len(sessions)} eligible session(s)")

    for session in sessions:
        phone_number = session["phone_number"]
        agent_number = session.get("agent_number", "")
        stage = session.get("followup_stage", 0)
        last_reply = session.get(
            "last_agent_reply_at") or session.get("last_activity")

        if not last_reply or stage >= len(FOLLOWUP_PROMPTS):
            continue

        # Get delays for this agent — if agent_number is missing, use first followup-enabled agent
        clean_agent = agent_number.replace("whatsapp:", "").strip()
        mapping = AGENT_MAPPINGS.get(clean_agent, {})
        if not mapping.get("followups_enabled"):
            # Try to find a matching agent from the enabled set
            if len(followup_agents) == 1:
                clean_agent = next(iter(followup_agents))
                mapping = AGENT_MAPPINGS[clean_agent]
            else:
                continue
        delays = mapping.get("followup_delays", DEFAULT_FOLLOWUP_DELAYS)

        if stage >= len(delays):
            continue

        # Check if enough time has passed since last agent reply
        if isinstance(last_reply, str):
            last_reply = datetime.fromisoformat(
                last_reply.replace("Z", "+00:00"))
        # Handle naive datetimes from old sessions
        if last_reply.tzinfo is None:
            last_reply = last_reply.replace(tzinfo=timezone.utc)

        elapsed = (now - last_reply).total_seconds()

        # Skip stale sessions (idle > 24h) — these are old/abandoned
        if elapsed > 86400:
            continue
        if elapsed < delays[stage]:
            continue

        # Time to send follow-up
        logger.info(
            f"⏰ Follow-up {stage + 1} for {phone_number} "
            f"(idle {int(elapsed)}s, threshold {delays[stage]}s)"
        )

        try:
            api_key, trigger_path = mapping["api_key"], mapping["trigger_path"]
        except KeyError:
            continue

        # Send synthetic message to Dograh to get context-aware follow-up
        dograh_response = await _send_to_dograh(
            api_key=api_key,
            trigger_path=trigger_path,
            session_key=phone_number,
            text=FOLLOWUP_PROMPTS[stage],
        )
        followup_text = dograh_response["assistant_text"]

        if followup_text:
            _send_twilio_reply(phone_number, followup_text)
            await store_message(phone_number, "agent", followup_text, "followup")
            await _mark_agent_replied(phone_number)
        else:
            logger.warning(
                f"Dograh returned no text for follow-up {stage + 1}")

        new_stage = stage + 1
        await _increment_followup(phone_number, new_stage)

        # If all follow-ups exhausted, mark inactive
        if new_stage >= len(FOLLOWUP_PROMPTS):
            await _set_lead_status(phone_number, "inactive")
            logger.info(
                f"💤 Lead {phone_number} marked INACTIVE after {new_stage} follow-ups")


# ---------------------------------------------------------------------------
# Dashboard API endpoints
# ---------------------------------------------------------------------------


@app.get("/conversations")
async def get_conversations():
    """Get all conversations for the dashboard (cached 30s)."""
    now = time.monotonic()
    if CONVERSATIONS_CACHE["data"] is not None and now < CONVERSATIONS_CACHE["expires_at"]:
        return CONVERSATIONS_CACHE["data"]

    conversations = []

    if sessions_collection is not None:
        async for session in sessions_collection.find({}):
            phone_number = session["phone_number"]
            last_chat = await chats_collection.find_one(
                {"phone_number": phone_number}, sort=[("timestamp", -1)]
            )

            timestamp_str = ""
            if last_chat and last_chat.get("timestamp"):
                timestamp_str = last_chat["timestamp"].isoformat() + "Z"

            conversations.append(
                {
                    "phone_number": phone_number,
                    "human_takeover": session.get("human_takeover", False),
                    "last_message": last_chat["content"] if last_chat else "",
                    "last_message_time": timestamp_str,
                }
            )
    else:
        for phone_number, session in SESSIONS_STORE.items():
            messages = MESSAGE_STORE.get(phone_number, [])
            last_msg = messages[-1] if messages else None
            conversations.append(
                {
                    "phone_number": phone_number,
                    "human_takeover": session.get("human_takeover", False),
                    "last_message": last_msg["content"] if last_msg else "",
                    "last_message_time": last_msg["timestamp"] if last_msg else "",
                }
            )

    CONVERSATIONS_CACHE["data"] = conversations
    CONVERSATIONS_CACHE["expires_at"] = now + 30
    return conversations


@app.get("/messages/{phone_number:path}")
async def get_messages(phone_number: str):
    """Get all messages for a specific conversation."""
    phone_number = phone_number.replace("%3A", ":")

    if chats_collection is not None:
        cursor = chats_collection.find({"phone_number": phone_number}).sort(
            "timestamp", 1
        )
        messages = await cursor.to_list(length=None)
        return [
            {
                "sender": msg["sender"],
                "content": msg["content"],
                "timestamp": msg["timestamp"].isoformat() + "Z",
                "type": msg["type"],
            }
            for msg in messages
        ]
    else:
        return MESSAGE_STORE.get(phone_number, [])


@app.post("/takeover")
async def takeover_conversation(request: Request):
    """Human agent takes over a conversation (AI stops responding)."""
    data = await request.json()
    phone_number = data.get("phone_number")

    if not phone_number:
        raise HTTPException(status_code=400, detail="phone_number is required")

    await set_human_takeover(phone_number, True)
    logger.info(f"🧑 Human takeover activated for {phone_number}")

    await store_message(
        phone_number, "agent", "A human agent has joined the conversation.", "system"
    )

    return {"success": True, "message": "Takeover successful"}


@app.post("/release")
async def release_conversation(request: Request):
    """Release conversation back to AI."""
    data = await request.json()
    phone_number = data.get("phone_number")

    if not phone_number:
        raise HTTPException(status_code=400, detail="phone_number is required")

    await set_human_takeover(phone_number, False)
    logger.info(f"🤖 AI mode restored for {phone_number}")

    await store_message(
        phone_number, "agent", "Conversation returned to AI.", "system"
    )

    return {"success": True, "message": "Released to AI"}


@app.post("/webhook/lead-data")
async def receive_lead_data(request: Request):
    """Webhook endpoint called by Dograh's webhook node when a conversation completes.

    Receives extracted variables (patient_name, concern, city, locality,
    user_location, notes) and stores them in MongoDB collection 'leads'.
    """
    data = await request.json()
    logger.info(f"📋 Lead data received: {json.dumps(data)[:200]}")

    # Dograh webhook payload uses gathered_context for extraction vars
    gathered = data.get("gathered_context", {})
    initial = data.get("initial_context", {})

    lead_doc = {
        "patient_name": gathered.get("patient_name", ""),
        "concern": gathered.get("concern", ""),
        "city": gathered.get("city", ""),
        "locality": gathered.get("locality", ""),
        "user_location": gathered.get("user_location", ""),
        "notes": gathered.get("notes", ""),
        "phone_number": initial.get("phone_number", ""),
        "workflow_run_id": data.get("workflow_run_id", ""),
        "created_at": datetime.now(timezone.utc),
    }

    if db is not None:
        leads_collection = db["leads"]
        await leads_collection.insert_one(lead_doc)
        logger.info(
            f"💾 Lead stored: {lead_doc['patient_name']} - {lead_doc['concern']}")
    else:
        logger.warning("MongoDB unavailable — lead data not stored")

    return {"success": True}


@app.post("/send-message")
async def send_message(request: Request):
    """Human agent sends a message via the dashboard."""
    data = await request.json()
    phone_number = data.get("phone_number")
    message = data.get("message")

    if not phone_number or not message:
        raise HTTPException(
            status_code=400, detail="phone_number and message are required"
        )

    # Check if human has taken over
    if not await get_human_takeover_status(phone_number):
        raise HTTPException(
            status_code=403, detail="Must take over conversation first"
        )

    # Send via Twilio
    if not twilio_client:
        raise HTTPException(
            status_code=500, detail="Twilio client not configured")

    from_number = f"whatsapp:{TWILIO_WHATSAPP_NUMBER}"
    try:
        twilio_message = twilio_client.messages.create(
            from_=from_number,
            to=phone_number,
            body=message,
        )
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
