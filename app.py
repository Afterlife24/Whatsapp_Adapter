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

# AGENT_MAPPINGS from env — used ONLY for one-time migration to MongoDB on first startup.
# After migration, all agent config is read from the 'agents' MongoDB collection.
AGENT_MAPPINGS: dict = {}
_raw_mappings = os.getenv("AGENT_MAPPINGS", "")
if _raw_mappings:
    try:
        AGENT_MAPPINGS = json.loads(_raw_mappings)
        logger.info(f"Loaded {len(AGENT_MAPPINGS)} agent mapping(s) for migration")
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse AGENT_MAPPINGS: {e}")


async def _get_agent_doc(to_number: str) -> dict:
    """Look up agent config from MongoDB agents collection by phone number."""
    clean = to_number.replace("whatsapp:", "").strip()
    if agents_collection is not None:
        doc = await agents_collection.find_one({"phone_number": clean, "is_active": True})
        if doc:
            return doc
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


async def _migrate_env_agents_to_db() -> None:
    """One-time migration: move AGENT_MAPPINGS from .env into MongoDB agents collection.

    Runs at startup. If the agents collection already has documents, skip.
    This ensures existing agents are preserved after the first deploy.
    """
    if agents_collection is None or not AGENT_MAPPINGS:
        return
    count = await agents_collection.count_documents({})
    if count > 0:
        logger.info(f"✅ Agents collection has {count} agent(s) — skipping migration")
        return
    docs = []
    for phone_number, mapping in AGENT_MAPPINGS.items():
        agent_name = mapping.get("agent_name", f"Agent {phone_number}")
        collection_prefix = agent_name.lower().replace(" ", "_").replace("-", "_")
        doc = {
            "phone_number": phone_number,
            "agent_name": agent_name,
            "collection_prefix": collection_prefix,
            "api_key": mapping.get("api_key", ""),
            "trigger_path": mapping.get("trigger_path", ""),
            "followups_enabled": mapping.get("followups_enabled", False),
            "followup_delays": mapping.get("followup_delays", DEFAULT_FOLLOWUP_DELAYS),
            "greeting_message": mapping.get("greeting", ""),
            "greeting_image_url": mapping.get("greeting_image_url", ""),
            "greeting_window_hours": mapping.get("greeting_window_hours", 12),
            "store_leads": mapping.get("store_leads", False),
            "quota_enabled": mapping.get("quota_enabled", False),
            "quota_limit": mapping.get("quota_limit", 500),
            "quota_used": mapping.get("quota_used", 0),
            "quota_reset_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "is_active": True,
            "created_at": datetime.now(timezone.utc),
        }
        docs.append(doc)
    if docs:
        await agents_collection.insert_many(docs)
        logger.info(f"✅ Migrated {len(docs)} agent(s) from .env to MongoDB")


# Follow-up delays (in seconds). Per-agent override via "followup_delays" key.
DEFAULT_FOLLOWUP_DELAYS = [300, 900, 1800, 10800]  # 5m, 15m, 30m, 3h


# ---------------------------------------------------------------------------
# MongoDB
# ---------------------------------------------------------------------------

mongo_client: AsyncIOMotorClient | None = None
db = None
sessions_collection = None
chats_collection = None
agents_collection = None

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
    global mongo_client, db, sessions_collection, chats_collection, agents_collection

    try:
        mongo_client = AsyncIOMotorClient(
            MONGODB_URL, serverSelectionTimeoutMS=5000)
        # Verify connection
        await mongo_client.admin.command("ping")
        db = mongo_client[MONGODB_DATABASE]
        sessions_collection = db["sessions"]
        chats_collection = db["chats"]
        agents_collection = db["agents"]

        # Create indexes
        await sessions_collection.create_index("phone_number", unique=True)
        await chats_collection.create_index([("phone_number", 1), ("timestamp", 1)])
        await agents_collection.create_index("phone_number", unique=True)

        logger.info(f"✅ Connected to MongoDB: {MONGODB_DATABASE}")

        # One-time migration: .env AGENT_MAPPINGS → MongoDB agents collection
        await _migrate_env_agents_to_db()
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
    CONVERSATIONS_CACHE.clear()


async def get_human_takeover_status(phone_number: str) -> bool:
    """Check if a conversation is in human takeover mode."""
    if sessions_collection is not None:
        session = await sessions_collection.find_one({"phone_number": phone_number})
        return session.get("human_takeover", False) if session else False
    else:
        session = SESSIONS_STORE.get(phone_number)
        return session.get("human_takeover", False) if session else False


async def set_human_takeover(phone_number: str, status: bool, takeover_context: str = "") -> None:
    """Set human takeover status for a conversation.
    
    When activating (status=True), stores takeover_context so AI can resume
    from the right point when human releases back to AI.
    """
    now = datetime.now(timezone.utc)
    update_fields: dict = {"human_takeover": status, "last_activity": now}
    if status and takeover_context:
        update_fields["takeover_context"] = takeover_context
    elif not status:
        # Clearing takeover — don't wipe context yet, release handler uses it
        pass

    if sessions_collection is not None:
        await sessions_collection.update_one(
            {"phone_number": phone_number},
            {"$set": update_fields},
            upsert=True,
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
    CONVERSATIONS_CACHE.clear()


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
    """Store lead data. Uses Dograh's gathered_context if available, else chat parsing."""
    if db is None:
        return

    # Get session for workflow_run_id
    session = None
    if sessions_collection is not None:
        session = await sessions_collection.find_one({"phone_number": phone_number})

    # Fallback: parse from chat messages
    messages = []
    if chats_collection is not None:
        cursor = chats_collection.find(
            {"phone_number": phone_number}).sort("timestamp", 1)
        messages = await cursor.to_list(length=100)

    user_msgs = [m["content"] for m in messages if m["sender"] == "user"]

    # Location (Google Maps URL)
    location = ""
    for msg in reversed(user_msgs):
        if "maps.google.com" in msg or "maps.app.goo.gl" in msg or "goo.gl" in msg:
            location = msg.strip()
            break

    # Name: reply after bot asks "name" — skip if reply is "no", "yes", numbers, urls
    name = ""
    for i, m in enumerate(messages):
        if m["sender"] == "agent" and "name" in m["content"].lower():
            for j in range(i + 1, len(messages)):
                if messages[j]["sender"] == "user":
                    c = messages[j]["content"].strip()
                    if (len(c) < 30 and not c.startswith("http")
                            and not c.isdigit() and c.lower() not in ("no", "yes", "ok", "yah", "yeah")):
                        name = c.split(" from ")[0].strip(
                        ) if " from " in c.lower() else c
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

    lead_doc = {
        "phone_number": phone_number,
        "agent_number": session.get("agent_number", "") if session else "",
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
    MediaUrl0: str = Form(None),
    MediaContentType0: str = Form(None),
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

    # Handle WhatsApp location pins (Twilio sends lat/lng separately)
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
        api_key, trigger_path = await _get_agent_config(receiver)
    except ValueError as e:
        logger.error(str(e))
        _send_twilio_reply(
            sender, "Sorry, this service is not configured. Please try again later."
        )
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Check quota before calling Dograh
    agent_doc = await _get_agent_mapping(receiver)
    allowed, quota_reason = await check_quota(agent_doc)
    if not allowed:
        logger.warning(f"🚫 Quota exceeded for {receiver}: {quota_reason}")
        _send_twilio_reply(sender, "Sorry, this service is temporarily unavailable. Please try again later.")
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Check if user is responding to a pending handoff confirmation (BEFORE Dograh call)
    if sessions_collection is not None:
        pending_session = await sessions_collection.find_one({"phone_number": sender})
        if pending_session and pending_session.get("pending_handoff"):
            msg_lower = user_message.lower().strip()
            yes_words = ["yes", "yeah", "ok", "okay", "sure", "please", "connect", "transfer", "ya", "yep", "fine"]
            no_words  = ["no", "nope", "nah", "cancel", "don't", "dont", "back", "continue", "proceed"]
            is_yes = any(w in msg_lower for w in yes_words)
            is_no  = any(w in msg_lower for w in no_words)

            if is_yes:
                takeover_ctx = pending_session.get("takeover_context", "")
                await sessions_collection.update_one(
                    {"phone_number": sender},
                    {"$set": {"pending_handoff": False}}
                )
                await set_human_takeover(sender, True, takeover_context=takeover_ctx)
                confirm_reply = "Our executive will be with you shortly. 🙏 Please hold on."
                _send_twilio_reply(sender, confirm_reply)
                await store_message(sender, "agent", confirm_reply, "system")
                logger.info(f"✅ User confirmed handoff — human takeover activated for {sender}")
                resp = MessagingResponse()
                return Response(content=str(resp), media_type="application/xml")

            elif is_no:
                await sessions_collection.update_one(
                    {"phone_number": sender},
                    {"$set": {"pending_handoff": False}, "$unset": {"takeover_context": ""}}
                )
                no_reply = "No problem! Our standard fee is Rs.800 per session. Would you like to proceed with booking?"
                _send_twilio_reply(sender, no_reply)
                await store_message(sender, "agent", no_reply, "ai")
                await _mark_agent_replied(sender)
                logger.info(f"❌ User declined handoff — AI continues for {sender}")
                resp = MessagingResponse()
                return Response(content=str(resp), media_type="application/xml")

            else:
                retry_msg = "I didn't quite catch that. Would you like to be connected to an executive? Please reply Yes or No."
                _send_twilio_reply(sender, retry_msg)
                await store_message(sender, "agent", retry_msg, "system")
                await _mark_agent_replied(sender)
                resp = MessagingResponse()
                return Response(content=str(resp), media_type="application/xml")

    # If lead already completed/inactive/not_qualified — re-engage with fresh greeting
    if sessions_collection is not None:
        existing_session = await sessions_collection.find_one({"phone_number": sender})
        if existing_session and existing_session.get("lead_status") in ["completed", "inactive", "not_qualified"]:
            old_status = existing_session.get("lead_status")
            logger.info(f"🔄 Re-engaging {sender} (was {old_status}) — resetting session")
            # Reset lead status and followup stage
            await _set_lead_status(sender, "active")
            await _reset_followup(sender)
            # Send greeting + image (same as new user)
            mapping = await _get_agent_mapping(receiver)
            if mapping.get("greeting_message"):
                image_url = mapping.get("greeting_image_url", "")
                _send_twilio_reply(sender, mapping["greeting_message"], media_url=image_url)
                await store_message(sender, "agent", mapping["greeting_message"], "ai")
                await _mark_agent_replied(sender)
                logger.info(f"👋 Re-engagement greeting sent to {sender}")
            resp = MessagingResponse()
            return Response(content=str(resp), media_type="application/xml")

    # Maps link interception — if user sends maps URL, handle completion directly
    # Dograh's LLM sometimes fails to match edge conditions on maps URLs
    # This is the reliable fallback: adapter detects it and marks completed
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
        # Check session is active (not already completed)
        if sessions_collection is not None:
            cur_session = await sessions_collection.find_one({"phone_number": sender})
            if cur_session and cur_session.get("lead_status") == "active":
                logger.info(f"📍 Maps link detected, Dograh didn't complete — forcing completion for {sender}")
                is_completed = True

    # Strip [SEND_EXACT]: prefix if Dograh returns it — user should never see this prefix
    if assistant_text and assistant_text.startswith("[SEND_EXACT]:"):
        assistant_text = assistant_text[len("[SEND_EXACT]:"):].strip()

    # Send greeting only on the very first message ever in this conversation.
    # We check the total number of agent messages in the entire chat history —
    # NOT a time window. This prevents re-greeting mid-conversation if the user
    # goes quiet for an hour and comes back.
    mapping = await _get_agent_mapping(receiver)
    greeting_sent = False
    if assistant_text and mapping.get("greeting_message"):
        should_greet = False
        if chats_collection is not None:
            total_agent_msgs = await chats_collection.count_documents(
                {"phone_number": sender, "sender": "agent"}
            )
            should_greet = total_agent_msgs == 0
            logger.debug(
                f"Greeting check: {sender} has {total_agent_msgs} agent msgs total, should_greet={should_greet}")
        else:
            # In-memory fallback — greet if no messages stored at all
            should_greet = len(MESSAGE_STORE.get(sender, [])) == 0

        if should_greet and not assistant_text.startswith("Greetings"):
            image_url = mapping.get("greeting_image_url", "")
            _send_twilio_reply(sender, mapping["greeting_message"], media_url=image_url)
            await store_message(sender, "agent", mapping["greeting_message"], "ai")
            await _mark_agent_replied(sender)
            greeting_sent = True
            logger.info(f"👋 Greeting sent to {sender}{' (with image)' if image_url else ''} — skipping Dograh reply")

    if greeting_sent:
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Check if the agent is requesting a human handoff
    if assistant_text and "TRANSFER_TO_HUMAN" in assistant_text:
        # Strip TRANSFER_TO_HUMAN from the message
        clean_text = assistant_text.replace("TRANSFER_TO_HUMAN", "").strip()

        # Build takeover context for later resume
        takeover_context = (
            f"The user was in the middle of a conversation. "
            f"Last AI message before handoff: {clean_text or 'Pricing/discount discussion'}. "
            f"When AI resumes, continue from where the conversation was — "
            f"do not restart from the beginning."
        )

        # Store pending handoff — don't activate yet, ask user first
        if sessions_collection is not None:
            await sessions_collection.update_one(
                {"phone_number": sender},
                {"$set": {
                    "pending_handoff": True,
                    "takeover_context": takeover_context,
                }},
                upsert=True,
            )

        # Ask user for confirmation
        confirm_msg = (
            "I'd like to connect you with our team executive who can assist you better. "
            "Would you like me to transfer you to an executive? (Yes/No)"
        )
        _send_twilio_reply(sender, confirm_msg)
        await store_message(sender, "agent", confirm_msg, "system")
        await _mark_agent_replied(sender)
        logger.info(f"🔀 Pending handoff — confirmation requested for {sender}")

        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Check if user is responding to a pending handoff confirmation
    if sessions_collection is not None:
        current_session = await sessions_collection.find_one({"phone_number": sender})
        if current_session and current_session.get("pending_handoff"):
            # Check user's response
            msg_lower = user_message.lower().strip()
            yes_words = ["yes", "yeah", "ok", "okay", "sure", "please", "connect", "transfer", "ya", "yep", "fine"]
            no_words = ["no", "nope", "nah", "cancel", "don't", "dont", "back", "continue", "proceed"]

            is_yes = any(w in msg_lower for w in yes_words)
            is_no  = any(w in msg_lower for w in no_words)

            if is_yes:
                # User confirmed — activate human takeover
                takeover_context = current_session.get("takeover_context", "")
                await sessions_collection.update_one(
                    {"phone_number": sender},
                    {"$set": {"pending_handoff": False}}
                )
                await set_human_takeover(sender, True, takeover_context=takeover_context)
                confirm_reply = "Our executive will be with you shortly. 🙏 Please hold on."
                _send_twilio_reply(sender, confirm_reply)
                await store_message(sender, "agent", confirm_reply, "system")
                logger.info(f"✅ User confirmed handoff — human takeover activated for {sender}")
                resp = MessagingResponse()
                return Response(content=str(resp), media_type="application/xml")

            elif is_no:
                # User declined — clear pending handoff and resume flow
                await sessions_collection.update_one(
                    {"phone_number": sender},
                    {"$set": {"pending_handoff": False}, "$unset": {"takeover_context": ""}}
                )
                # Resume from where they were — send back to Dograh
                logger.info(f"❌ User declined handoff — resuming AI flow for {sender}")
                # Fall through to normal Dograh call below with original message
            else:
                # Unclear response — ask again
                retry_msg = "I didn't quite catch that. Would you like to be connected to an executive? Please reply Yes or No."
                _send_twilio_reply(sender, retry_msg)
                await store_message(sender, "agent", retry_msg, "system")
                await _mark_agent_replied(sender)
                resp = MessagingResponse()
                return Response(content=str(resp), media_type="application/xml")

    # Send reply via Twilio API
    # If forced completion from maps link — override Dograh's reply with completion message
    if user_sent_maps and is_completed and assistant_text:
        # Check if Dograh's reply is NOT the completion message (i.e. wrong reply)
        completion_indicators = ["received your appointment", "confirm your appointment", "reach out to you soon", "take care"]
        is_completion_msg = any(kw in assistant_text.lower() for kw in completion_indicators)
        if not is_completion_msg:
            # Override with completion message from agent config or default
            completion_msg = mapping.get("completion_message", "") or "We've received your appointment request! We'll confirm your appointment shortly and our executive will reach out to you soon. Take care! 🙏"
            assistant_text = completion_msg
            logger.info(f"📍 Overriding Dograh reply with completion message for {sender}")

    if assistant_text:
        _send_twilio_reply(sender, assistant_text)
        await store_message(sender, "agent", assistant_text, "ai")
        await _mark_agent_replied(sender)
        # Consume quota after successful reply
        clean_receiver = receiver.replace("whatsapp:", "").strip()
        await consume_quota(clean_receiver)

        # Use Dograh's is_completed flag ONLY — no keyword detection
        # Keywords caused false completions when FAQ answers matched completion phrases
        if is_completed:
            await _set_lead_status(sender, "completed")
            if mapping.get("store_leads"):
                await _store_lead_from_chat(sender)
            logger.info(
                f"✅ Lead {sender} marked COMPLETED (is_completed=True)")
    else:
        # assistant_text is empty/null
        # If is_completed=True, workflow ended silently — don't send fallback
        if is_completed:
            await _set_lead_status(sender, "completed")
            if mapping.get("store_leads"):
                await _store_lead_from_chat(sender)
            logger.info(f"✅ Lead {sender} marked COMPLETED (silent completion)")
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


def _send_twilio_reply(to: str, body: str, media_url: str = "", content_sid: str = "") -> None:
    """Send a WhatsApp message via Twilio API.

    If content_sid is provided, sends as a WhatsApp Template (bypasses 24h window).
    If media_url is provided, sends image + body as a single message (caption).
    Otherwise splits long text into chunks.
    """
    if not twilio_client:
        logger.error("Twilio client not configured — cannot send reply")
        return

    from_number = f"whatsapp:{TWILIO_WHATSAPP_NUMBER}"

    # Template message — bypasses 24h window restriction
    if content_sid:
        try:
            msg = twilio_client.messages.create(
                from_=from_number,
                to=to,
                content_sid=content_sid,
            )
            logger.info(f"📋 Template sent to {to} (SID: {msg.sid}, template: {content_sid})")
        except Exception as e:
            logger.error(f"❌ Failed to send template to {to}: {e}")
        return

    # Send image + caption as ONE message
    if media_url:
        try:
            msg = twilio_client.messages.create(
                from_=from_number,
                to=to,
                media_url=[media_url],
                body=body,
            )
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
    if agents_collection is None:
        return
    await agents_collection.update_one(
        {"phone_number": phone_number},
        {"$inc": {"quota_used": 1}},
    )
    # Log current usage
    doc = await agents_collection.find_one({"phone_number": phone_number})
    if doc and doc.get("quota_enabled"):
        used = doc.get("quota_used", 0)
        limit = doc.get("quota_limit", 500)
        logger.debug(f"💳 Quota: {used}/{limit} msgs used for '{doc.get('agent_name')}'")




FOLLOWUP_PROMPTS = [
    "[SYSTEM: The user has not replied for a while. Send a gentle follow-up based on where the conversation left off. If you were waiting for their name, ask for it again. If waiting for location, remind them. If waiting for confirmation, ask again. Keep it short, friendly, 1-2 lines. Don't repeat your exact last message — rephrase it.]",
    "[SYSTEM: Second follow-up. The user still hasn't replied. Send another brief reminder about whatever you last asked them. Different wording from before. Keep it warm and zero-pressure.]",
    "[SYSTEM: Final follow-up. The user hasn't responded after two reminders. Send a last gentle message saying you're here whenever they're ready, no rush. This is the final attempt.]",
]


async def _followup_loop() -> None:
    """Background loop: checks for idle sessions and sends follow-ups.

    Runs every 60s. Only fires for agents with followups_enabled=true.
    """
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

    # Load enabled agents from MongoDB agents collection
    if agents_collection is not None:
        agent_docs = await agents_collection.find(
            {"followups_enabled": True, "is_active": True}
        ).to_list(length=100)
    else:
        # In-memory fallback: use AGENT_MAPPINGS
        agent_docs = [
            {**v, "phone_number": k}
            for k, v in AGENT_MAPPINGS.items()
            if v.get("followups_enabled")
        ]

    if not agent_docs:
        return

    followup_agents = {doc["phone_number"] for doc in agent_docs}
    agent_map = {doc["phone_number"]: doc for doc in agent_docs}

    # Query sessions that are active and have an agent_number in followup_agents
    if sessions_collection is not None:
        query = {
            "lead_status": {"$in": ["active", None]},
            "human_takeover": {"$ne": True},
            "agent_number": {"$regex": "|".join(
                a.replace("+", "\\+") for a in followup_agents
            )},
        }
        sessions = await sessions_collection.find(query).to_list(length=500)
        no_status_query = {
            "lead_status": {"$exists": False},
            "human_takeover": {"$ne": True},
        }
        no_status_sessions = await sessions_collection.find(no_status_query).to_list(length=500)
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

        # Get agent doc for this session
        clean_agent = agent_number.replace("whatsapp:", "").strip()
        mapping = agent_map.get(clean_agent)
        if not mapping:
            if len(followup_agents) == 1:
                mapping = next(iter(agent_map.values()))
            else:
                continue

        delays = mapping.get("followup_delays", DEFAULT_FOLLOWUP_DELAYS)

        if stage >= len(delays):
            continue

        # Check if enough time has passed since last agent reply
        if isinstance(last_reply, str):
            last_reply = datetime.fromisoformat(
                last_reply.replace("Z", "+00:00"))
        if last_reply.tzinfo is None:
            last_reply = last_reply.replace(tzinfo=timezone.utc)

        elapsed = (now - last_reply).total_seconds()

        # Skip truly stale sessions (idle > 7 days) — definitely abandoned
        if elapsed > 86400 * 7:
            continue
        if elapsed < delays[stage]:
            continue

        # Skip if lead already completed/inactive/not_qualified
        current_session = None
        if sessions_collection is not None:
            current_session = await sessions_collection.find_one({"phone_number": phone_number})
        if current_session and current_session.get("lead_status") in ["completed", "inactive", "not_qualified"]:
            logger.debug(f"⏭️ Skipping follow-up for {phone_number} — lead_status={current_session.get('lead_status')}")
            continue

        # Time to send follow-up
        logger.info(
            f"⏰ Follow-up {stage + 1} for {phone_number} "
            f"(idle {int(elapsed)}s, threshold {delays[stage]}s)"
        )

        try:
            api_key = mapping["api_key"]
            trigger_path = mapping["trigger_path"]
        except KeyError:
            continue

        # Get follow-up config for this stage
        # followup_messages is list of {message: str, template_sid: str}
        # Supports legacy list[str] format for backwards compatibility
        followup_messages = mapping.get("followup_messages", [])
        followup_item: dict = {}
        if stage < len(followup_messages):
            item = followup_messages[stage]
            if isinstance(item, dict):
                followup_item = item
            elif isinstance(item, str):
                # Legacy format — treat as custom message
                followup_item = {"message": item, "template_sid": ""}

        custom_text  = (followup_item.get("message") or "").strip()
        template_sid = (followup_item.get("template_sid") or "").strip()
        is_over_24h  = delays[stage] >= 86400

        if is_over_24h:
            # ≥ 24h — template REQUIRED
            if not template_sid:
                logger.warning(
                    f"⏭️ Skipping follow-up {stage + 1} for {phone_number} — "
                    f"delay ≥24h ({delays[stage]}s) but no template_sid set. "
                    f"Add a Twilio Content SID in the dashboard."
                )
                # Still increment stage so we don't retry this one forever
                await _increment_followup(phone_number, stage + 1)
                continue
            # Send via Twilio template
            logger.info(f"📋 Using template follow-up {stage + 1} for {phone_number} (delay={delays[stage]}s ≥24h)")
            _send_twilio_reply(phone_number, "", content_sid=template_sid)
            await store_message(phone_number, "agent", f"[Template: {template_sid}]", "followup")
            await _mark_agent_replied(phone_number)

        elif template_sid:
            # < 24h, template optionally set — use it
            logger.info(f"📋 Using template follow-up {stage + 1} for {phone_number} (optional, <24h)")
            _send_twilio_reply(phone_number, "", content_sid=template_sid)
            await store_message(phone_number, "agent", f"[Template: {template_sid}]", "followup")
            await _mark_agent_replied(phone_number)

        elif custom_text:
            # < 24h, custom text — send directly, skip Dograh
            logger.info(f"📝 Using custom follow-up {stage + 1} for {phone_number}")
            _send_twilio_reply(phone_number, custom_text)
            await store_message(phone_number, "agent", custom_text, "followup")
            await _mark_agent_replied(phone_number)

        else:
            # < 24h, AI generated through Dograh
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
                logger.warning(f"Dograh returned no text for follow-up {stage + 1}")

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
async def get_conversations(agent_number: str = ""):
    """Get all conversations for the dashboard (cached 30s). Optionally filter by agent_number."""
    now = time.monotonic()
    cache_key = agent_number or "all"
    if CONVERSATIONS_CACHE.get(cache_key) and now < CONVERSATIONS_CACHE.get(f"{cache_key}_expires", 0):
        return CONVERSATIONS_CACHE[cache_key]

    conversations = []

    if sessions_collection is not None:
        query: dict = {}
        if agent_number:
            clean = agent_number.replace("whatsapp:", "").strip()
            query["agent_number"] = {"$in": [clean, f"whatsapp:{clean}"]}

        async for session in sessions_collection.find(query):
            phone_number = session["phone_number"]
            last_chat = await chats_collection.find_one(
                {"phone_number": phone_number}, sort=[("timestamp", -1)]
            )
            timestamp_str = ""
            if last_chat and last_chat.get("timestamp"):
                timestamp_str = last_chat["timestamp"].isoformat() + "Z"
            conversations.append({
                "phone_number": phone_number,
                "agent_number": session.get("agent_number", "").replace("whatsapp:", ""),
                "human_takeover": session.get("human_takeover", False),
                "lead_status": session.get("lead_status", "active"),
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

    # Sort newest first
    conversations.sort(key=lambda x: x.get("last_message_time", ""), reverse=True)

    CONVERSATIONS_CACHE[cache_key] = conversations
    CONVERSATIONS_CACHE[f"{cache_key}_expires"] = now + 30
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
    """Release conversation back to AI.
    
    After human releases, sends a resume context message to Dograh so the AI
    knows where to pick up the conversation — not from the beginning.
    """
    data = await request.json()
    phone_number = data.get("phone_number")

    if not phone_number:
        raise HTTPException(status_code=400, detail="phone_number is required")

    # Fetch stored takeover context before clearing
    takeover_context = ""
    if sessions_collection is not None:
        session = await sessions_collection.find_one({"phone_number": phone_number})
        if session:
            takeover_context = session.get("takeover_context", "")

    await set_human_takeover(phone_number, False)
    logger.info(f"🤖 AI mode restored for {phone_number}")

    await store_message(
        phone_number, "agent", "Conversation returned to AI.", "system"
    )

    # Send resume context to Dograh so AI picks up from the right step
    if takeover_context:
        try:
            # Get agent config for this phone
            # Find agent_number from session
            agent_number = ""
            if sessions_collection is not None:
                session = await sessions_collection.find_one({"phone_number": phone_number})
                if session:
                    agent_number = session.get("agent_number", "").replace("whatsapp:", "")

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
                    # Strip [SEND_EXACT]: prefix if present
                    if resume_text and resume_text.startswith("[SEND_EXACT]:"):
                        resume_text = resume_text[len("[SEND_EXACT]:"):].strip()
                    if resume_text and "TRANSFER_TO_HUMAN" not in resume_text:
                        _send_twilio_reply(phone_number, resume_text)
                        await store_message(phone_number, "agent", resume_text, "ai")
                        await _mark_agent_replied(phone_number)
                        logger.info(f"🔄 AI resumed for {phone_number}: {resume_text[:60]}")

            # Clear takeover context after using it
            if sessions_collection is not None:
                await sessions_collection.update_one(
                    {"phone_number": phone_number},
                    {"$unset": {"takeover_context": ""}}
                )
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

    # Resolve agent_number from sessions collection using the user's phone number
    agent_number = ""
    if phone_number and sessions_collection is not None:
        session = await sessions_collection.find_one({
            "phone_number": {"$in": [phone_number, f"whatsapp:{phone_number}"]}
        })
        if session:
            agent_number = session.get("agent_number", "").replace("whatsapp:", "")

    lead_doc = {
        "patient_name": gathered.get("patient_name", ""),
        "concern": gathered.get("concern", ""),
        "city": gathered.get("city", ""),
        "locality": gathered.get("locality", ""),
        "user_location": gathered.get("user_location", ""),
        "notes": gathered.get("notes", ""),
        "phone_number": phone_number,
        "agent_number": agent_number,
        "workflow_run_id": data.get("workflow_run_id", ""),
        "created_at": datetime.now(timezone.utc),
    }

    if db is not None:
        leads_collection = db["leads"]
        await leads_collection.insert_one(lead_doc)
        logger.info(f"💾 Lead stored: {lead_doc['patient_name']} - {lead_doc['concern']} - agent: {agent_number}")
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


# ---------------------------------------------------------------------------
# Agents CRUD endpoints (for dashboard)
# ---------------------------------------------------------------------------


def _make_agent_prefix(agent_name: str) -> str:
    """Generate collection prefix from agent name."""
    import re
    prefix = agent_name.lower().strip()
    prefix = re.sub(r"[^a-z0-9]+", "_", prefix)
    prefix = prefix.strip("_")
    return prefix


def _serialize_agent(doc: dict) -> dict:
    """Serialize an agent document for JSON response (remove MongoDB _id)."""
    doc = dict(doc)
    doc.pop("_id", None)
    if doc.get("created_at"):
        doc["created_at"] = doc["created_at"].isoformat() + "Z"
    if doc.get("updated_at"):
        doc["updated_at"] = doc["updated_at"].isoformat() + "Z"
    return doc


@app.get("/agents")
async def list_agents():
    """List all agents."""
    if agents_collection is None:
        raise HTTPException(status_code=503, detail="MongoDB unavailable")
    docs = await agents_collection.find({}).to_list(length=200)
    return [_serialize_agent(d) for d in docs]


@app.post("/agents")
async def create_agent(request: Request):
    """Create a new agent."""
    if agents_collection is None:
        raise HTTPException(status_code=503, detail="MongoDB unavailable")
    data = await request.json()

    phone_number = data.get("phone_number", "").strip()
    agent_name = data.get("agent_name", "").strip()
    if not phone_number or not agent_name:
        raise HTTPException(status_code=400, detail="phone_number and agent_name are required")

    existing = await agents_collection.find_one({"phone_number": phone_number})
    if existing:
        raise HTTPException(status_code=409, detail=f"Agent with number {phone_number} already exists")

    collection_prefix = data.get("collection_prefix") or _make_agent_prefix(agent_name)

    doc = {
        "phone_number": phone_number,
        "agent_name": agent_name,
        "collection_prefix": collection_prefix,
        "api_key": data.get("api_key", ""),
        "trigger_path": data.get("trigger_path", ""),
        "followups_enabled": data.get("followups_enabled", False),
        "followup_delays": data.get("followup_delays", DEFAULT_FOLLOWUP_DELAYS),
        "followup_messages": data.get("followup_messages", []),
        "greeting_message": data.get("greeting_message", ""),
        "greeting_image_url": data.get("greeting_image_url", ""),
        "greeting_window_hours": data.get("greeting_window_hours", 12),
        "completion_message": data.get("completion_message", ""),
        "store_leads": data.get("store_leads", False),
        "quota_enabled": data.get("quota_enabled", False),
        "quota_limit": data.get("quota_limit", 500),
        "quota_used": 0,
        "quota_reset_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "is_active": data.get("is_active", True),
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    await agents_collection.insert_one(doc)
    logger.info(f"✅ Agent created: {agent_name} ({phone_number})")
    return _serialize_agent(doc)


@app.get("/agents/{phone_number:path}")
async def get_agent(phone_number: str):
    """Get a single agent by phone number."""
    if agents_collection is None:
        raise HTTPException(status_code=503, detail="MongoDB unavailable")
    phone_number = phone_number.replace("%2B", "+").strip()
    doc = await agents_collection.find_one({"phone_number": phone_number})
    if not doc:
        raise HTTPException(status_code=404, detail="Agent not found")
    return _serialize_agent(doc)


@app.put("/agents/{phone_number:path}")
async def update_agent(phone_number: str, request: Request):
    """Update an agent's config."""
    if agents_collection is None:
        raise HTTPException(status_code=503, detail="MongoDB unavailable")
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

    # Sanitize strings — remove surrogate characters that break MongoDB UTF-8 encoding
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
    result = await agents_collection.update_one(
        {"phone_number": phone_number},
        {"$set": update},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Agent not found")

    doc = await agents_collection.find_one({"phone_number": phone_number})
    logger.info(f"✅ Agent updated: {phone_number} — fields: {list(update.keys())}")
    return _serialize_agent(doc)


@app.delete("/agents/{phone_number:path}")
async def delete_agent(phone_number: str):
    """Delete an agent."""
    if agents_collection is None:
        raise HTTPException(status_code=503, detail="MongoDB unavailable")
    phone_number = phone_number.replace("%2B", "+").strip()
    result = await agents_collection.delete_one({"phone_number": phone_number})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Agent not found")
    logger.info(f"🗑️ Agent deleted: {phone_number}")
    return {"success": True, "message": f"Agent {phone_number} deleted"}


@app.post("/agents/{phone_number:path}/reset-quota")
async def reset_agent_quota(phone_number: str):
    """Reset quota_used to 0 for an agent (e.g. after payment/renewal)."""
    if agents_collection is None:
        raise HTTPException(status_code=503, detail="MongoDB unavailable")
    phone_number = phone_number.replace("%2B", "+").strip()
    result = await agents_collection.update_one(
        {"phone_number": phone_number},
        {"$set": {
            "quota_used": 0,
            "quota_reset_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Agent not found")
    logger.info(f"🔄 Quota reset for {phone_number}")
    return {"success": True, "message": f"Quota reset for {phone_number}"}


# ---------------------------------------------------------------------------
# Leads endpoint
# ---------------------------------------------------------------------------

@app.get("/leads")
async def get_leads(limit: int = 100, skip: int = 0, agent_number: str = ""):
    """Get all captured leads, newest first. Optionally filter by agent_number."""
    if db is None:
        return []
    leads_collection = db["leads"]
    query: dict = {}
    if agent_number:
        clean = agent_number.replace("whatsapp:", "").strip()
        # Match exact number OR whatsapp-prefixed OR empty (legacy leads without agent_number)
        query["agent_number"] = {"$in": [clean, f"whatsapp:{clean}"]}
    cursor = leads_collection.find(query).sort("created_at", -1).skip(skip).limit(limit)
    leads = await cursor.to_list(length=limit)
    result = []
    for lead in leads:
        lead.pop("_id", None)
        if lead.get("created_at"):
            lead["created_at"] = lead["created_at"].isoformat() + "Z"
        result.append(lead)
    return result
