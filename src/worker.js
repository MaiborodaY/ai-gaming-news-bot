const START_COMMAND = '/start';
const TEST_CHANNEL_COMMAND = '/test_channel';
const START_REPLY = 'BroNews bot is alive ✅';
const CHANNEL_TEST_POST = 'BroNews test post ✅';

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

        await sendTelegramMessage(env, env.CHANNEL_ID, CHANNEL_TEST_POST);
        await sendTelegramMessage(env, chatId, 'Test post sent to channel ✅');
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ ok: true });
    }

    return new Response('AI Gaming News Bot is running');
  }
};
