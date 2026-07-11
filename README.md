# WhatsApp ↔ Dograh Adapter

A lightweight service that bridges Twilio WhatsApp webhooks to Dograh's public text-chat API. Any agent you build in Dograh's workflow editor can now respond to WhatsApp messages.

## How It Works

```
User (WhatsApp) → Twilio → This Adapter → Dograh Public Text-Chat API → Workflow Engine
                                          ← assistant reply ←
                  Twilio ← TwiML response ←
```

1. User sends a WhatsApp message to your Twilio number
2. Twilio forwards it to this adapter's `/whatsapp` webhook
3. Adapter calls Dograh's `POST /api/v1/public/agent/text-chat/{trigger}/message`
4. Dograh runs the workflow, returns the assistant's text reply
5. Adapter wraps the reply in TwiML and sends it back through Twilio

## Setup

### 1. Configure Dograh

- Create an agent workflow in Dograh's dashboard
- Publish it (or use test mode with `/test/` prefix)
- Go to org Settings → API Keys → Create one
- Copy the API key and the agent's trigger UUID

### 2. Configure the Adapter

```bash
cp .env.example .env
# Edit .env with your Dograh API key and trigger path
```

### 3. Run

```bash
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8080
```

### 4. Configure Twilio

In your Twilio console, set your WhatsApp sandbox/number's webhook URL to:

```
https://your-adapter-host:8080/whatsapp
```

Method: POST

## Multi-Agent Support

To serve multiple businesses (each with their own Dograh org + agent) from a single adapter instance, set `AGENT_MAPPINGS` in your `.env`:

```json
{
  "+14155551234": {
    "api_key": "dk_restaurant_key",
    "trigger_path": "uuid-restaurant"
  },
  "+14155555678": { "api_key": "dk_clinic_key", "trigger_path": "uuid-clinic" }
}
```

Each Twilio WhatsApp number routes to a different Dograh org/agent.

## Environment Variables

| Variable              | Required | Description                                                |
| --------------------- | -------- | ---------------------------------------------------------- |
| `DOGRAH_API_BASE`     | Yes      | Dograh backend URL (e.g. `http://localhost:8000/api/v1`)   |
| `DOGRAH_API_KEY`      | Yes\*    | API key for single-agent mode                              |
| `DOGRAH_TRIGGER_PATH` | Yes\*    | Trigger UUID for single-agent mode                         |
| `AGENT_MAPPINGS`      | No       | JSON mapping for multi-agent mode (overrides single-agent) |

\*Required unless `AGENT_MAPPINGS` is set.
# Whatsapp_Adapter
