const START_COMMAND = '/start';
const START_REPLY = 'BroNews bot is alive ✅';
const TEST_CHANNEL_COMMAND = '/test_channel';
const TEST_CHANNEL_POST_TEXT = 'BroNews test post ✅';
const TEST_CHANNEL_CONFIRM_TEXT = 'Test post sent to channel ✅';
const MOCK_NEWS_COMMAND = '/mock_news';
const MOCK_NEWS_POST_TEXT = `🎮 Test gaming news

This is a test news post from BroNews bot.

Source: https://example.com`;
const MOCK_NEWS_CONFIRM_TEXT = 'Mock news sent to channel ✅';
const MOCK_NEWS_ERROR_TEXT = 'Failed to send mock news ❌';
const FETCH_NEWS_COMMAND = '/fetch_news';
const DRAFT_NEWS_COMMAND = '/draft_news';
const AI_TEST_COMMAND = '/ai_test';
const PUBLISH_DRAFT_CALLBACK_PREFIX = 'publish_draft:';
const SKIP_DRAFT_CALLBACK_PREFIX = 'skip_draft:';
const DRAFT_KV_PREFIX = 'draft:';
const NEWS_INDEX_KV_PREFIX = 'news:';
const DRAFT_TTL_SECONDS = 60 * 60 * 24;
const NEWS_INDEX_TTL_SECONDS = 60 * 60 * 24 * 7;
const NEWS_MAX_AGE_DAYS = 3;
const DRAFT_STATUS_DRAFT = 'draft';
const DRAFT_STATUS_PUBLISHED = 'published';
const DRAFT_STATUS_SKIPPED = 'skipped';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const NEWS_SOURCES = [
  {
    name: 'Steam',
    url: 'https://store.steampowered.com/feeds/news.xml'
  },
  {
    name: 'PlayStation Blog',
    url: 'https://blog.playstation.com/feed/'
  },
  {
    name: 'Xbox Wire',
    url: 'https://news.xbox.com/en-us/feed/'
  },
  {
    name: 'Gematsu',
    url: 'https://www.gematsu.com/feed'
  }
];
const MAX_FEED_ITEMS_TO_SCAN = 20;
const MAX_NEWS_ITEMS_TO_SHOW = 5;
const MAX_DRAFT_NEWS_ITEMS_TO_SCAN = 20;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

async function callTelegramApi(env, method, payload) {
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN');
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Telegram API error: ${response.status}`);
  }

  return response.json();
}

async function sendTelegramMessage(env, chatId, text, extraPayload = {}) {
  return callTelegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    link_preview_options: {
      is_disabled: true
    },
    ...extraPayload
  });
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  return callTelegramApi(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text
  });
}

function decodeXmlEntities(value = '') {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function getTagValue(xml, tagName) {
  const cdataMatch = xml.match(new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tagName}>`, 'i'));
  if (cdataMatch?.[1]) {
    return decodeXmlEntities(cdataMatch[1]).trim();
  }

  const plainMatch = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  if (plainMatch?.[1]) {
    return decodeXmlEntities(plainMatch[1]).trim();
  }

  return '';
}

function getFirstTagValue(xml, tagNames) {
  for (const tagName of tagNames) {
    const value = getTagValue(xml, tagName);
    if (value) {
      return value;
    }
  }

  return '';
}

function getLinkValue(xml) {
  const textLink = getTagValue(xml, 'link');
  if (textLink) {
    return textLink;
  }

  const hrefMatch = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?\s*>/i);
  return hrefMatch?.[1] ? decodeXmlEntities(hrefMatch[1]).trim() : '';
}

function normalizeNewsTitle(title) {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeNewsLink(link) {
  return link.trim().toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '');
}

function parsePublishedAt(value) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function isRecentNewsItem(item) {
  if (!item.publishedAt) {
    return true;
  }

  const publishedTimestamp = Date.parse(item.publishedAt);
  if (Number.isNaN(publishedTimestamp)) {
    return true;
  }

  const maxAgeMs = NEWS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - publishedTimestamp <= maxAgeMs;
}

function parseFeedItems(xml, sourceName) {
  const rssItems = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  const atomEntries = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  const blocks = rssItems.length > 0 ? rssItems : atomEntries;

  return blocks
    .slice(0, MAX_FEED_ITEMS_TO_SCAN)
    .map((match) => {
      const itemXml = match[1];
      const title = getTagValue(itemXml, 'title');
      const link = getLinkValue(itemXml);
      const rawPublishedAt = getFirstTagValue(itemXml, ['pubDate', 'published', 'updated', 'dc:date']);
      const publishedAt = parsePublishedAt(rawPublishedAt);

      if (!title || !link) {
        return null;
      }

      return { source: sourceName, title, link, publishedAt };
    })
    .filter(Boolean)
    .filter(isRecentNewsItem);
}

function deduplicateNewsItems(items, maxItems = MAX_NEWS_ITEMS_TO_SHOW) {
  const seenTitles = new Set();
  const uniqueItems = [];

  for (const item of items) {
    const normalizedTitle = normalizeNewsTitle(item.title);
    if (seenTitles.has(normalizedTitle)) {
      continue;
    }

    seenTitles.add(normalizedTitle);
    uniqueItems.push(item);

    if (uniqueItems.length >= maxItems) {
      break;
    }
  }

  return uniqueItems;
}

function formatFallbackNewsPost(item) {
  return `🎮 ${item.title}

Появилась новая игровая новость от ${item.source}. Полные детали доступны по ссылке ниже.

Источник: ${item.source}
${item.link}`;
}

function formatDraftMessage(post) {
  return `📝 Черновик поста

${post}`;
}

function cleanAiPost(text) {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .trim();
}

function ensureSourceAndLink(post, item) {
  const hasSource = post.includes(`Источник: ${item.source}`);
  const hasLink = post.includes(item.link);

  if (hasSource && hasLink) {
    return post;
  }

  return `${post}\n\nИсточник: ${item.source}\n${item.link}`;
}

function sanitizeAiPost(text, item) {
  const cleanedPost = cleanAiPost(text);
  if (!cleanedPost) {
    return null;
  }

  return ensureSourceAndLink(cleanedPost, item).slice(0, 3500);
}

async function generateAiNewsPost(env, item) {
  if (!env.OPENAI_API_KEY) {
    return null;
  }

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            // Keep posts lively, but avoid unsupported expansions when source data is short.
            content:
              'Ты редактор Telegram-канала BroNews World про игровые новости. Пиши живо, коротко и интересно на русском языке в стиле игрового новостного канала. Можно делать текст цепляющим, но без рекламных призывов, обещаний и преувеличений. Не используй фразы вроде “не пропустите”, “уникальный”, “обещает”, “погрузитесь”. Если данных мало, сделай аккуратную подводку вокруг темы новости, но не добавляй факты, которых нет в заголовке. Не используй Markdown-разметку, жирный текст, списки и хэштеги.'
          },
          {
            role: 'user',
            content: `Создай короткий пост для Telegram по новости.\n\nТребования:\n- 1 эмодзи в начале заголовка.\n- 1 короткий заголовок.\n- 1-2 предложения описания.\n- В конце обязательно добавь:\nИсточник: ${item.source}\n${item.link}\n\nНовость:\nИсточник: ${item.source}\nЗаголовок: ${item.title}\nДата новости: ${item.publishedAt || 'unknown'}\nСсылка: ${item.link}`
          }
        ],
        temperature: 0.7,
        max_tokens: 220
      })
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;

    if (!text) {
      return null;
    }

    return sanitizeAiPost(text, item);
  } catch {
    return null;
  }
}

async function testOpenAi(env) {
  if (!env.OPENAI_API_KEY) {
    return 'OPENAI_API_KEY is not configured';
  }

  const model = env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly: ok'
          }
        ],
        temperature: 0,
        max_tokens: 10
      })
    });

    if (!response.ok) {
      const errorText = (await response.text()).trim().slice(0, 1000);
      return errorText
        ? `AI test failed ❌ status: ${response.status}\n${errorText}`
        : `AI test failed ❌ status: ${response.status}`;
    }

    const data = await response.json();
    const message = data?.choices?.[0]?.message?.content;

    if (!message) {
      return `AI test failed ❌ empty response, model: ${model}`;
    }

    return `AI is configured ✅\nModel: ${model}`;
  } catch {
    return 'AI test failed ❌ network or runtime error';
  }
}

async function createNewsPost(env, item) {
  const aiPost = await generateAiNewsPost(env, item);
  return aiPost || formatFallbackNewsPost(item);
}

function createDraftId() {
  return crypto.randomUUID();
}

function draftKey(draftId) {
  return `${DRAFT_KV_PREFIX}${draftId}`;
}

function newsIndexKey(item) {
  return `${NEWS_INDEX_KV_PREFIX}${normalizeNewsLink(item.link)}`;
}

function publishDraftKeyboard(draftId) {
  return {
    inline_keyboard: [
      [
        {
          text: '✅ Опубликовать',
          callback_data: `${PUBLISH_DRAFT_CALLBACK_PREFIX}${draftId}`
        },
        {
          text: '❌ Пропустить',
          callback_data: `${SKIP_DRAFT_CALLBACK_PREFIX}${draftId}`
        }
      ]
    ]
  };
}

async function saveDraft(env, item, post) {
  if (!env.DRAFTS) {
    return null;
  }

  const draftId = createDraftId();
  const draft = {
    id: draftId,
    status: DRAFT_STATUS_DRAFT,
    item,
    post,
    createdAt: new Date().toISOString(),
    publishedAt: null,
    skippedAt: null
  };

  await saveDraftRecord(env, draft);
  await saveNewsIndexRecord(env, draft);

  return draftId;
}

async function saveDraftRecord(env, draft) {
  await env.DRAFTS.put(draftKey(draft.id), JSON.stringify(draft), {
    expirationTtl: DRAFT_TTL_SECONDS
  });
}

async function saveNewsIndexRecord(env, draft) {
  const indexRecord = {
    draftId: draft.id,
    status: draft.status,
    source: draft.item.source,
    title: draft.item.title,
    link: draft.item.link,
    newsPublishedAt: draft.item.publishedAt ?? null,
    createdAt: draft.createdAt,
    publishedAt: draft.publishedAt ?? null,
    skippedAt: draft.skippedAt ?? null
  };

  await env.DRAFTS.put(newsIndexKey(draft.item), JSON.stringify(indexRecord), {
    expirationTtl: NEWS_INDEX_TTL_SECONDS
  });
}

async function getDraft(env, draftId) {
  if (!env.DRAFTS) {
    return null;
  }

  const rawDraft = await env.DRAFTS.get(draftKey(draftId));
  if (!rawDraft) {
    return null;
  }

  return JSON.parse(rawDraft);
}

async function getNewsIndex(env, item) {
  if (!env.DRAFTS) {
    return null;
  }

  const rawIndex = await env.DRAFTS.get(newsIndexKey(item));
  if (!rawIndex) {
    return null;
  }

  return JSON.parse(rawIndex);
}

async function findFirstNewNewsItem(env, items) {
  for (const item of items) {
    const existingIndex = await getNewsIndex(env, item);
    if (!existingIndex) {
      return item;
    }
  }

  return null;
}

async function fetchNewsSource(source) {
  try {
    const response = await fetch(source.url, {
      headers: {
        'user-agent': 'BroNewsBot/0.1 (+https://t.me/BroNews_bot)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      }
    });

    if (!response.ok) {
      return [];
    }

    const xml = await response.text();
    return parseFeedItems(xml, source.name);
  } catch {
    return [];
  }
}

async function fetchGamingNews({ maxItems = MAX_NEWS_ITEMS_TO_SHOW } = {}) {
  try {
    const sourceResults = await Promise.all(NEWS_SOURCES.map(fetchNewsSource));
    const allItems = sourceResults.flat();

    // /fetch_news shows a short list, but /draft_news scans deeper to skip already processed links.
    return { ok: true, items: deduplicateNewsItems(allItems, maxItems) };
  } catch {
    return { ok: false, items: [] };
  }
}

async function handlePublishDraft(env, userChatId, callbackQueryId, draftId) {
  if (!env.CHANNEL_ID) {
    await answerCallbackQuery(env, callbackQueryId, 'CHANNEL_ID is not configured');
    await sendTelegramMessage(env, userChatId, 'CHANNEL_ID is not configured');
    return;
  }

  if (!env.DRAFTS) {
    await answerCallbackQuery(env, callbackQueryId, 'DRAFTS KV is not configured');
    await sendTelegramMessage(env, userChatId, 'DRAFTS KV is not configured');
    return;
  }

  const draft = await getDraft(env, draftId);
  if (!draft?.post) {
    await answerCallbackQuery(env, callbackQueryId, 'Draft expired ❌');
    await sendTelegramMessage(env, userChatId, 'Draft expired or not found ❌');
    return;
  }

  if (draft.status === DRAFT_STATUS_PUBLISHED) {
    await answerCallbackQuery(env, callbackQueryId, 'Already published ✅');
    await sendTelegramMessage(env, userChatId, 'This draft was already published ✅');
    return;
  }

  if (draft.status === DRAFT_STATUS_SKIPPED) {
    await answerCallbackQuery(env, callbackQueryId, 'Already skipped');
    await sendTelegramMessage(env, userChatId, 'This draft was skipped');
    return;
  }

  await sendTelegramMessage(env, env.CHANNEL_ID, draft.post);

  const publishedDraft = {
    ...draft,
    status: DRAFT_STATUS_PUBLISHED,
    publishedAt: new Date().toISOString()
  };
  await saveDraftRecord(env, publishedDraft);
  await saveNewsIndexRecord(env, publishedDraft);

  await answerCallbackQuery(env, callbackQueryId, 'Published ✅');
  await sendTelegramMessage(env, userChatId, 'Published to channel ✅');
}

async function handleSkipDraft(env, userChatId, callbackQueryId, draftId) {
  if (!env.DRAFTS) {
    await answerCallbackQuery(env, callbackQueryId, 'DRAFTS KV is not configured');
    await sendTelegramMessage(env, userChatId, 'DRAFTS KV is not configured');
    return;
  }

  const draft = await getDraft(env, draftId);
  if (!draft?.post) {
    await answerCallbackQuery(env, callbackQueryId, 'Draft expired ❌');
    await sendTelegramMessage(env, userChatId, 'Draft expired or not found ❌');
    return;
  }

  if (draft.status === DRAFT_STATUS_PUBLISHED) {
    await answerCallbackQuery(env, callbackQueryId, 'Already published ✅');
    await sendTelegramMessage(env, userChatId, 'This draft was already published ✅');
    return;
  }

  if (draft.status === DRAFT_STATUS_SKIPPED) {
    await answerCallbackQuery(env, callbackQueryId, 'Already skipped');
    await sendTelegramMessage(env, userChatId, 'This draft was already skipped');
    return;
  }

  const skippedDraft = {
    ...draft,
    status: DRAFT_STATUS_SKIPPED,
    skippedAt: new Date().toISOString()
  };
  await saveDraftRecord(env, skippedDraft);
  await saveNewsIndexRecord(env, skippedDraft);

  await answerCallbackQuery(env, callbackQueryId, 'Skipped');
  await sendTelegramMessage(env, userChatId, 'Draft skipped');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({
        ok: true,
        service: 'ai-gaming-news-bot',
        version: '0.1.0'
      });
    }

    if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return jsonResponse({ ok: false, error: 'Missing TELEGRAM_BOT_TOKEN' }, 500);
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
      }

      const callbackData = update?.callback_query?.data;
      const callbackQueryId = update?.callback_query?.id;
      const callbackChatId = update?.callback_query?.message?.chat?.id;

      if (callbackData?.startsWith(PUBLISH_DRAFT_CALLBACK_PREFIX) && callbackChatId && callbackQueryId) {
        const draftId = callbackData.slice(PUBLISH_DRAFT_CALLBACK_PREFIX.length);
        await handlePublishDraft(env, callbackChatId, callbackQueryId, draftId);
        return jsonResponse({ ok: true });
      }

      if (callbackData?.startsWith(SKIP_DRAFT_CALLBACK_PREFIX) && callbackChatId && callbackQueryId) {
        const draftId = callbackData.slice(SKIP_DRAFT_CALLBACK_PREFIX.length);
        await handleSkipDraft(env, callbackChatId, callbackQueryId, draftId);
        return jsonResponse({ ok: true });
      }

      const messageText = update?.message?.text;
      const userChatId = update?.message?.chat?.id;
      const chatType = update?.message?.chat?.type;

      if (messageText === START_COMMAND && userChatId) {
        await sendTelegramMessage(env, userChatId, START_REPLY);
      }

      if (messageText === TEST_CHANNEL_COMMAND && userChatId && chatType === 'private') {
        if (!env.CHANNEL_ID) {
          await sendTelegramMessage(env, userChatId, 'CHANNEL_ID is not configured');
          return jsonResponse({ ok: true });
        }

        await sendTelegramMessage(env, env.CHANNEL_ID, TEST_CHANNEL_POST_TEXT);
        await sendTelegramMessage(env, userChatId, TEST_CHANNEL_CONFIRM_TEXT);
      }

      if (messageText === MOCK_NEWS_COMMAND && userChatId && chatType === 'private') {
        if (!env.CHANNEL_ID) {
          await sendTelegramMessage(env, userChatId, 'CHANNEL_ID is not configured');
          return jsonResponse({ ok: true });
        }

        try {
          await sendTelegramMessage(env, env.CHANNEL_ID, MOCK_NEWS_POST_TEXT);
          await sendTelegramMessage(env, userChatId, MOCK_NEWS_CONFIRM_TEXT);
        } catch {
          await sendTelegramMessage(env, userChatId, MOCK_NEWS_ERROR_TEXT);
        }
      }

      if (messageText === FETCH_NEWS_COMMAND && userChatId && chatType === 'private') {
        const newsResult = await fetchGamingNews();

        if (!newsResult.ok) {
          await sendTelegramMessage(env, userChatId, 'Failed to fetch news ❌');
          return jsonResponse({ ok: true });
        }

        if (newsResult.items.length === 0) {
          await sendTelegramMessage(env, userChatId, 'No news found');
          return jsonResponse({ ok: true });
        }

        const newsList = newsResult.items
          .map((item, index) => `${index + 1}. [${item.source}] ${item.title}\n${item.link}`)
          .join('\n\n');

        await sendTelegramMessage(env, userChatId, `Latest gaming news:\n\n${newsList}`);
      }

      if (messageText === DRAFT_NEWS_COMMAND && userChatId && chatType === 'private') {
        if (!env.DRAFTS) {
          await sendTelegramMessage(env, userChatId, 'DRAFTS KV is not configured');
          return jsonResponse({ ok: true });
        }

        const newsResult = await fetchGamingNews({ maxItems: MAX_DRAFT_NEWS_ITEMS_TO_SCAN });

        if (!newsResult.ok) {
          await sendTelegramMessage(env, userChatId, 'Failed to create draft news ❌');
          return jsonResponse({ ok: true });
        }

        if (newsResult.items.length === 0) {
          await sendTelegramMessage(env, userChatId, 'No news found');
          return jsonResponse({ ok: true });
        }

        const item = await findFirstNewNewsItem(env, newsResult.items);
        if (!item) {
          await sendTelegramMessage(env, userChatId, 'No new news found');
          return jsonResponse({ ok: true });
        }

        const post = await createNewsPost(env, item);
        const draftId = await saveDraft(env, item, post);

        if (!draftId) {
          await sendTelegramMessage(env, userChatId, 'Failed to save draft ❌');
          return jsonResponse({ ok: true });
        }

        await sendTelegramMessage(env, userChatId, formatDraftMessage(post), {
          reply_markup: publishDraftKeyboard(draftId)
        });
      }

      if (messageText === AI_TEST_COMMAND && userChatId && chatType === 'private') {
        const aiTestResult = await testOpenAi(env);
        await sendTelegramMessage(env, userChatId, aiTestResult);
      }

      return jsonResponse({ ok: true });
    }

    return new Response('AI Gaming News Bot is running');
  }
};
