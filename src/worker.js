const START_COMMAND = '/start';
const START_REPLY = 'BroNews bot is alive ✅';

const TEST_CHANNEL_COMMAND = '/test_channel';
const TEST_CHANNEL_POST_TEXT = 'BroNews test post ✅';
const TEST_CHANNEL_CONFIRM_TEXT = 'Test post sent to channel ✅';

const MOCK_NEWS_COMMAND = '/mock_news';
const MOCK_NEWS_POST_TEXT = `🎮 Test gaming news\n\nThis is a test news post from BroNews bot.\n\nSource: https://example.com`;

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
      const chatId = update?.message?.chat?.id;
      const chatType = update?.message?.chat?.type;

      if (!chatId) {
        return jsonResponse({ ok: true });
      }

      if (messageText === START_COMMAND) {
        await sendTelegramMessage(env, chatId, START_REPLY);
        return jsonResponse({ ok: true });
      }

      if (messageText === TEST_CHANNEL_COMMAND && chatType === 'private') {
        if (!env.CHANNEL_ID) {
          await sendTelegramMessage(env, chatId, 'CHANNEL_ID is not configured');
          return jsonResponse({ ok: true });
        }

        await sendTelegramMessage(env, env.CHANNEL_ID, TEST_CHANNEL_POST_TEXT);
        await sendTelegramMessage(env, chatId, TEST_CHANNEL_CONFIRM_TEXT);
        return jsonResponse({ ok: true });
      }

      if (messageText === MOCK_NEWS_COMMAND && chatType === 'private') {
        if (!env.CHANNEL_ID) {
          await sendTelegramMessage(env, chatId, 'CHANNEL_ID is not configured');
          return jsonResponse({ ok: true });
        }

        try {
          await sendTelegramMessage(env, env.CHANNEL_ID, MOCK_NEWS_POST_TEXT);
          await sendTelegramMessage(env, chatId, 'Mock news sent to channel ✅');
        } catch {
          await sendTelegramMessage(env, chatId, 'Failed to send mock news ❌');
        }

        return jsonResponse({ ok: true });
      }

      return jsonResponse({ ok: true });
    }

    return new Response('AI Gaming News Bot is running');
  }
};
