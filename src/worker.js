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
const PUBLISH_DRAFT_CALLBACK = 'publish_draft_news';
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

      if (!title || !link) {
        return null;
      }

      return { source: sourceName, title, link };
    })
    .filter(Boolean);
}

function deduplicateNewsItems(items) {
  const seenTitles = new Set();
  const uniqueItems = [];

  for (const item of items) {
    const normalizedTitle = normalizeNewsTitle(item.title);
    if (seenTitles.has(normalizedTitle)) {
      continue;
    }

    seenTitles.add(normalizedTitle);
    uniqueItems.push(item);

    if (uniqueItems.length >= MAX_NEWS_ITEMS_TO_SHOW) {
      break;
    }
  }

  return uniqueItems;
}

function formatDraftNewsPost(item) {
  return `📝 Черновик поста

🎮 ${item.title}

Появилась новая игровая новость от ${item.source}. Полные детали доступны по ссылке ниже.

Источник: ${item.source}
${item.link}`;
}

function formatChannelNewsPost(item) {
  return `🎮 ${item.title}

Появилась новая игровая новость от ${item.source}. Полные детали доступны по ссылке ниже.

Источник: ${item.source}
${item.link}`;
}

function publishDraftKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: '✅ Опубликовать',
          callback_data: PUBLISH_DRAFT_CALLBACK
        }
      ]
    ]
  };
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

async function fetchGamingNews() {
  try {
    const sourceResults = await Promise.all(NEWS_SOURCES.map(fetchNewsSource));
    const allItems = sourceResults.flat();
    return { ok: true, items: deduplicateNewsItems(allItems) };
  } catch {
    return { ok: false, items: [] };
  }
}

async function handlePublishDraft(env, userChatId, callbackQueryId) {
  if (!env.CHANNEL_ID) {
    await answerCallbackQuery(env, callbackQueryId, 'CHANNEL_ID is not configured');
    await sendTelegramMessage(env, userChatId, 'CHANNEL_ID is not configured');
    return;
  }

  const newsResult = await fetchGamingNews();
  if (!newsResult.ok || newsResult.items.length === 0) {
    await answerCallbackQuery(env, callbackQueryId, 'Failed to publish news ❌');
    await sendTelegramMessage(env, userChatId, 'Failed to publish news ❌');
    return;
  }

  const post = formatChannelNewsPost(newsResult.items[0]);
  await sendTelegramMessage(env, env.CHANNEL_ID, post);
  await answerCallbackQuery(env, callbackQueryId, 'Published ✅');
  await sendTelegramMessage(env, userChatId, 'Published to channel ✅');
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

      if (callbackData === PUBLISH_DRAFT_CALLBACK && callbackChatId && callbackQueryId) {
        await handlePublishDraft(env, callbackChatId, callbackQueryId);
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
        const newsResult = await fetchGamingNews();

        if (!newsResult.ok) {
          await sendTelegramMessage(env, userChatId, 'Failed to create draft news ❌');
          return jsonResponse({ ok: true });
        }

        if (newsResult.items.length === 0) {
          await sendTelegramMessage(env, userChatId, 'No news found');
          return jsonResponse({ ok: true });
        }

        await sendTelegramMessage(env, userChatId, formatDraftNewsPost(newsResult.items[0]), {
          reply_markup: publishDraftKeyboard()
        });
      }

      return jsonResponse({ ok: true });
    }

    return new Response('AI Gaming News Bot is running');
  }
};
