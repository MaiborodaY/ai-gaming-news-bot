import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker from '../src/worker.js';
import { AI_NEWS_CRON_EXPRESSION, AI_NEWS_FALLBACK_IMAGE_URL, AI_NEWS_SOURCES, isAiNewsSlot } from '../src/ai-news.js';
import { FINANCE_CRON_EXPRESSION } from '../src/market.js';
import { CROATIA_NEWS_CRON_EXPRESSION } from '../src/croatia-news.js';

const GAMING_CRON = '0 12-16/2 * * *';
const STEAM_FEED = 'https://store.steampowered.com/feeds/news.xml';
const AI_LINK = 'https://openai.com/index/test-model';
const GAME_LINK = 'https://store.steampowered.com/news/test-game';

function rss(items) {
  return `<rss><channel>${items.map((item) => `<item>
    <title><![CDATA[${item.title}]]></title>
    <link>${item.link}</link>
    <pubDate>${new Date(item.publishedAt ?? Date.now()).toUTCString()}</pubDate>
    <description><![CDATA[${item.summary ?? ''}]]></description>
    ${item.image ? `<enclosure url="${item.image}" type="image/png" />` : ''}
  </item>`).join('')}</channel></rss>`;
}

function harness(t, options = {}) {
  const kv = new Map();
  const requests = [];
  const telegram = [];
  const openAi = [];
  t.mock.method(console, 'info', () => {});
  const feeds = new Map([
    [AI_NEWS_SOURCES[0].url, [{ title: 'New AI model', link: AI_LINK, summary: 'The model supports image input.', image: options.image }]],
    [STEAM_FEED, [{ title: 'Game update', link: GAME_LINK }]],
    ...(options.feeds ?? [])
  ]);
  const env = {
    CHANNEL_ID: '@BroNewsWorld',
    TELEGRAM_BOT_TOKEN: 'test-token',
    DRAFTS: {
      async get(key) { return kv.get(key) ?? null; },
      async put(key, value) { kv.set(key, value); }
    },
    ...(options.useOpenAi ? { OPENAI_API_KEY: 'test-key' } : {})
  };

  // Keep all scheduled publication tests offline, including article and image requests.
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (options.failedFeeds?.includes(url)) {
      throw new Error('Feed unavailable');
    }
    if (options.httpFailedFeeds?.includes(url)) {
      return new Response('Unavailable', { status: 503 });
    }
    if (AI_NEWS_SOURCES.some((source) => source.url === url) || url === STEAM_FEED || /feed|rss/.test(url)) {
      return new Response(rss(feeds.get(url) ?? []));
    }
    if (url === 'https://api.openai.com/v1/chat/completions') {
      openAi.push(JSON.parse(init.body));
      return options.openAiFails
        ? new Response('Unavailable', { status: 503 })
        : Response.json({ choices: [{ message: { content: '🤖 Новая модель\nМодель поддерживает изображения.' } }] });
    }
    if (url.startsWith('https://api.telegram.org/')) {
      const method = url.split('/').at(-1);
      const payload = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body);
      telegram.push({ method, payload });
      const rejectPhoto = method === 'sendPhoto' && (options.photoFails || options.failedPhotoUrls?.includes(payload.photo));
      return rejectPhoto ? new Response('Image rejected', { status: 400 })
        : Response.json({ ok: true, result: { message_id: telegram.length } });
    }
    if (url === AI_NEWS_FALLBACK_IMAGE_URL) {
      return new Response(readFileSync(new URL('../public/images/ai-news-illustration.png', import.meta.url)), { headers: { 'content-type': 'image/png' } });
    }
    if (url === options.image) {
      return new Response('Unavailable', { status: 503 });
    }
    if ([...feeds.values()].flat().some((item) => item.link === url)) {
      return new Response('', { status: options.articleStatus ?? 200 });
    }
    assert.fail(`Unexpected request: ${url}`);
  });

  async function run(scheduledTime, cron = AI_NEWS_CRON_EXPRESSION) {
    const pending = [];
    await worker.scheduled({ cron, scheduledTime: Date.parse(scheduledTime) }, env, {
      waitUntil(promise) { pending.push(promise); }
    });
    return Promise.all(pending);
  }

  return { env, kv, requests, telegram, openAi, run };
}

for (const { date, offset } of [
  { date: '2026-07-01', offset: 2 },
  { date: '2026-12-01', offset: 1 },
  { date: '2026-03-28', offset: 1 },
  { date: '2026-03-29', offset: 2 },
  { date: '2026-10-24', offset: 2 },
  { date: '2026-10-25', offset: 1 }
]) {
  for (const localHour of [12, 20]) {
    const hour = localHour - offset;
    test(`AI news publishes at ${localHour}:00 Zagreb on ${date}`, async (t) => {
      const state = harness(t);
      const timestamp = `${date}T${hour}:00:00Z`;
      assert.equal(isAiNewsSlot(timestamp), true);
      const [result] = await state.run(timestamp);

      assert.equal(result.ok, true);
      assert.equal(result.source, 'OpenAI');
      assert.equal(state.telegram.length, 1);
      assert.equal(state.telegram[0].payload.chat_id, '@BroNewsWorld');
      assert.equal(state.telegram[0].method, 'sendPhoto');
      assert.equal(state.telegram[0].payload.photo, AI_NEWS_FALLBACK_IMAGE_URL);
      assert.match(state.telegram[0].payload.caption, /^🤖/);
      assert.match(state.telegram[0].payload.caption, /новость из мира ИИ/);
      assert.equal(state.requests.includes(STEAM_FEED), false);
      for (const source of AI_NEWS_SOURCES) {
        assert.equal(state.requests.includes(source.url), true);
      }
      assert.equal(JSON.parse(state.kv.get(`news:${AI_LINK}`)).status, 'published');
    });
  }
  for (const hour of [12, 14, 16]) {
    test(`middle slot keeps gaming news on ${date} at ${hour}:00 UTC`, async (t) => {
      const state = harness(t);
      const timestamp = `${date}T${hour}:00:00Z`;
      const [result] = await state.run(timestamp, GAMING_CRON);

      assert.equal(result.ok, true);
      assert.equal(result.source, 'Steam');
      assert.equal(state.telegram.length, 1);
      assert.match(state.telegram[0].payload.text, /^🎮 Game update/);
      assert.match(state.telegram[0].payload.text, /игровая новость от Steam/);
      assert.equal(state.requests.filter((url) => AI_NEWS_SOURCES.some((source) => source.url === url)).length, 0);
      assert.equal(JSON.parse(state.kv.get(`news:${GAME_LINK}`)).status, 'published');
    });
  }
  for (const hour of [10, 11, 18, 19].filter((hour) => hour !== 12 - offset && hour !== 20 - offset)) {
    test(`unused UTC offset does not publish AI news on ${date} at ${hour}:00 UTC`, async (t) => {
      const state = harness(t);
      const timestamp = `${date}T${hour}:00:00Z`;
      assert.equal(isAiNewsSlot(timestamp), false);
      assert.deepEqual(await state.run(timestamp), []);
      assert.equal(state.requests.length, 0);
      assert.equal(state.telegram.length, 0);
    });
  }
}

test('AI schedule rejects invalid times and matches the deployed cron configuration', () => {
  assert.equal(isAiNewsSlot('invalid'), false);
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.ok(config.includes(`"${AI_NEWS_CRON_EXPRESSION}"`));
  assert.ok(config.includes(`"${GAMING_CRON}"`));
  assert.equal(config.includes('"0 10-18/2 * * *"'), false);
});

test('AI post uses its RSS summary and Russian AI prompt with source attribution', async (t) => {
  const state = harness(t, { useOpenAi: true });
  await state.run('2026-07-01T10:00:00Z');

  assert.equal(state.openAi.length, 1);
  assert.match(state.openAi[0].messages[0].content, /новости искусственного интеллекта/);
  assert.match(state.openAi[0].messages[1].content, /Описание RSS: The model supports image input\./);
  assert.match(state.telegram[0].payload.caption, /Источник: OpenAI/);
  assert.match(state.telegram[0].payload.caption, /https:\/\/openai.com\/index\/test-model/);
});

test('gaming post keeps its existing AI prompt without an AI-news summary', async (t) => {
  const state = harness(t, { useOpenAi: true });
  await state.run('2026-07-01T12:00:00Z', GAMING_CRON);

  assert.match(state.openAi[0].messages[0].content, /про игровые новости/);
  assert.doesNotMatch(state.openAi[0].messages[1].content, /Описание RSS/);
  assert.match(state.telegram[0].payload.text, /Источник: Steam/);
});

test('processed AI links are skipped at the next slot without posting gaming news', async (t) => {
  const state = harness(t);
  await state.run('2026-07-01T10:00:00Z');
  const [result] = await state.run('2026-07-01T18:00:00Z');

  assert.deepEqual(result, { ok: true, reason: 'no_new_news' });
  assert.equal(state.telegram.length, 1);
  assert.equal(state.requests.includes(STEAM_FEED), false);
});

test('an AI source failure and blocked article page still allow publication from another source', async (t) => {
  const link = 'https://techcrunch.com/test-ai-news';
  const state = harness(t, {
    failedFeeds: [AI_NEWS_SOURCES[0].url],
    httpFailedFeeds: [AI_NEWS_SOURCES[1].url],
    articleStatus: 403,
    feeds: [[AI_NEWS_SOURCES[3].url, [{ title: 'Another AI story', link }]]]
  });
  const [result] = await state.run('2026-07-01T10:00:00Z');

  assert.equal(result.ok, true);
  assert.equal(result.source, 'TechCrunch AI');
  assert.equal(state.telegram[0].method, 'sendPhoto');
  assert.equal(state.telegram[0].payload.photo, AI_NEWS_FALLBACK_IMAGE_URL);
  assert.match(state.telegram[0].payload.caption, /Источник: TechCrunch AI/);
});

test('stale AI news is skipped without falling back to the gaming feed', async (t) => {
  const state = harness(t, {
    feeds: [[AI_NEWS_SOURCES[0].url, [{ title: 'Old AI story', link: AI_LINK, publishedAt: Date.now() - 4 * 86400000 }]]]
  });
  const [result] = await state.run('2026-07-01T10:00:00Z');

  assert.deepEqual(result, { ok: true, reason: 'no_new_news' });
  assert.equal(state.telegram.length, 0);
  assert.equal(state.requests.includes(STEAM_FEED), false);
});

test('AI news is sent as a photo when an RSS image is available', async (t) => {
  const image = 'https://images.example/ai.png';
  const state = harness(t, { image });
  const [result] = await state.run('2026-07-01T10:00:00Z');

  assert.equal(result.ok, true);
  assert.equal(state.telegram.length, 1);
  assert.equal(state.telegram[0].method, 'sendPhoto');
  assert.equal(state.telegram[0].payload.photo, image);
  assert.match(state.telegram[0].payload.caption, /^🤖/);
});

test('OpenAI and image failures retain the text-only AI publication fallback', async (t) => {
  const state = harness(t, {
    useOpenAi: true, openAiFails: true, photoFails: true, image: 'https://images.example/ai.png'
  });
  const [result] = await state.run('2026-07-01T18:00:00Z');

  assert.equal(result.ok, true);
  assert.equal(state.telegram.at(-1).method, 'sendMessage');
  assert.ok(state.telegram.slice(0, -1).every(post => post.method === 'sendPhoto'));
  assert.match(state.telegram.at(-1).payload.text, /^🤖/);
  const draftId = JSON.parse(state.kv.get(`news:${AI_LINK}`)).draftId;
  assert.equal(JSON.parse(state.kv.get(`draft:${draftId}`)).imageDelivery.mode, 'text');
  assert.equal(JSON.parse(state.kv.get(`news:${AI_LINK}`)).status, 'published');
});

test('BroPro cron invocations do not enter the AI or gaming flow', async (t) => {
  const state = harness(t);
  for (const cron of [FINANCE_CRON_EXPRESSION, CROATIA_NEWS_CRON_EXPRESSION]) {
    await state.run('2026-07-01T10:00:00Z', cron);
  }

  assert.equal(state.requests.length, 0);
  assert.equal(state.telegram.length, 0);
});


test('an OpenAI RSS item and blocked article still publish with the owned AI illustration', async (t) => {
  const state = harness(t, { articleStatus: 403 });
  const [result] = await state.run('2026-07-01T10:00:00Z');
  assert.equal(result.ok, true);
  assert.equal(state.telegram.length, 1);
  assert.equal(state.telegram[0].method, 'sendPhoto');
  assert.equal(state.telegram[0].payload.photo, AI_NEWS_FALLBACK_IMAGE_URL);
  assert.match(state.telegram[0].payload.caption, /openai.com\/index\/test-model/);
  const draftId = JSON.parse(state.kv.get(`news:${AI_LINK}`)).draftId;
  assert.deepEqual(JSON.parse(state.kv.get(`draft:${draftId}`)).imageDelivery,
    { mode: 'photo', imageUrl: AI_NEWS_FALLBACK_IMAGE_URL, error: null });
});

test('a rejected original photo falls back to the AI illustration without replacing the news', async (t) => {
  const image = 'https://images.example/ai.png';
  const state = harness(t, { image, failedPhotoUrls: [image] });
  const [result] = await state.run('2026-07-01T10:00:00Z');
  assert.equal(result.ok, true);
  assert.equal(state.telegram[0].payload.photo, image);
  assert.equal(state.telegram.at(-1).payload.photo, AI_NEWS_FALLBACK_IMAGE_URL);
  assert.match(state.telegram.at(-1).payload.caption, /openai.com\/index\/test-model/);
  assert.ok(state.telegram.every(post => post.method === 'sendPhoto'));
});

test('Telegram can receive illustration bytes when its URL fetch fails', async (t) => {
  const state = harness(t, { failedPhotoUrls: [AI_NEWS_FALLBACK_IMAGE_URL] });
  const [result] = await state.run('2026-07-01T10:00:00Z');
  assert.equal(result.ok, true);
  assert.equal(state.telegram.length, 2);
  assert.equal(state.telegram[1].method, 'sendPhoto');
  assert.equal(state.telegram[1].payload.photo.type, 'image/png');
  assert.ok(state.telegram[1].payload.photo.size > 0);
  assert.equal(state.telegram[1].payload.chat_id, '@BroNewsWorld');
  assert.match(state.telegram[1].payload.caption, /openai.com\/index\/test-model/);
});

test('the fallback illustration is a valid Telegram-sized PNG included in static assets', () => {
  const png = readFileSync(new URL('../public/images/ai-news-illustration.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(width > 0 && height > 0 && width + height <= 10000);
  assert.ok(Math.max(width, height) / Math.min(width, height) <= 20);
  assert.ok(png.length <= 10 * 1024 * 1024);
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /\[assets\][\s\S]*directory = "\.\/public"/);
  assert.equal(new URL(AI_NEWS_FALLBACK_IMAGE_URL).pathname, '/images/ai-news-illustration.png');
});
