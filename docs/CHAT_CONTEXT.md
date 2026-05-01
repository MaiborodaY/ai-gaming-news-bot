# BroNews bot — ChatGPT handoff context

Last updated: 2026-05-01
Repository: `MaiborodaY/ai-gaming-news-bot`
Worker URL: `ai-gaming-news-bot.mr-maybik.workers.dev`
Main worker file: `src/worker.js`
Cloudflare config: `wrangler.toml`

This file is a detailed handoff summary for continuing the project in a new ChatGPT/Codex chat.

---

## 1. Project goal

The project is a Telegram bot called BroNews / BroNews bot for gaming news.

Current goal:

1. Fetch gaming news from RSS sources.
2. Let the user create a draft news post with `/draft_news`.
3. Let the user manually approve or skip the draft using inline buttons.
4. Publish approved posts to a Telegram channel.
5. Avoid showing the same news item repeatedly.
6. Start using OpenAI to rewrite RSS titles into more natural Telegram posts.

Important product decision:

Do not autopublish AI-generated content yet. The bot must show a draft first, and the user manually chooses:

- `✅ Опубликовать`
- `❌ Пропустить`

---

## 2. Existing Telegram commands

Current command set in `src/worker.js`:

- `/start`
  - Replies: `BroNews bot is alive ✅`

- `/test_channel`
  - Sends a simple test post to the configured Telegram channel.
  - Requires `CHANNEL_ID`.

- `/mock_news`
  - Sends a mock gaming news post to the configured Telegram channel.
  - Requires `CHANNEL_ID`.
  - Used earlier to verify bot → channel posting.

- `/fetch_news`
  - Fetches latest news from RSS sources.
  - Returns a plain list of latest gaming news to the user in private chat.

- `/draft_news`
  - Finds the first fresh and not-yet-processed news item.
  - Creates a draft record in KV.
  - Sends a draft message to the user with inline buttons:
    - `✅ Опубликовать`
    - `❌ Пропустить`

- `/ai_test`
  - Diagnostic command added to test OpenAI configuration.
  - Private chat only.
  - It checks whether the Worker can call OpenAI with `OPENAI_API_KEY`.

---

## 3. Cloudflare environment variables / secrets

Known bindings and secrets:

### Telegram

- `TELEGRAM_BOT_TOKEN`
  - Secret.
  - Telegram bot token.
  - Must not be committed to GitHub.

- `CHANNEL_ID`
  - Telegram channel ID.
  - Can be configured as a Cloudflare variable.
  - Example format is usually something like `-100...`.

### KV

- `DRAFTS`
  - KV namespace binding.
  - Used to store draft records and news-link index records.
  - There was an issue earlier where Cloudflare deploys removed KV bindings if they were configured manually but not represented in `wrangler.toml`.
  - The fix was to include the KV namespace binding in `wrangler.toml`.

### OpenAI

- `OPENAI_API_KEY`
  - Secret.
  - Added in Cloudflare dashboard.
  - Must not be committed.

- `OPENAI_MODEL`
  - Optional variable.
  - If missing, current code uses `DEFAULT_OPENAI_MODEL`.
  - Current default in code: `gpt-4o-mini`.
  - This should be reviewed because model availability may change.

---

## 4. Current RSS sources

Current `NEWS_SOURCES` in `src/worker.js`:

- Steam
  - `https://store.steampowered.com/feeds/news.xml`

- PlayStation Blog
  - `https://blog.playstation.com/feed/`

- Xbox Wire
  - `https://news.xbox.com/en-us/feed/`

- Gematsu
  - `https://www.gematsu.com/feed`

Earlier tests confirmed that `/fetch_news` returns mixed news from Steam and PlayStation Blog.

Example output from `/fetch_news`:

```text
Latest gaming news:

1. [Steam] Team Fortress 2 Update Released
https://store.steampowered.com/news/265516/

2. [PlayStation Blog] Control Resonant: Remedy shares first details on New Game Plus
https://blog.playstation.com/2026/04/30/control-resonant-remedy-shares-first-details-on-new-game-plus/
```

---

## 5. Current KV data model

The bot uses the `DRAFTS` KV namespace for two types of records.

### 5.1 Draft record

Key format:

```text
draft:<draftId>
```

Example:

```json
{
  "id": "64b6da32-9bb5-477a-972e-b5d04829701d",
  "status": "published",
  "item": {
    "source": "PlayStation Blog",
    "title": "Control Resonant: Remedy shares first details on New Game Plus",
    "link": "https://blog.playstation.com/2026/04/30/control-resonant-remedy-shares-first-details-on-new-game-plus/",
    "publishedAt": "2026-04-30T16:00:29.000Z"
  },
  "post": "🎮 Control Resonant: Remedy shares first details on New Game Plus\n\nПоявилась новая игровая новость от PlayStation Blog. Полные детали доступны по ссылке ниже.\n\nИсточник: PlayStation Blog\nhttps://blog.playstation.com/2026/04/30/control-resonant-remedy-shares-first-details-on-new-game-plus/",
  "createdAt": "2026-05-01T21:05:05.406Z",
  "publishedAt": "2026-05-01T21:05:39.119Z",
  "skippedAt": null
}
```

### 5.2 News-link index record

Key format:

```text
news:<normalizedLink>
```

Example:

```text
news:https://blog.playstation.com/2026/04/30/control-resonant-remedy-shares-first-details-on-new-game-plus
```

Example value:

```json
{
  "draftId": "64b6da32-9bb5-477a-972e-b5d04829701d",
  "status": "published",
  "source": "PlayStation Blog",
  "title": "Control Resonant: Remedy shares first details on New Game Plus",
  "link": "https://blog.playstation.com/2026/04/30/control-resonant-remedy-shares-first-details-on-new-game-plus/",
  "newsPublishedAt": "2026-04-30T16:00:29.000Z",
  "createdAt": "2026-05-01T21:05:05.406Z",
  "publishedAt": "2026-05-01T21:05:39.119Z",
  "skippedAt": null
}
```

Purpose of `news:<link>` index:

- The bot should not scan the entire KV.
- It should check only exact keys for candidate RSS items.
- `/draft_news` fetches fresh RSS items, then for each candidate does a direct KV lookup:

```text
DRAFTS.get("news:<normalizedLink>")
```

If the key exists, the news item was already seen, skipped, drafted, or published. The bot moves to the next candidate.

---

## 6. Draft statuses

Current statuses:

- `draft`
  - Draft was created and is waiting for user decision.

- `published`
  - User clicked `✅ Опубликовать`.
  - Bot posted the draft to the Telegram channel.
  - KV fields:
    - `status: "published"`
    - `publishedAt: <timestamp>`

- `skipped`
  - User clicked `❌ Пропустить`.
  - Bot did not post to the Telegram channel.
  - KV fields:
    - `status: "skipped"`
    - `skippedAt: <timestamp>`

There is no `new` status yet.

Reason:

Currently the bot does not periodically scan and store all RSS news. News enters KV only when the user calls `/draft_news`, so the first state is already `draft`.

Potential future flow:

```text
scheduled RSS scan → status new → user selects → draft → published/skipped
```

But current flow is simpler:

```text
/draft_news → draft → published/skipped
```

---

## 7. Date filtering

A PR added parsing of source publication date from RSS/Atom.

The bot reads date from tags:

- `pubDate`
- `published`
- `updated`
- `dc:date`

The parsed value is stored as:

```text
item.publishedAt
```

In `news:<link>` index it is stored as:

```text
newsPublishedAt
```

Current filter:

```text
NEWS_MAX_AGE_DAYS = 3
```

Meaning:

- News older than 3 days should be filtered out if the source provides a valid date.
- If no date is present or date parsing fails, the item is currently allowed.

Important distinction:

- `newsPublishedAt` / `item.publishedAt` = when source published the article.
- `publishedAt` at draft root level = when our bot published the post to Telegram channel.

---

## 8. OpenAI integration status

OpenAI draft generation was added in PR #23.

Current logic:

```text
/draft_news
→ fetch RSS news
→ choose first fresh unprocessed item
→ createNewsPost(env, item)
→ try generateAiNewsPost(env, item)
→ if OpenAI works, use AI-generated post
→ if OpenAI fails or key missing, fallback to old template
```

Fallback template:

```text
🎮 <title>

Появилась новая игровая новость от <source>. Полные детали доступны по ссылке ниже.

Источник: <source>
<link>
```

Current AI prompt intent:

- Russian Telegram post.
- Short and natural.
- Do not invent facts not present in RSS title.
- No Markdown, bold text, lists, or hashtags.
- Include source and link.

Current default model in code:

```text
gpt-4o-mini
```

This model choice should be verified later. It was used as a cheap MVP model, but the user questioned whether it is still available because GPT-5 models exist.

Important: as of current chat, OpenAI generation did not work in production. The bot fell back to old template.

---

## 9. OpenAI diagnostic `/ai_test`

PR #24 added `/ai_test`.

User tested it and got:

```text
AI test failed ❌ status: 429
```

Interpretation:

- Worker sees `OPENAI_API_KEY`.
- Request reaches OpenAI.
- OpenAI responds with HTTP 429.
- This usually indicates quota, billing, rate limit, or project/service-account quota issue.
- It is less likely to be a missing model. Missing/invalid model often gives a 400-style error, but the exact reason must be checked from the response body.

PR #25 was created to improve `/ai_test` by showing short OpenAI error body.

PR #25:

```text
https://github.com/MaiborodaY/ai-gaming-news-bot/pull/25
```

Title:

```text
Show OpenAI error details in /ai_test
```

Change:

When OpenAI returns non-OK response, `/ai_test` should now return:

```text
AI test failed ❌ status: <status>
<short OpenAI error body>
```

Current expected next test after merging PR #25:

```text
/ai_test
```

The reply should show whether the 429 is:

- insufficient quota,
- rate limit,
- billing issue,
- project/service-account issue,
- or model-related issue.

---

## 10. PR history summary

Important recent PRs:

### PR #6

Added `/mock_news` command.

Purpose:

- Verify that bot can post a test gaming news message to Telegram channel.

### PR #7 / #8 and related work

Early iterations around fetching RSS news and draft flow.

### PR #19 / #20

Added and refined publish/skip workflow.

Important behavior:

- `✅ Опубликовать` publishes draft to Telegram channel.
- Re-clicking publish returns already-published message.
- `❌ Пропустить` marks draft as skipped.
- Re-clicking skipped draft behaves safely.

### PR #21

Added `news:<link>` index to avoid duplicate drafts.

Result verified by user:

1. `/draft_news` returned Team Fortress 2.
2. User skipped it.
3. `/draft_news` returned next PlayStation Blog item, not Team Fortress 2 again.
4. User published it.
5. `/draft_news` returned the next item.

### PR #22

Added source publication date parsing and 3-day filter.

Verified with PlayStation Blog article:

- Source date: `2026-04-30T16:00:29.000Z`
- Draft created/published on `2026-05-01`
- Date was stored correctly in both draft and news index.

### PR #23

Added OpenAI draft generation with fallback.

Observed result:

- `/draft_news` still returned fallback template, meaning OpenAI call failed silently and fallback worked.

### PR #24

Added `/ai_test` diagnostic command.

Observed result:

```text
AI test failed ❌ status: 429
```

### PR #25

Open at time of this handoff.

Purpose:

- Show OpenAI response body for failed `/ai_test` call.

Next action:

- Merge PR #25.
- Wait for Cloudflare production deploy.
- Run `/ai_test` again.

---

## 11. Cloudflare deployment notes

Cloudflare automatic deployments are connected to GitHub.

Earlier problem:

After merge and deploy, some variables/bindings appeared to disappear, especially KV binding.

Conclusion:

- Secrets like `TELEGRAM_BOT_TOKEN` and `OPENAI_API_KEY` should be stored in Cloudflare dashboard as secrets, not committed.
- Non-secret variables can be in Cloudflare dashboard or `wrangler.toml`.
- KV binding `DRAFTS` should be declared in `wrangler.toml`, otherwise deploy may overwrite manual binding state.

Current known working things:

- `/mock_news` successfully posted to channel.
- `/draft_news` creates KV records.
- `✅ Опубликовать` posts to channel.
- `❌ Пропустить` updates KV status to skipped.
- Duplicate prevention by `news:<link>` works.
- Date parsing works.
- OpenAI key is present enough to reach OpenAI, but OpenAI returns 429.

---

## 12. Manual test checklist

After any merge/deploy, test in Telegram private chat with bot.

### Health check

Browser/curl:

```text
GET https://ai-gaming-news-bot.mr-maybik.workers.dev/health
```

Expected:

```json
{
  "ok": true,
  "service": "ai-gaming-news-bot",
  "version": "0.1.0"
}
```

### Telegram bot basics

```text
/start
```

Expected:

```text
BroNews bot is alive ✅
```

### Channel test

```text
/test_channel
```

Expected:

- Channel receives test post.
- User receives confirmation.

### Mock news

```text
/mock_news
```

Expected channel post:

```text
🎮 Test gaming news

This is a test news post from BroNews bot.

Source: https://example.com
```

### Fetch news

```text
/fetch_news
```

Expected:

- List of latest gaming news.
- Sources should include available RSS sources.

### Draft flow

```text
/draft_news
```

Expected:

- Bot sends `📝 Черновик поста`.
- Buttons are visible:
  - `✅ Опубликовать`
  - `❌ Пропустить`

Click publish:

Expected:

- Channel gets the post.
- Bot replies: `Published to channel ✅`.
- KV draft status becomes `published`.
- KV news index status becomes `published`.

Click skip:

Expected:

- Channel receives nothing.
- Bot replies: `Draft skipped`.
- KV draft status becomes `skipped`.
- KV news index status becomes `skipped`.

Duplicate prevention test:

1. Create draft.
2. Publish or skip.
3. Run `/draft_news` again.

Expected:

- Bot should not return the same news link again while `news:<link>` index exists.

### AI test

```text
/ai_test
```

Current expected after PR #25 merge:

- If OpenAI works:

```text
AI is configured ✅
Model: <model>
```

- If OpenAI fails:

```text
AI test failed ❌ status: <status>
<short OpenAI error body>
```

---

## 13. Known current issue

OpenAI integration currently falls back to the old template.

Observed:

```text
/draft_news
```

returned:

```text
🎮 Resident Evil Q&A: Director Zach Cregger shares inspirations and a new film teaser

Появилась новая игровая новость от PlayStation Blog. Полные детали доступны по ссылке ниже.

Источник: PlayStation Blog
https://blog.playstation.com/2026/04/30/resident-evil-qa-director-zach-cregger-shares-inspirations-and-a-new-film-teaser/
```

This means AI generation failed and fallback was used.

Then `/ai_test` returned:

```text
AI test failed ❌ status: 429
```

Next debugging step:

Merge PR #25 and run `/ai_test` again to see actual OpenAI error body.

Likely causes to check:

- OpenAI billing/credits.
- API project quota.
- Service account permissions/quota.
- Rate limit.
- Model availability.
- Wrong project selected when creating API key.

Potential quick experiment:

- Create a normal API key owned by `You` instead of service account.
- Put it into Cloudflare secret `OPENAI_API_KEY`.
- Run `/ai_test`.

If it works, the problem was likely service account/project/quota configuration.

---

## 14. Good next steps

Recommended order:

1. Merge PR #25.
2. Test `/ai_test` and capture exact OpenAI error body.
3. Fix OpenAI account/model/config depending on the error.
4. Once `/ai_test` returns OK, test `/draft_news` again.
5. If AI text is bad, tune prompt.
6. Consider moving from Chat Completions endpoint to newer Responses API later, but only after MVP works.
7. Add `/rewrite` later to regenerate AI draft without creating a new news item.
8. Add scheduled checking later, but not before manual draft flow is stable.

Do not rush into:

- Full autonomous agent.
- Autoposting.
- Complex queues/stats.
- Large refactors.

The current stable product direction is:

```text
RSS → fresh item → dedupe by link → AI draft → manual approve/skip → channel
```

---

## 15. Style preferences for posts

The user prefers Telegram posts to be readable and not overformatted.

Avoid:

- Markdown bold.
- Huge posts.
- Hashtag spam.
- Invented facts.
- Long generic template text.

Preferred style:

```text
🎮 Short catchy title

1–2 simple sentences with context, based only on available title/source/link.

Источник: <source>
<link>
```

Potential Russian style example:

```text
🎮 Control Resonant получит New Game Plus

Remedy поделилась первыми деталями нового режима. Это хороший повод вернуться в игру и пройти её заново с дополнительными возможностями.

Источник: PlayStation Blog
https://...
```

Important safety/product rule:

If AI only has a title and no article body, it must not invent details. It should phrase carefully:

- `Remedy поделилась первыми деталями...`
- `В новости говорится о...`
- `Подробности доступны по ссылке...`

---

## 16. Handoff instruction for next ChatGPT chat

In a new chat, say something like:

```text
Прочитай файл docs/CHAT_CONTEXT.md в репозитории MaiborodaY/ai-gaming-news-bot и продолжим с места, где остановились.
```

Then continue from the current next action:

```text
Проверь PR #25, я его смержил/не смержил, и помоги дальше с /ai_test и OpenAI 429.
```
