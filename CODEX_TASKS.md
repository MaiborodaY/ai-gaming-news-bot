# Codex tasks

## Current task

Create `src/worker.js` with a minimal Cloudflare Worker.

Requirements:

1. `GET /health` returns JSON:

```json
{
  "ok": true,
  "service": "ai-gaming-news-bot",
  "version": "0.1.0"
}
```

2. All other paths return plain text:

```text
AI Gaming News Bot is running
```

Do not add Telegram, RSS, OpenAI, storage, buttons, or extra files yet.
Do not commit secrets.
