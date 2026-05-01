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
const STEAM_NEWS_RSS_URL = 'https://store.steampowered.com/feeds/news.xml';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

async function sendTelegramMessage(env, chatId, text) {
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN');
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram API error: ${response.status}`);
  }
}

function decodeXmlEntities(value = '') {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'");
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

function parseFeedItems(xml) {
  const rssItems = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  const atomEntries = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  const blocks = rssItems.length > 0 ? rssItems : atomEntries;

  return blocks
    .slice(0, 3)
    .map((match) => {
      const itemXml = match[1];
      const title = getTagValue(itemXml, 'title');
      const link = getLinkValue(itemXml);

      if (!title || !link) {
        return null;
      }

      return { title, link };
    })
    .filter(Boolean);
}

async function fetchSteamNews() {
  try {
    const response = await fetch(STEAM_NEWS_RSS_URL, {
      headers: {
        'user-agent': 'BroNewsBot/0.1 (+https://t.me/BroNews_bot)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      }
    });

    if (!response.ok) {
      return { ok: false, items: [] };
    }

    const xml = await response.text();
    return { ok: true, items: parseFeedItems(xml) };
  } catch {
    return { ok: false, items: [] };
  }
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
        const newsResult = await fetchSteamNews();

        if (!newsResult.ok) {
          await sendTelegramMessage(env, userChatId, 'Failed to fetch news ❌');
          return jsonResponse({ ok: true });
        }

        if (newsResult.items.length === 0) {
          await sendTelegramMessage(env, userChatId, 'No news found');
          return jsonResponse({ ok: true });
        }

        const newsList = newsResult.items
          .map((item, index) => `${index + 1}. ${item.title}\n${item.link}`)
          .join('\n\n');

        await sendTelegramMessage(env, userChatId, `Latest gaming news:\n\n${newsList}`);
      }

      return jsonResponse({ ok: true });
    }

    return new Response('AI Gaming News Bot is running');
  }
};
