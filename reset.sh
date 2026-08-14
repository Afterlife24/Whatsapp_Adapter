#!/bin/bash
# reset.sh — Reset a WhatsApp number's session + chat history in MongoDB
#
# Usage:
#   ./reset.sh +917780313547          → reset one number
#   ./reset.sh +917780313547 +919985  → reset multiple numbers
#   ./reset.sh --all                  → reset ALL numbers (asks confirmation)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load only MONGODB_URL and MONGODB_DATABASE from .env (avoid executing JSON values)
if [ -f "$SCRIPT_DIR/.env" ]; then
    MONGODB_URL=$(grep -E '^MONGODB_URL=' "$SCRIPT_DIR/.env" | head -1 | cut -d'=' -f2-)
    MONGODB_DATABASE=$(grep -E '^MONGODB_DATABASE=' "$SCRIPT_DIR/.env" | head -1 | cut -d'=' -f2-)
fi

MONGODB_URL="${MONGODB_URL:-mongodb://localhost:27017}"
MONGODB_DATABASE="${MONGODB_DATABASE:-whatsapp_adapter}"
export MONGODB_URL MONGODB_DATABASE

MONGODB_URL="${MONGODB_URL:-mongodb://localhost:27017}"
MONGODB_DATABASE="${MONGODB_DATABASE:-whatsapp_adapter}"

# Activate venv if exists
if [ -f "$SCRIPT_DIR/venv/bin/activate" ]; then
    source "$SCRIPT_DIR/venv/bin/activate"
fi

if [ $# -eq 0 ]; then
    echo "Usage:"
    echo "  ./reset.sh +917780313547           reset one number"
    echo "  ./reset.sh +917780313547 +919985   reset multiple numbers"
    echo "  ./reset.sh --all                   reset ALL numbers"
    exit 1
fi

# --all flag
if [ "$1" == "--all" ]; then
    read -p "⚠️  Reset ALL sessions and chats? This cannot be undone. Type 'yes' to confirm: " confirm
    if [ "$confirm" != "yes" ]; then
        echo "Cancelled."
        exit 0
    fi
    python3 - <<'PYEOF'
import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient

MONGODB_URL = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
MONGODB_DATABASE = os.getenv("MONGODB_DATABASE", "whatsapp_adapter")

async def main():
    client = AsyncIOMotorClient(MONGODB_URL)
    db = client[MONGODB_DATABASE]
    s = await db["sessions"].delete_many({})
    c = await db["chats"].delete_many({})
    print(f"✅ Reset ALL — deleted {s.deleted_count} session(s), {c.deleted_count} message(s)")
    client.close()

asyncio.run(main())
PYEOF
    exit 0
fi

# Reset specific number(s)
for RAW_NUMBER in "$@"; do
    # Normalize: strip whatsapp: prefix, ensure + prefix
    NUMBER="${RAW_NUMBER#whatsapp:}"
    if [[ "$NUMBER" != +* ]]; then
        NUMBER="+${NUMBER}"
    fi
    WA_NUMBER="whatsapp:${NUMBER}"

    python3 - "$NUMBER" "$WA_NUMBER" <<'PYEOF'
import asyncio
import sys
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timezone
import os

number = sys.argv[1]
wa_number = sys.argv[2]

MONGODB_URL = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
MONGODB_DATABASE = os.getenv("MONGODB_DATABASE", "whatsapp_adapter")

async def main():
    client = AsyncIOMotorClient(MONGODB_URL)
    db = client[MONGODB_DATABASE]

    s = await db["sessions"].delete_many({
        "phone_number": {"$in": [number, wa_number]}
    })
    c = await db["chats"].delete_many({
        "phone_number": {"$in": [number, wa_number]}
    })

    if s.deleted_count == 0 and c.deleted_count == 0:
        print(f"⚠️  No data found for {number}")
    else:
        print(f"✅ Reset {number} — deleted {s.deleted_count} session(s), {c.deleted_count} message(s)")

    client.close()

asyncio.run(main())
PYEOF

done
