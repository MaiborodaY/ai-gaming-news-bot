import {
  FINANCE_CRON_EXPRESSION,
  fetchMarketSnapshot,
  formatMarketReport,
  getMarketReportSlot,
  getMarketTestSlot,
  marketReportKey
} from './market.js';

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
const DEBUG_IMAGES_COMMAND = '/debug_images';
const RESET_NEWS_INDEX_COMMAND = '/reset_news_index';
const ADMIN_COMMAND = '/admin';
const STATS_COMMAND = '/stats';
const SOURCES_COMMAND = '/sources';
const AUTO_POST_TEST_COMMAND = '/auto_post_test';
const MARKET_TEST_COMMAND = '/market_test';
const ADMIN_HELP_TEXT = `BroNews admin commands:

/draft_news - create AI draft from latest unprocessed news
/fetch_news - show latest fetched RSS news
/debug_images - debug image detection for latest news
/reset_news_index - reset processed news index for testing
/stats - show bot draft and source stats
/sources - show RSS source diagnostics
/auto_post_test - run one automatic post cycle now
/market_test - publish one market report to the finance channel
/ai_test - check OpenAI API connection
/test_channel - send test message to channel
/mock_news - send mock news post to channel
/start - check that bot is alive

Draft buttons:
Publish - publish draft to channel
Skip - mark draft as skipped

Notes:
- /reset_news_index deletes only processed news index keys, not draft records.
- /debug_images is for diagnostics only.`;
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
  },
  {
    name: 'PC Gamer',
    url: 'https://www.pcgamer.com/rss/'
  },
  {
    name: 'IGN Games',
    url: 'https://feeds.ign.com/ign/games-all'
  },
  {
    name: 'Nintendo Life',
    url: 'https://www.nintendolife.com/feeds/latest'
  }
];
const MAX_FEED_ITEMS_TO_SCAN = 20;
const MAX_NEWS_ITEMS_TO_SHOW = 5;
const MAX_DRAFT_NEWS_ITEMS_TO_SCAN = 100;
const MAX_DEBUG_IMAGES_ITEMS_TO_SCAN = 30;
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const MAX_TELEGRAM_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
const GAMING_CRON_EXPRESSION = '0 10-18/2 * * *';
const MARKET_LATEST_KV_KEY = 'market:latest';
const MARKET_REPORT_TTL_SECONDS = 60 * 60 * 24 * 30;

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

function summarizeTelegramError(status, responseText) {
  const shortBody = (responseText || '').trim().replace(/\s+/g, ' ').slice(0, 700);
  return shortBody ? `Telegram API error: ${status} ${shortBody}` : `Telegram API error: ${status}`;
}

async function sendTelegramPhotoOnly(env, chatId, photoUrl, caption, extraPayload = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return { ok: false, error: 'Missing TELEGRAM_BOT_TOKEN' };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: caption?.slice(0, 1000),
        ...extraPayload
      })
    });

    if (!response.ok) {
      const responseText = await response.text();
      return {
        ok: false,
        error: summarizeTelegramError(response.status, responseText)
      };
    }

    return {
      ok: true,
      result: await response.json()
    };
  } catch {
    return { ok: false, error: 'Telegram API error: network or runtime error' };
  }
}

async function fetchImageBlob(imageUrl) {
  try {
    const response = await fetch(imageUrl, {
      headers: {
        'user-agent': 'BroNewsBot/0.1 (+https://t.me/BroNews_bot)',
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      return { ok: false, error: `Image fetch failed: HTTP ${response.status}` };
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      return { ok: false, error: `Image fetch rejected content-type: ${contentType || 'unknown'}` };
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_TELEGRAM_UPLOAD_IMAGE_BYTES) {
      return { ok: false, error: `Image fetch failed: file too large (${contentLength} bytes)` };
    }

    const blob = await response.blob();
    if (blob.size > MAX_TELEGRAM_UPLOAD_IMAGE_BYTES) {
      return { ok: false, error: `Image fetch failed: file too large (${blob.size} bytes)` };
    }

    return { ok: true, blob, contentType };
  } catch {
    return { ok: false, error: 'Image fetch failed: network or runtime error' };
  }
}

function getImageFilename(imageUrl, contentType = '') {
  try {
    const parsed = new URL(imageUrl);
    const rawName = parsed.pathname.split('/').pop() || '';
    if (rawName && /\.[a-z0-9]+$/i.test(rawName)) {
      return rawName;
    }
  } catch {
    // ignore URL parsing errors and use content-type fallback below
  }

  if (contentType.includes('image/png')) {
    return 'image.png';
  }
  if (contentType.includes('image/webp')) {
    return 'image.webp';
  }
  if (contentType.includes('image/gif')) {
    return 'image.gif';
  }
  if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
    return 'image.jpg';
  }

  return 'image.jpg';
}

async function sendTelegramPhotoUpload(env, chatId, imageUrl, caption, extraPayload = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { ok: false, error: 'Missing TELEGRAM_BOT_TOKEN' };
  }

  const imageResult = await fetchImageBlob(imageUrl);
  if (!imageResult.ok) {
    return imageResult;
  }

  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append('caption', (caption || '').slice(0, 1000));
  formData.append('photo', imageResult.blob, getImageFilename(imageUrl, imageResult.contentType));

  if (extraPayload.reply_markup) {
    formData.append('reply_markup', JSON.stringify(extraPayload.reply_markup));
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const responseText = await response.text();
      return { ok: false, error: summarizeTelegramError(response.status, responseText) };
    }

    return { ok: true, result: await response.json() };
  } catch {
    return { ok: false, error: 'Telegram upload error: network or runtime error' };
  }
}

function deduplicateImageUrls(imageUrls = []) {
  const seen = new Set();
  const uniqueUrls = [];

  for (const imageUrl of imageUrls) {
    if (!isSupportedImageUrl(imageUrl)) {
      continue;
    }

    const normalized = imageUrl.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueUrls.push(normalized);
  }

  return uniqueUrls;
}

async function sendTelegramPhotoWithFallbackCandidates(env, chatId, imageUrls, caption, extraPayload = {}) {
  const uniqueCandidates = deduplicateImageUrls(imageUrls);

  if (uniqueCandidates.length === 0) {
    await sendTelegramMessage(env, chatId, caption, extraPayload);
    return { ok: false, error: 'No valid image candidates' };
  }

  let lastError = 'Unknown sendPhoto error';

  for (const imageUrl of uniqueCandidates) {
    const urlSendResult = await sendTelegramPhotoOnly(env, chatId, imageUrl, caption, extraPayload);
    if (urlSendResult.ok) {
      return { ok: true, result: urlSendResult.result, imageUrl };
    }

    const uploadSendResult = await sendTelegramPhotoUpload(env, chatId, imageUrl, caption, extraPayload);
    if (uploadSendResult.ok) {
      return { ok: true, result: uploadSendResult.result, imageUrl };
    }

    lastError = uploadSendResult.error || urlSendResult.error || lastError;
  }

  // If all image candidates fail, fallback to text-only so the draft/publication is not lost.
  await sendTelegramMessage(env, chatId, caption, extraPayload);
  return { ok: false, error: lastError };
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

function getAttributeValue(xml, tagName, attributeName) {
  const match = xml.match(new RegExp(`<${tagName}[^>]*\\b${attributeName}=["']([^"']+)["'][^>]*>`, 'i'));
  return match ? decodeXmlEntities(match[1]).trim() : '';
}

function isSupportedImageUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.png') || path.endsWith('.webp') || path.endsWith('.gif');
  } catch {
    return false;
  }
}

function getImageCandidatesFromItemXml(itemXml) {
  const candidates = [
    getAttributeValue(itemXml, 'media:content', 'url'),
    getAttributeValue(itemXml, 'media:thumbnail', 'url'),
    getAttributeValue(itemXml, 'enclosure', 'url'),
    getAttributeValue(itemXml, 'itunes:image', 'href')
  ];

  const imageBlockMatch = itemXml.match(/<image\b[^>]*>([\s\S]*?)<\/image>/i);
  if (imageBlockMatch?.[1]) {
    candidates.push(getTagValue(imageBlockMatch[1], 'url'));
  }

  return deduplicateImageUrls(candidates);
}

function getMetaContentValue(html, attributeName, attributeValue) {
  const metaMatch = html.match(
    new RegExp(`<meta\\b(?=[^>]*\\b${attributeName}=["']${attributeValue}["'])(?=[^>]*\\bcontent=["']([^"']+)["'])[^>]*>`, 'i')
  );

  return metaMatch?.[1] ? decodeXmlEntities(metaMatch[1]).trim() : '';
}

function normalizeImageUrl(imageUrl, pageUrl) {
  if (!imageUrl) {
    return '';
  }

  try {
    return new URL(imageUrl, pageUrl).toString();
  } catch {
    return '';
  }
}

function getHtmlImageMetaCandidates(html) {
  return [
    getMetaContentValue(html, 'property', 'og:image'),
    getMetaContentValue(html, 'name', 'twitter:image'),
    getMetaContentValue(html, 'name', 'twitter:image:src'),
    getMetaContentValue(html, 'property', 'twitter:image'),
    getMetaContentValue(html, 'itemprop', 'image')
  ];
}

async function fetchOpenGraphImageCandidates(pageUrl) {
  try {
    const response = await fetch(pageUrl, {
      headers: {
        'user-agent': 'BroNewsBot/0.1 (+https://t.me/BroNews_bot)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const normalizedCandidates = getHtmlImageMetaCandidates(html).map((imageUrl) => normalizeImageUrl(imageUrl, pageUrl));
    return deduplicateImageUrls(normalizedCandidates);
  } catch {
    return [];
  }
}

async function enrichNewsItemImage(item) {
  // Some sources do not expose images in RSS, but keep them in article metadata.
  const openGraphCandidates = await fetchOpenGraphImageCandidates(item.link);
  const allCandidates = deduplicateImageUrls([...(item.imageCandidates || []), ...openGraphCandidates]);
  const imageUrl = allCandidates[0] || null;
  return { ...item, imageUrl, imageCandidates: allCandidates };
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
      const imageCandidates = getImageCandidatesFromItemXml(itemXml);
      const imageUrl = imageCandidates[0] || null;

      if (!title || !link) {
        return null;
      }

      return { source: sourceName, title, link, publishedAt, imageUrl, imageCandidates };
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

function interleaveNewsItemsBySource(sourceResults) {
  const interleaved = [];
  const maxLength = sourceResults.reduce((max, items) => Math.max(max, items.length), 0);

  for (let index = 0; index < maxLength; index += 1) {
    for (const items of sourceResults) {
      if (items[index]) {
        interleaved.push(items[index]);
      }
    }
  }

  return interleaved;
}

function formatImageDebugList(items) {
  return items.map((item, index) => {
    const candidates = deduplicateImageUrls(item.imageCandidates || (item.imageUrl ? [item.imageUrl] : []));
    const lines = [
      `${index + 1}. [${item.source}] ${item.title}`,
      `image: ${item.imageUrl ? 'yes' : 'no'}`,
      `primary: ${item.imageUrl || 'n/a'}`,
      `candidates: ${candidates.length}`
    ];

    if (candidates[0]) {
      lines.push(`candidate 1: ${candidates[0]}`);
    }
    if (candidates[1]) {
      lines.push(`candidate 2: ${candidates[1]}`);
    }
    lines.push(`link: ${item.link}`);
    return lines.join('\n');
  });
}

async function sendLongTelegramMessage(env, chatId, header, blocks) {
  let chunk = header.trim();

  for (const block of blocks) {
    const candidate = `${chunk}\n\n${block}`.trim();
    if (candidate.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      chunk = candidate;
      continue;
    }

    await sendTelegramMessage(env, chatId, chunk);
    chunk = `${header.trim()}\n\n${block}`.trim();
  }

  if (chunk) {
    await sendTelegramMessage(env, chatId, chunk);
  }
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
    imageUrl: draft.item.imageUrl ?? null,
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

async function resetNewsIndex(env) {
  if (!env.DRAFTS) {
    return null;
  }

  let deletedCount = 0;
  let cursor;
  let isListComplete = false;

  while (!isListComplete) {
    const listResult = await env.DRAFTS.list({ prefix: NEWS_INDEX_KV_PREFIX, cursor });

    for (const key of listResult.keys) {
      // Safety guard: remove only processed-news index keys.
      if (!key.name.startsWith(NEWS_INDEX_KV_PREFIX)) {
        continue;
      }

      await env.DRAFTS.delete(key.name);
      deletedCount += 1;
    }

    isListComplete = Boolean(listResult.list_complete);
    cursor = listResult.cursor;
  }

  return deletedCount;
}

async function listKvKeysByPrefix(kv, prefix) {
  const keys = [];
  let cursor;
  let isListComplete = false;

  while (!isListComplete) {
    const listResult = await kv.list({ prefix, cursor });
    for (const key of listResult.keys) {
      if (key.name.startsWith(prefix)) {
        keys.push(key.name);
      }
    }

    isListComplete = Boolean(listResult.list_complete);
    cursor = listResult.cursor;
  }

  return keys;
}

function formatStatsMessage(stats) {
  const sourceLines = stats.sourceLines.length > 0 ? stats.sourceLines.join('\n') : 'No data';

  return `📊 BroNews stats

Total:
Drafts: ${stats.draftCount}
Published: ${stats.publishedCount}
Skipped: ${stats.skippedCount}
All drafts: ${stats.totalDrafts}
Processed news index: ${stats.processedNewsIndexCount}

Today UTC:
Created: ${stats.createdToday}
Published: ${stats.publishedToday}
Skipped: ${stats.skippedToday}

Sources:
${sourceLines}`;
}

async function getBotStats(env) {
  if (!env.DRAFTS) {
    return null;
  }

  const draftKeys = await listKvKeysByPrefix(env.DRAFTS, DRAFT_KV_PREFIX);
  const processedNewsIndexKeys = await listKvKeysByPrefix(env.DRAFTS, NEWS_INDEX_KV_PREFIX);
  const todayUtc = new Date().toISOString().slice(0, 10);

  let draftCount = 0;
  let publishedCount = 0;
  let skippedCount = 0;
  let createdToday = 0;
  let publishedToday = 0;
  let skippedToday = 0;

  const sourceCounts = new Map();
  const knownSources = ['PlayStation Blog', 'Xbox Wire', 'Gematsu', 'Steam', 'PC Gamer', 'IGN Games', 'Nintendo Life'];

  for (const keyName of draftKeys) {
    const rawDraft = await env.DRAFTS.get(keyName);
    if (!rawDraft) {
      continue;
    }

    let draft;
    try {
      draft = JSON.parse(rawDraft);
    } catch {
      continue;
    }

    const status = draft?.status;
    if (status === DRAFT_STATUS_DRAFT) {
      draftCount += 1;
    } else if (status === DRAFT_STATUS_PUBLISHED) {
      publishedCount += 1;
    } else if (status === DRAFT_STATUS_SKIPPED) {
      skippedCount += 1;
    }

    if (typeof draft?.createdAt === 'string' && draft.createdAt.startsWith(todayUtc)) {
      createdToday += 1;
    }
    if (typeof draft?.publishedAt === 'string' && draft.publishedAt.startsWith(todayUtc)) {
      publishedToday += 1;
    }
    if (typeof draft?.skippedAt === 'string' && draft.skippedAt.startsWith(todayUtc)) {
      skippedToday += 1;
    }

    const source = draft?.item?.source || 'Unknown';
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
  }

  const sourceLines = [];
  for (const source of knownSources) {
    sourceLines.push(`${source}: ${sourceCounts.get(source) || 0}`);
    sourceCounts.delete(source);
  }
  sourceLines.push(`Unknown: ${sourceCounts.get('Unknown') || 0}`);
  sourceCounts.delete('Unknown');

  for (const [source, count] of [...sourceCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    sourceLines.push(`${source}: ${count}`);
  }

  return {
    draftCount,
    publishedCount,
    skippedCount,
    totalDrafts: draftCount + publishedCount + skippedCount,
    processedNewsIndexCount: processedNewsIndexKeys.length,
    createdToday,
    publishedToday,
    skippedToday,
    sourceLines
  };
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

async function findNextUnprocessedNewsItem(env) {
  const sourceResults = await Promise.all(NEWS_SOURCES.map(fetchNewsSource));
  const interleavedItems = interleaveNewsItemsBySource(sourceResults);
  const candidates = deduplicateNewsItems(interleavedItems, MAX_DRAFT_NEWS_ITEMS_TO_SCAN);

  if (candidates.length === 0) {
    return null;
  }

  return findFirstNewNewsItem(env, candidates);
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

async function getSourceDiagnostics(source) {
  try {
    const response = await fetch(source.url, {
      headers: {
        'user-agent': 'BroNewsBot/0.1 (+https://t.me/BroNews_bot)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      }
    });

    if (!response.ok) {
      return {
        source: source.name,
        feedUrl: source.url,
        itemsFound: 0,
        recentItems: 0,
        withImage: 0,
        status: `❌ failed HTTP ${response.status}`
      };
    }

    const xml = await response.text();
    const parsedItems = parseFeedItems(xml, source.name);
    const itemsWithImages = await Promise.all(parsedItems.map(enrichNewsItemImage));
    const withImage = itemsWithImages.filter((item) => Boolean(item.imageUrl)).length;

    let status = '✅ ok';
    if (parsedItems.length === 0) {
      status = '⚠️ empty';
    } else if (withImage === 0) {
      status = '⚠️ no images';
    }

    return {
      source: source.name,
      feedUrl: source.url,
      itemsFound: parsedItems.length,
      recentItems: parsedItems.length,
      withImage,
      status
    };
  } catch {
    return {
      source: source.name,
      feedUrl: source.url,
      itemsFound: 0,
      recentItems: 0,
      withImage: 0,
      status: '❌ failed network error'
    };
  }
}

async function getSourcesDiagnostics() {
  return Promise.all(NEWS_SOURCES.map(getSourceDiagnostics));
}

function formatSourcesDiagnosticsMessage(results) {
  const lines = ['🗞 BroNews sources', ''];

  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. ${result.source}`);
    lines.push(`Feed: ${result.feedUrl}`);
    lines.push(`Items found: ${result.itemsFound}`);
    lines.push(`Recent items: ${result.recentItems}`);
    lines.push(`With image: ${result.withImage}`);
    lines.push(`Status: ${result.status}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function fetchGamingNews({ maxItems = MAX_NEWS_ITEMS_TO_SHOW, enrichImages = true } = {}) {
  try {
    const sourceResults = await Promise.all(NEWS_SOURCES.map(fetchNewsSource));
    const allItems = sourceResults.flat();
    const uniqueItems = deduplicateNewsItems(allItems, maxItems);

    // /fetch_news shows a short list, but /draft_news scans deeper to skip already processed links.
    if (!enrichImages) {
      return { ok: true, items: uniqueItems };
    }

    const itemsWithImages = await Promise.all(uniqueItems.map(enrichNewsItemImage));
    return { ok: true, items: itemsWithImages };
  } catch {
    return { ok: false, items: [] };
  }
}

async function publishNewsItem(env, item) {
  if (!env.CHANNEL_ID) {
    return { ok: false, reason: 'CHANNEL_ID is not configured' };
  }

  if (!env.DRAFTS) {
    return { ok: false, reason: 'DRAFTS KV is not configured' };
  }

  const enrichedItem = await enrichNewsItemImage(item);
  const post = await createNewsPost(env, enrichedItem);
  const draftId = await saveDraft(env, enrichedItem, post);

  if (!draftId) {
    return { ok: false, reason: 'Failed to save draft' };
  }

  const imageCandidates = deduplicateImageUrls(enrichedItem.imageCandidates || (enrichedItem.imageUrl ? [enrichedItem.imageUrl] : []));
  if (imageCandidates.length > 0) {
    await sendTelegramPhotoWithFallbackCandidates(env, env.CHANNEL_ID, imageCandidates, post);
  } else {
    await sendTelegramMessage(env, env.CHANNEL_ID, post);
  }

  const savedDraft = await getDraft(env, draftId);
  if (!savedDraft?.post) {
    return { ok: false, reason: 'Draft was not found after save' };
  }

  const publishedDraft = {
    ...savedDraft,
    status: DRAFT_STATUS_PUBLISHED,
    publishedAt: new Date().toISOString()
  };
  await saveDraftRecord(env, publishedDraft);
  await saveNewsIndexRecord(env, publishedDraft);

  return { ok: true, source: enrichedItem.source, title: enrichedItem.title };
}

async function runAutoPost(env) {
  try {
    if (!env.CHANNEL_ID) {
      return { ok: false, reason: 'CHANNEL_ID is not configured' };
    }

    if (!env.DRAFTS) {
      return { ok: false, reason: 'DRAFTS KV is not configured' };
    }

    const item = await findNextUnprocessedNewsItem(env);
    if (!item) {
      return { ok: true, reason: 'no_new_news' };
    }

    return publishNewsItem(env, item);
  } catch {
    return { ok: false, reason: 'Auto post runtime error' };
  }
}

async function runMarketReport(env, scheduledTime, { force = false } = {}) {
  try {
    const slot = force ? getMarketTestSlot(scheduledTime) : getMarketReportSlot(scheduledTime);
    if (!slot) {
      return { ok: true, reason: 'outside_report_hours' };
    }

    if (!env.FINANCE_CHANNEL_ID) {
      return { ok: false, reason: 'FINANCE_CHANNEL_ID is not configured' };
    }

    if (!env.DRAFTS) {
      return { ok: false, reason: 'DRAFTS KV is not configured' };
    }

    const reportKey = force ? null : marketReportKey(slot);
    if (reportKey && (await env.DRAFTS.get(reportKey))) {
      return { ok: true, reason: 'already_published' };
    }

    const previousSnapshotRaw = await env.DRAFTS.get(MARKET_LATEST_KV_KEY);
    let previousSnapshot = null;
    try {
      previousSnapshot = previousSnapshotRaw ? JSON.parse(previousSnapshotRaw) : null;
    } catch {
      previousSnapshot = null;
    }

    const snapshot = await fetchMarketSnapshot();
    const report = formatMarketReport(snapshot, previousSnapshot, slot);
    await sendTelegramMessage(env, env.FINANCE_CHANNEL_ID, report);

    const kvWrites = [env.DRAFTS.put(MARKET_LATEST_KV_KEY, JSON.stringify(snapshot))];
    if (reportKey) {
      kvWrites.push(
        env.DRAFTS.put(reportKey, JSON.stringify({ publishedAt: new Date().toISOString() }), {
          expirationTtl: MARKET_REPORT_TTL_SECONDS
        })
      );
    }
    await Promise.all(kvWrites);

    return { ok: true, reason: 'published' };
  } catch (error) {
    console.error('Market report failed', error);
    return { ok: false, reason: error instanceof Error ? error.message : 'Market report runtime error' };
  }
}

async function runScheduledMarketReport(env, scheduledTime) {
  const result = await runMarketReport(env, scheduledTime);
  if (!result.ok) {
    throw new Error(result.reason || 'Market report failed');
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

  const publishImageCandidates = deduplicateImageUrls(draft.item?.imageCandidates || (draft.item?.imageUrl ? [draft.item.imageUrl] : []));
  if (publishImageCandidates.length > 0) {
    await sendTelegramPhotoWithFallbackCandidates(env, env.CHANNEL_ID, publishImageCandidates, draft.post);
  } else {
    await sendTelegramMessage(env, env.CHANNEL_ID, draft.post);
  }

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

export {
  deduplicateNewsItems,
  interleaveNewsItemsBySource,
  formatStatsMessage,
  formatSourcesDiagnosticsMessage,
  formatImageDebugList,
  isSupportedImageUrl,
  normalizeNewsLink,
  parsePublishedAt
};

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

      if (messageText === ADMIN_COMMAND && userChatId && chatType === 'private') {
        await sendTelegramMessage(env, userChatId, ADMIN_HELP_TEXT);
      }

      if (messageText === STATS_COMMAND && userChatId && chatType === 'private') {
        const stats = await getBotStats(env);
        if (!stats) {
          await sendTelegramMessage(env, userChatId, 'DRAFTS KV is not configured');
          return jsonResponse({ ok: true });
        }

        await sendTelegramMessage(env, userChatId, formatStatsMessage(stats));
      }

      if (messageText === SOURCES_COMMAND && userChatId && chatType === 'private') {
        const diagnostics = await getSourcesDiagnostics();
        const sourceBlocks = diagnostics.map((result, index) =>
          [
            `${index + 1}. ${result.source}`,
            `Feed: ${result.feedUrl}`,
            `Items found: ${result.itemsFound}`,
            `Recent items: ${result.recentItems}`,
            `With image: ${result.withImage}`,
            `Status: ${result.status}`
          ].join('\n')
        );
        await sendLongTelegramMessage(env, userChatId, '🗞 BroNews sources', sourceBlocks);
      }


      if (messageText === AUTO_POST_TEST_COMMAND && userChatId && chatType === 'private') {
        const autoPostResult = await runAutoPost(env);

        if (autoPostResult.ok && autoPostResult.reason === 'no_new_news') {
          await sendTelegramMessage(env, userChatId, 'Auto post test: no new news found');
          return jsonResponse({ ok: true });
        }

        if (autoPostResult.ok) {
          await sendTelegramMessage(env, userChatId, `Auto post test ✅ Published: ${autoPostResult.source} - ${autoPostResult.title}`);
          return jsonResponse({ ok: true });
        }

        await sendTelegramMessage(env, userChatId, `Auto post test failed ❌ ${autoPostResult.reason || 'Unknown error'}`);
        return jsonResponse({ ok: true });
      }

      if (messageText === MARKET_TEST_COMMAND && userChatId && chatType === 'private') {
        const marketResult = await runMarketReport(env, Date.now(), { force: true });
        const message = marketResult.ok
          ? `Market test ✅ Published to ${env.FINANCE_CHANNEL_ID}`
          : `Market test failed ❌ ${marketResult.reason || 'Unknown error'}`;
        await sendTelegramMessage(env, userChatId, message);
        return jsonResponse({ ok: true });
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

        let rawItem;
        try {
          rawItem = await findNextUnprocessedNewsItem(env);
        } catch {
          await sendTelegramMessage(env, userChatId, 'Failed to create draft news ❌');
          return jsonResponse({ ok: true });
        }
        if (!rawItem) {
          await sendTelegramMessage(env, userChatId, 'No new news found');
          return jsonResponse({ ok: true });
        }

        const item = await enrichNewsItemImage(rawItem);
        const post = await createNewsPost(env, item);
        const draftId = await saveDraft(env, item, post);

        if (!draftId) {
          await sendTelegramMessage(env, userChatId, 'Failed to save draft ❌');
          return jsonResponse({ ok: true });
        }

        const draftImageCandidates = deduplicateImageUrls(item.imageCandidates || (item.imageUrl ? [item.imageUrl] : []));
        if (draftImageCandidates.length > 0) {
          const photoResult = await sendTelegramPhotoWithFallbackCandidates(
            env,
            userChatId,
            draftImageCandidates,
            formatDraftMessage(post),
            {
              reply_markup: publishDraftKeyboard(draftId)
            }
          );

          if (!photoResult.ok) {
            await sendTelegramMessage(
              env,
              userChatId,
              `Image found, but Telegram rejected it. Falling back to text-only.\nReason: ${(photoResult.error || 'Unknown error').slice(0, 900)}`
            );
          }
        } else {
          await sendTelegramMessage(env, userChatId, formatDraftMessage(post), {
            reply_markup: publishDraftKeyboard(draftId)
          });
        }
      }

      if (messageText === DEBUG_IMAGES_COMMAND && userChatId && chatType === 'private') {
        const newsResult = await fetchGamingNews({ maxItems: MAX_DEBUG_IMAGES_ITEMS_TO_SCAN });

        if (!newsResult.ok) {
          await sendTelegramMessage(env, userChatId, 'Failed to fetch news ❌');
          return jsonResponse({ ok: true });
        }

        if (newsResult.items.length === 0) {
          await sendTelegramMessage(env, userChatId, 'No news found');
          return jsonResponse({ ok: true });
        }

        const debugBlocks = formatImageDebugList(newsResult.items);
        await sendLongTelegramMessage(env, userChatId, 'Image debug:', debugBlocks);
      }

      if (messageText === RESET_NEWS_INDEX_COMMAND && userChatId && chatType === 'private') {
        const deletedCount = await resetNewsIndex(env);

        if (deletedCount === null) {
          await sendTelegramMessage(env, userChatId, 'DRAFTS KV is not configured');
          return jsonResponse({ ok: true });
        }

        if (deletedCount === 0) {
          await sendTelegramMessage(env, userChatId, 'News index is already empty');
          return jsonResponse({ ok: true });
        }

        await sendTelegramMessage(env, userChatId, `News index reset ✅ Deleted: ${deletedCount}`);
      }

      if (messageText === AI_TEST_COMMAND && userChatId && chatType === 'private') {
        const aiTestResult = await testOpenAi(env);
        await sendTelegramMessage(env, userChatId, aiTestResult);
      }

      return jsonResponse({ ok: true });
    }

    return new Response('AI Gaming News Bot is running');
  },

  async scheduled(event, env, ctx) {
    if (event.cron === GAMING_CRON_EXPRESSION) {
      ctx.waitUntil(runAutoPost(env));
      return;
    }

    if (event.cron === FINANCE_CRON_EXPRESSION) {
      ctx.waitUntil(runScheduledMarketReport(env, event.scheduledTime));
    }
  }
};
