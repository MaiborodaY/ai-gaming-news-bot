import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker from '../src/worker.js';
import { AI_NEWS_CRON_EXPRESSION, AI_NEWS_FALLBACK_IMAGE_URL, AI_NEWS_SOURCES, isAiNewsSlot } from '../src/ai-news.js';
import { FINANCE_CRON_EXPRESSION } from '../src/market.js';
import { CROATIA_NEWS_CRON_EXPRESSION } from '../src/croatia-news.js';

const GAMING_CRON = '0 12-16/2 * * *';
const STEAM_FEED = 'https://store.steampowered.com/feeds/news.xml';
const GEMATSU_FEED = 'https://www.gematsu.com/feed';
const XBOX_FEED = 'https://news.xbox.com/en-us/feed/';
const AI_LINK = 'https://openai.com/index/test-model';
const GAME_LINK = 'https://store.steampowered.com/news/test-game';

function rss(items) {
  return `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${items.map((item) => `<item>
    <title><![CDATA[${item.title}]]></title>
    <link>${item.link}</link>
    <pubDate>${new Date(item.publishedAt ?? Date.now()).toUTCString()}</pubDate>
    <description><![CDATA[${item.summary ?? ''}]]></description>
    ${item.content ? `<content:encoded><![CDATA[${item.content}]]></content:encoded>` : ''}
    ${item.image ? `<enclosure url="${item.image}" type="image/png" />` : ''}
  </item>`).join('')}</channel></rss>`;
}

function harness(t, options = {}) {
  const kv = new Map();
  const requests = [];
  const telegram = [];
  const openAi = [];
  const articlePages = new Map(options.articlePages ?? []);
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
    ...(options.useOpenAi ? { OPENAI_API_KEY: 'test-key' } : {}),
    ...(options.model ? { OPENAI_MODEL: options.model } : {})
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
        : Response.json({ model: options.responseModel, choices: [{ message: {
          content: options.generatedPost ?? '🤖 Новая модель\nМодель поддерживает изображения.'
        } }] });
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
    if (articlePages.has(url)) {
      const { html, status } = articlePages.get(url);
      return new Response(html, { status, headers: { 'content-type': 'text/html' } });
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

  async function sendUpdate(update) {
    return worker.fetch(new Request('https://worker.example/telegram/webhook', {
      method: 'POST',
      body: JSON.stringify(update)
    }), env);
  }

  return { env, kv, requests, telegram, openAi, run, sendUpdate };
}

function assertLinkedSource(payload, source, url) {
  const label = `Источник: ${source}`;
  const content = payload.caption ?? payload.text;
  const serializedEntities = payload.caption ? payload.caption_entities : payload.entities;
  const entities = typeof serializedEntities === 'string' ? JSON.parse(serializedEntities) : serializedEntities;
  assert.equal(content.includes(url), false);
  assert.equal(content.endsWith(label), true);
  assert.deepEqual(entities, [{
    type: 'text_link',
    offset: content.length - label.length,
    length: label.length,
    url
  }]);
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
  const generatedLink = 'https://example.test/wrong-link';
  const state = harness(t, {
    useOpenAi: true,
    generatedPost: `🤖 Новая модель\nМодель поддерживает изображения.\n\nИсточник: Другой источник\n${generatedLink}`,
    feeds: [[AI_NEWS_SOURCES[0].url, [{
      title: 'New AI model',
      link: AI_LINK,
      summary: 'The model supports image input.',
      content: '<p>This feed also includes an extended release note.</p>'
    }]]],
    articlePages: [[AI_LINK, { html: '<article><p>The model also supports speech in another release.</p></article>' }]]
  });
  await state.run('2026-07-01T10:00:00Z');

  assert.equal(state.openAi.length, 1);
  const [request] = state.openAi;
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.reasoning_effort, 'none');
  assert.equal(request.max_completion_tokens, 220);
  assert.equal(Object.hasOwn(request, 'max_tokens'), false);
  assert.match(request.messages[0].content, /искусственный интеллект/);
  assert.match(request.messages[1].content, /Описание RSS: The model supports image input\./);
  assert.doesNotMatch(request.messages[1].content, /Фрагмент статьи|supports speech|extended release note/);
  assert.equal(state.telegram[0].payload.caption, '🤖 Новая модель\nМодель поддерживает изображения.\n\nИсточник: OpenAI');
  assertLinkedSource(state.telegram[0].payload, 'OpenAI', AI_LINK);
});

test('gaming posts use the full feed content and distinct details from the article', async (t) => {
  const link = 'https://www.gematsu.com/2026/11/digimon-alysion-now-available';
  const rssDetail = 'The free-to-play Digimon card game launched on iOS and Android in 183 countries and regions.';
  const articleDetail = 'The story teaches how to use cards before players face online opponents in real time.';
  const generatedPost = '🎮 Вышла Digimon Alysion\n\nБесплатная карточная игра доступна на iOS и Android. Правила можно освоить по ходу сюжета, а затем сыграть с другими игроками в реальном времени.';
  const state = harness(t, {
    useOpenAi: true,
    model: 'gpt-4o-mini',
    generatedPost,
    feeds: [
      [STEAM_FEED, []],
      [GEMATSU_FEED, [{ title: 'Digimon Alysion now available', link,
        summary: 'Read more about the launch.', content: `<p>${rssDetail}</p>` }]]
    ],
    articlePages: [[link, { html: `<main><article><p>${articleDetail}</p></article></main>` }]]
  });
  const [result] = await state.run('2026-07-01T12:00:00Z', GAMING_CRON);

  assert.equal(result.ok, true);
  assert.equal(state.requests.filter((url) => url === link).length, 1);
  const [request] = state.openAi;
  assert.equal(request.model, 'gpt-4o-mini');
  assert.equal(Object.hasOwn(request, 'reasoning_effort'), false);
  assert.equal(request.max_completion_tokens, 320);
  assert.equal(request.temperature, 0.7);
  assert.match(request.messages[0].content, /игровые новости/);
  const prompt = request.messages[1].content;
  assert.match(prompt, /2[–-]3 коротких предложения/);
  assert.ok(prompt.includes(rssDetail));
  assert.ok(prompt.includes(articleDetail));
  assert.doesNotMatch(prompt, /Read more about the launch/);
  assert.equal(state.telegram[0].payload.text, `${generatedPost}\n\nИсточник: Gematsu`);
  assertLinkedSource(state.telegram[0].payload, 'Gematsu', link);
});

test('a headline-only gaming item stays short when the linked page has no facts', async (t) => {
  const link = 'https://news.xbox.com/en-us/2026/11/24/microsoft-flight-simulator-announces-a-marketplace-exclusive-the-inibuilds-global-jet/';
  const title = 'Microsoft Flight Simulator Announces a Marketplace Exclusive: The iniBuilds Global Jet';
  const generatedPost = '🎮 Для Microsoft Flight Simulator анонсировали iniBuilds Global Jet';
  const state = harness(t, {
    useOpenAi: true,
    generatedPost,
    feeds: [[STEAM_FEED, []], [XBOX_FEED, [{ title, link }]]],
    articlePages: [[link, { html: `<article><h1>${title}</h1></article>` }]]
  });
  const [result] = await state.run('2026-07-01T12:00:00Z', GAMING_CRON);

  assert.equal(result.ok, true);
  const [request] = state.openAi;
  assert.match(request.messages[1].content, /один факт[^.]*без повторов и общих фраз/);
  assert.ok(request.messages[1].content.includes(title));
  assert.doesNotMatch(request.messages[1].content, /Описание RSS|Фрагмент статьи/);
  assert.equal(state.telegram[0].payload.text, `${generatedPost}\n\nИсточник: Xbox Wire`);
  assertLinkedSource(state.telegram[0].payload, 'Xbox Wire', link);
});

test('AI news without an RSS summary uses the article paragraph and image from one fetch', async (t) => {
  const image = 'https://openai.com/images/model.png';
  const state = harness(t, {
    useOpenAi: true,
    feeds: [[AI_NEWS_SOURCES[0].url, [{ title: 'New AI model', link: AI_LINK }]]],
    articlePages: [[AI_LINK, {
      html: '<meta property="og:image" content="/images/model.png"><main><article><p>The model accepts ten images per request.</p></article></main>'
    }]]
  });
  const [result] = await state.run('2026-07-01T10:00:00Z');

  assert.equal(result.ok, true);
  assert.equal(state.requests.filter((url) => url === AI_LINK).length, 1);
  const [request] = state.openAi;
  assert.match(request.messages[0].content, /недоверенные данные/);
  assert.match(request.messages[1].content, /Фрагмент статьи: The model accepts ten images per request\./);
  assert.doesNotMatch(request.messages[1].content, /Описание RSS/);
  assert.equal(state.telegram[0].payload.photo, image);
  assertLinkedSource(state.telegram[0].payload, 'OpenAI', AI_LINK);
});

test('an outdated OpenAI iFood link uses the canonical article without changing its news index', async (t) => {
  const oldLink = 'https://openai.com/index/ifood';
  const newLink = 'https://openai.com/business/customer-stories/ifood/';
  const state = harness(t, {
    useOpenAi: true,
    feeds: [[AI_NEWS_SOURCES[0].url, [{ title: 'How iFood uses AI', link: oldLink }]]],
    articlePages: [
      [oldLink, { status: 404 }],
      [newLink, { html: '<article><p>iFood uses an assistant to help merchants manage delivery orders.</p></article>' }]
    ]
  });
  const [result] = await state.run('2026-07-01T10:00:00Z');

  assert.equal(result.ok, true);
  assert.deepEqual(state.requests.filter((url) => url.includes('ifood')), [oldLink, newLink]);
  assert.match(state.openAi[0].messages[1].content, /Фрагмент статьи: iFood uses an assistant to help merchants manage delivery orders\./);
  assert.equal(state.telegram[0].payload.photo, AI_NEWS_FALLBACK_IMAGE_URL);
  assertLinkedSource(state.telegram[0].payload, 'OpenAI', newLink);
  assert.equal(state.telegram[0].payload.caption.includes(oldLink), false);
  assert.equal(JSON.parse(state.kv.get('news:' + oldLink)).status, 'published');
  assert.equal(state.kv.has('news:' + newLink.replace(/\/$/, '')), false);
  const [retry] = await state.run('2026-07-01T18:00:00Z');
  assert.deepEqual(retry, { ok: true, reason: 'no_new_news' });
  assert.equal(state.telegram.length, 1);
});

test('AI news stays publishable with only its headline when the article has no useful text', async (t) => {
  const state = harness(t, {
    useOpenAi: true,
    feeds: [[AI_NEWS_SOURCES[0].url, [{ title: 'New AI model', link: AI_LINK }]]],
    articlePages: [[AI_LINK, {
      html: '<main><article><p>Read more from our latest company announcements.</p></article></main>'
    }]]
  });
  const [result] = await state.run('2026-07-01T10:00:00Z');

  assert.equal(result.ok, true);
  assert.match(state.openAi[0].messages[1].content, /Заголовок: New AI model/);
  assert.doesNotMatch(state.openAi[0].messages[1].content, /Описание RSS|Фрагмент статьи|company announcements/);
  assert.equal(state.telegram[0].payload.photo, AI_NEWS_FALLBACK_IMAGE_URL);
  assertLinkedSource(state.telegram[0].payload, 'OpenAI', AI_LINK);
});

test('/ai_test exercises GPT-6 Luna and reports the model returned by OpenAI', async (t) => {
  const responseModel = 'gpt-6-luna-2026-08-21';
  const state = harness(t, { useOpenAi: true, generatedPost: 'ok', responseModel });
  const response = await state.sendUpdate({ message: { text: '/ai_test', chat: { id: 42, type: 'private' } } });

  assert.equal(response.ok, true);
  const [request] = state.openAi;
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.reasoning_effort, 'none');
  assert.equal(request.max_completion_tokens, 10);
  assert.equal(Object.hasOwn(request, 'max_tokens'), false);
  assert.equal(state.telegram[0].payload.text, 'AI is configured ✅\nModel: ' + responseModel);
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
  assertLinkedSource(state.telegram[0].payload, 'TechCrunch AI', link);
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
  assertLinkedSource(state.telegram[0].payload, 'OpenAI', AI_LINK);
});

test('a long AI photo caption has room for its linked source', async (t) => {
  const state = harness(t, {
    useOpenAi: true,
    generatedPost: `🤖 ${'а'.repeat(978)}🤖${'б'.repeat(300)}`
  });
  await state.run('2026-07-01T10:00:00Z');

  const [{ method, payload }] = state.telegram;
  assert.equal(method, 'sendPhoto');
  assert.match(payload.caption, /^🤖 а/);
  assert.ok(payload.caption.length <= 1000);
  assert.doesNotMatch(payload.caption, /\p{Surrogate}/u);
  assertLinkedSource(payload, 'OpenAI', AI_LINK);
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
  assertLinkedSource(state.telegram.at(-1).payload, 'OpenAI', AI_LINK);
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
  assertLinkedSource(state.telegram[0].payload, 'OpenAI', AI_LINK);
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
  assertLinkedSource(state.telegram.at(-1).payload, 'OpenAI', AI_LINK);
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
  assert.equal(typeof state.telegram[1].payload.caption_entities, 'string');
  assertLinkedSource(state.telegram[1].payload, 'OpenAI', AI_LINK);
});

test('the gaming draft preview uses article context, links its source, and keeps approval buttons', async (t) => {
  const link = 'https://news.xbox.com/en-us/2026/11/25/achievements-10-million-gamerscore-interview/';
  const articleDetail = 'SiegfriedX passed 10 million Gamerscore after beating Final Fantasy VII Rebirth on its hardest difficulty.';
  const state = harness(t, {
    useOpenAi: true,
    generatedPost: '🎮 SiegfriedX первым набрал 10 млн Gamerscore\n\nПоследние очки ему принесло прохождение Final Fantasy VII Rebirth на максимальной сложности.',
    feeds: [[STEAM_FEED, []], [XBOX_FEED, [{ title: 'An interview with the first Xbox player to reach 10 million Gamerscore', link }]]],
    articlePages: [[link, { html: `<article><p>${articleDetail}</p></article>` }]]
  });
  const response = await state.sendUpdate({ message: { text: '/draft_news', chat: { id: 42, type: 'private' } } });

  assert.equal(response.ok, true);
  assert.equal(state.requests.filter((url) => url === link).length, 1);
  assert.ok(state.openAi[0].messages[1].content.includes(articleDetail));
  assert.equal(state.telegram.length, 1);
  const [{ method, payload }] = state.telegram;
  assert.equal(method, 'sendMessage');
  assert.match(payload.text, /^📝 Черновик поста\n\n🎮 SiegfriedX/);
  assertLinkedSource(payload, 'Xbox Wire', link);
  const { draftId } = JSON.parse(state.kv.get(`news:${link.replace(/\/$/, '')}`));
  assert.deepEqual(payload.reply_markup.inline_keyboard[0].map((button) => button.callback_data),
    [`publish_draft:${draftId}`, `skip_draft:${draftId}`]);
});

test('publishing a saved gaming draft replaces its old attribution with a linked source', async (t) => {
  const state = harness(t);
  const id = 'saved-draft';
  const body = '🎮 Game update\n\nВышло обновление игры.';
  state.kv.set(`draft:${id}`, JSON.stringify({
    id,
    status: 'draft',
    item: { title: 'Game update', source: 'Steam', link: GAME_LINK },
    post: `${body}\n\nИсточник: Steam\n${GAME_LINK}`
  }));
  const response = await state.sendUpdate({
    callback_query: { id: 'callback', data: `publish_draft:${id}`, message: { chat: { id: 42 } } }
  });

  assert.equal(response.ok, true);
  const [{ method, payload }] = state.telegram;
  assert.equal(method, 'sendMessage');
  assert.equal(payload.chat_id, '@BroNewsWorld');
  assert.equal(payload.text, `${body}\n\nИсточник: Steam`);
  assertLinkedSource(payload, 'Steam', GAME_LINK);
  assert.equal(JSON.parse(state.kv.get(`draft:${id}`)).status, 'published');
  assert.equal(JSON.parse(state.kv.get(`news:${GAME_LINK}`)).status, 'published');
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
