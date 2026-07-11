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
from datetime import datetime, timezone
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


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------


async def get_or_create_session(phone_number: str) -> dict:
    """Get or create a session for the given phone number."""
    if sessions_collection is not None:
        session = await sessions_collection.find_one({"phone_number": phone_number})
        if session:
            return session
        new_session = {
            "phone_number": phone_number,
            "human_takeover": False,
            "last_activity": datetime.now(timezone.utc),
            "created_at": datetime.now(timezone.utc),
        }
        await sessions_collection.insert_one(new_session)
        return new_session
    else:
        if phone_number not in SESSIONS_STORE:
            SESSIONS_STORE[phone_number] = {
                "phone_number": phone_number,
                "human_takeover": False,
                "last_activity": datetime.now(timezone.utc),
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
            {"$set": {"last_activity": now}},
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

    logger.info(f"📩 Incoming from {sender}: {user_message[:100]}")

    if not user_message:
        resp = MessagingResponse()
        return Response(content=str(resp), media_type="application/xml")

    # Ensure session exists
    await get_or_create_session(sender)

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
    assistant_text = await _send_to_dograh(
        api_key=api_key,
        trigger_path=trigger_path,
        session_key=sender,
        text=user_message,
    )

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
    else:
        fallback = "I'm sorry, I couldn't process your message. Please try again."
        _send_twilio_reply(sender, fallback)
        await store_message(sender, "agent", fallback, "ai")

    resp = MessagingResponse()
    return Response(content=str(resp), media_type="application/xml")


def _send_twilio_reply(to: str, body: str) -> None:
    """Send a WhatsApp message via Twilio API."""
    if not twilio_client:
        logger.error("Twilio client not configured — cannot send reply")
        return

    from_number = f"whatsapp:{TWILIO_WHATSAPP_NUMBER}"
    try:
        message = twilio_client.messages.create(
            from_=from_number,
            to=to,
            body=body,
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
) -> Optional[str]:
    """Send a message to Dograh's public text-chat API and return the reply."""
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
            logger.info(
                f"🤖 Dograh reply for {session_key}: "
                f"{assistant_text[:80] if assistant_text else '(empty)'}"
            )
            return assistant_text
        else:
            logger.error(
                f"Dograh API error {response.status_code}: {response.text[:200]}"
            )
            return None

    except httpx.TimeoutException:
        logger.error(f"Dograh API timeout for session {session_key}")
        return None
    except Exception as e:
        logger.error(f"Dograh API call failed: {e}")
        return None


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
