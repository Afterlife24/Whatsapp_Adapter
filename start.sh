#!/bin/bash
# start.sh — Start WhatsApp Adapter + Dashboard together

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "🚀 Starting WhatsApp Adapter + Dashboard"
echo "========================================="

# ── Adapter ──────────────────────────────────────────────────────────────────
echo ""
echo "▶ Starting Adapter (port 8001)..."

# Activate venv if it exists
if [ -f "$SCRIPT_DIR/venv/bin/activate" ]; then
    source "$SCRIPT_DIR/venv/bin/activate"
    echo "  ✅ venv activated"
else
    echo "  ⚠️  No venv found — using system Python"
fi

# Start adapter in background
cd "$SCRIPT_DIR"
uvicorn app:app --host 0.0.0.0 --port 8001 --reload &
ADAPTER_PID=$!
echo "  ✅ Adapter started (PID: $ADAPTER_PID)"

# ── Dashboard ─────────────────────────────────────────────────────────────────
echo ""
echo "▶ Starting Dashboard (port 3001)..."

DASHBOARD_DIR="$SCRIPT_DIR/dashboard"

if [ ! -d "$DASHBOARD_DIR/node_modules" ]; then
    echo "  📦 Installing dashboard dependencies..."
    cd "$DASHBOARD_DIR"
    npm install
fi

cd "$DASHBOARD_DIR"
npm run dev -- --port 3001 &
DASHBOARD_PID=$!
echo "  ✅ Dashboard started (PID: $DASHBOARD_PID)"

# ── Info ──────────────────────────────────────────────────────────────────────
echo ""
echo "========================================="
echo "  Adapter API  →  http://localhost:8001"
echo "  Dashboard    →  http://localhost:3001"
echo "========================================="
echo ""
echo "Press Ctrl+C to stop both services."
echo ""

# ── Cleanup on exit ───────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "🛑 Stopping services..."
    kill $ADAPTER_PID 2>/dev/null && echo "  ✅ Adapter stopped"
    kill $DASHBOARD_PID 2>/dev/null && echo "  ✅ Dashboard stopped"
    # Kill any child processes too
    pkill -P $ADAPTER_PID 2>/dev/null || true
    pkill -P $DASHBOARD_PID 2>/dev/null || true
    echo "Done."
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for both to exit
wait $ADAPTER_PID $DASHBOARD_PID
