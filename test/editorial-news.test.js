import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker, { runEditorialNewsPost } from '../src/worker.js';
import { FINANCE_CRON_EXPRESSION } from '../src/market.js';
import { CROATIA_NEWS_CRON_EXPRESSION, getZagrebDateTime } from '../src/croatia-news.js';
import {
  WORLD_NEWS_SOURCES,
  createWorldNewsTelegramOptions,
  formatWorldNewsPost,
  getWorldNewsSlot,
  isOfficialWorldNewsLink,
  worldNewsItemKey,
  worldNewsSlotKey
} from '../src/world-news.js';

const NATIONAL_FEED = 'https://feed.hrt.hr/vijesti/hrvatska.xml';
const RIJEKA_FEED = 'https://feed.hrt.hr/rijeka/latest.xml';
const CITY_FEED = 'https://www.rijeka.hr/feed/';
const WORLD_LINK = 'https://www.bbc.com/news/articles/world-story';
const BROPRO_CRONS = [FINANCE_CRON_EXPRESSION, CROATIA_NEWS_CRON_EXPRESSION];
// Taken from actual Cloudflare invocations after the failed October 5 release.
const LIVE_BROPRO_CRONS = ['0 9,10,19,20 * * *', '0 8,9,14,15,17,18 * * *'];

function feed(items, referenceTime) {
  return `<rss><channel>${items.map((item) => `<item>
    <title><![CDATA[${item.title}]]></title><link>${item.link}</link>
    <pubDate>${new Date(item.publishedAt ?? Date.parse(referenceTime) - 3600000).toUTCString()}</pubDate>
    <description><![CDATA[${item.summary ?? 'Facts from the news source.'}]]></description>
  </item>`).join('')}</channel></rss>`;
}

function harness(t, referenceTime, options = {}) {
  t.mock.method(Date, 'now', () => Date.parse(referenceTime));
  const kv = new Map();
  const requests = [];
  const ai = [];
  const publications = [];
  const logs = [];
  const feeds = new Map([
    [NATIONAL_FEED, [{ title: 'National decision', link: 'https://vijesti.hrt.hr/hrvatska/national-story' }]],
    [RIJEKA_FEED, [
      { title: 'Rijeka transport', link: 'https://radio.hrt.hr/radio-rijeka/vijesti/transport' },
      { title: 'Rijeka city event', link: 'https://radio.hrt.hr/radio-rijeka/vijesti/event' }
    ]],
    [CITY_FEED, [{ title: 'Rijeka roads', link: 'https://www.rijeka.hr/roads/' }]],
    [WORLD_NEWS_SOURCES[0].url, [{ title: 'World story', link: WORLD_LINK }]],
    [WORLD_NEWS_SOURCES[1].url, []],
    ...(options.feeds ?? [])
  ]);
  const env = {
    CHANNEL_ID: '@BroNewsWorld', FINANCE_CHANNEL_ID: '@BroProNews',
    TELEGRAM_BOT_TOKEN: 'test-token', OPENAI_API_KEY: 'test-key',
    DRAFTS: {
      async get(key) { return kv.get(key) ?? null; },
      async put(key, value) {
        if (options.failWorldMetadata && key.startsWith('world-news:') && JSON.parse(value).status === 'published') {
          throw new Error('Metadata write failed');
        }
        kv.set(key, value);
      },
      async delete(key) { kv.delete(key); }
    }
  };
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  t.mock.method(console, 'info', (...args) => logs.push(args));
  // All publication, market, and AI requests stay inside the test harness.
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (options.failedFeeds?.includes(url)) {
      throw new Error('Feed unavailable');
    }
    if (feeds.has(url)) {
      return new Response(feed(feeds.get(url), referenceTime));
    }
    if (url === 'https://api.openai.com/v1/chat/completions') {
      const body = JSON.parse(init.body);
      const scope = body.response_format.json_schema.name === 'world_news_selection' ? 'world'
        : body.messages[0].content.includes('именно о городе Риека') ? 'rijeka' : 'national';
      ai.push({ scope, body });
      if (options.failAiScope === scope) {
        return new Response('AI unavailable', { status: 503 });
      }
      const selection = options.worldSelection && scope === 'world' ? options.worldSelection
        : options.skipNational && scope === 'national' ? { selected: false, index: 0, headline: '', summary: '' }
          : { selected: true, index: scope === 'world' ? options.worldIndex ?? 1 : 1,
            headline: `Главная новость: ${scope}`, summary: 'Короткий пересказ с фактами источника.' };
      return Response.json({ choices: [{ message: { content: JSON.stringify(selection) } }] });
    }
    if (url.startsWith('https://api.telegram.org/')) {
      const payload = JSON.parse(init.body);
      const failed = options.failWorldTelegram && payload.text?.startsWith('🌍');
      publications.push({ method: url.split('/').at(-1), payload, failed });
      return failed ? new Response('Telegram unavailable', { status: 502 })
        : Response.json({ ok: true, result: { message_id: publications.length } });
    }
    if (url.startsWith('https://api.bybit.com/v5/market/')) {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/tickers')) {
        return Response.json({ retCode: 0, result: { list: [{ lastPrice: '100', price24hPcnt: '0.01' }] } });
      }
      const candles = Array.from({ length: 169 }, (_, index) => [
        String(Date.parse(referenceTime) - index * 3600000), '100', '100', '100', '100', '1', '100'
      ]);
      return Response.json({ retCode: 0, result: { list: candles } });
    }
    assert.fail(`Unexpected request: ${url}`);
  });

  async function invoke(timestamp, crons = BROPRO_CRONS) {
    const pending = [];
    for (const cron of crons) {
      await worker.scheduled({ cron, scheduledTime: Date.parse(timestamp) }, env, {
        waitUntil(promise) { pending.push(promise); }
      });
    }
    return Promise.allSettled(pending);
  }
  async function run(timestamp, crons) {
    const results = await invoke(timestamp, crons);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }
  function accepted() { return publications.filter((post) => !post.failed); }
  async function runWorld(timestamp) {
    const result = await runEditorialNewsPost(env, Date.parse(timestamp), { scope: 'world' });
    if (!result.ok) throw new Error(result.reason);
    return result;
  }
  return { kv, requests, ai, publications, logs, invoke, run, runWorld, accepted };
}

for (const { date, offset } of [
  { date: '2026-07-01', offset: 2 }, { date: '2026-12-01', offset: 1 },
  { date: '2026-03-28', offset: 1 }, { date: '2026-03-29', offset: 2 },
  { date: '2026-10-24', offset: 2 }, { date: '2026-10-25', offset: 1 }
]) {
  test(`BroPro cron configuration produces exactly the requested daily posts on ${date}`, async (t) => {
    const morning = `${date}T${String(11 - offset).padStart(2, '0')}:00:00Z`;
    const state = harness(t, morning);
    const actual = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const timestamp = `${date}T${String(hour).padStart(2, '0')}:00:00Z`;
      const crons = BROPRO_CRONS.filter((cron) => cron.split(' ')[1].split(',').map(Number).includes(hour));
      const before = state.accepted().length;
      await state.run(timestamp, crons);
      actual.push(...state.accepted().slice(before).map((post) => ({
        hour: getZagrebDateTime(timestamp).hour,
        icon: (post.payload.text || post.payload.caption).split(' ')[0],
        channel: post.payload.chat_id
      })));
    }
    assert.deepEqual(actual.sort((a, b) => a.hour - b.hour || a.icon.localeCompare(b.icon)), [
      { hour: 11, icon: '🌍', channel: '@BroProNews' },
      { hour: 11, icon: '🌊', channel: '@BroProNews' },
      { hour: 16, icon: '🌊', channel: '@BroProNews' },
      { hour: 19, icon: '🇭🇷', channel: '@BroProNews' },
      { hour: 21, icon: '📊', channel: '@BroProNews' }
    ].sort((a, b) => a.hour - b.hour || a.icon.localeCompare(b.icon)));
    const rijeka = state.accepted().filter((post) => post.payload.text?.startsWith('🌊'));
    assert.notEqual(rijeka[0].payload.text, rijeka[1].payload.text);
    assert.equal(state.ai.filter((request) => request.scope === 'world').length, 1);
  });
}

test('BroPro configuration retains the timers seen in production and shares the morning trigger', () => {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  for (const cron of BROPRO_CRONS) assert.ok(config.includes(`"${cron}"`));
  assert.deepEqual(BROPRO_CRONS, LIVE_BROPRO_CRONS);
  assert.equal(config.includes('"0 9,10 * * *"'), false);
  assert.equal(getWorldNewsSlot('invalid'), null);
  assert.equal(getWorldNewsSlot('2026-07-01T08:00:00Z'), null);
});

test('morning world and Rijeka slots have separate keys and cannot publish twice', async (t) => {
  const time = '2026-07-01T09:00:00Z';
  const state = harness(t, time);
  await state.run(time);
  await state.run(time);
  assert.equal(state.accepted().length, 2);
  assert.equal(JSON.parse(state.kv.get('world-news:slot:2026-07-01:11')).scope, 'world');
  assert.equal(JSON.parse(state.kv.get('croatia-news:slot:2026-07-01:11')).scope, 'rijeka');
  assert.equal(state.ai.length, 2);
});

test('world edition uses the AI-selected story rather than the first RSS item', async (t) => {
  const time = '2026-07-01T09:00:00Z';
  const selectedLink = 'https://www.bbc.com/news/articles/international-treaty';
  const state = harness(t, time, { worldIndex: 2, feeds: [[WORLD_NEWS_SOURCES[0].url, [
    { title: 'Local exhibition', link: WORLD_LINK },
    { title: 'International treaty', link: selectedLink }
  ]]] });
  await state.runWorld(time);
  const post = state.accepted()[0].payload;
  assert.match(post.text, /international-treaty/);
  assert.match(post.text, /Источник: BBC World/);
  assert.equal(post.parse_mode, 'HTML');
  assert.equal(post.link_preview_options.prefer_large_media, true);
  assert.equal(post.link_preview_options.show_above_text, true);
  assert.equal(state.ai[0].body.response_format.json_schema.schema.properties.index.minimum, 1);
  assert.deepEqual(state.ai[0].body.response_format.json_schema.schema.properties.selected.enum, [true]);
  assert.match(state.ai[0].body.messages[0].content, /без ограничения тематики/);
  assert.match(state.ai[0].body.messages[0].content, /международную значимость/);
});

test('world source failure falls back to the other publisher', async (t) => {
  const time = '2026-07-01T09:00:00Z';
  const state = harness(t, time, { failedFeeds: [WORLD_NEWS_SOURCES[0].url],
    feeds: [[WORLD_NEWS_SOURCES[1].url, [{ title: 'World alternative', link: 'https://www.france24.com/en/world-story' }]]] });
  await state.runWorld(time);
  assert.equal(state.accepted().length, 1);
  assert.match(state.accepted()[0].payload.text, /Источник: France 24/);
});

test('failed world publication does not block Rijeka and releases only world reservations', async (t) => {
  const time = '2026-07-01T09:00:00Z';
  const state = harness(t, time, { failWorldTelegram: true });
  const results = await state.invoke(time);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(state.accepted().length, 1);
  assert.match(state.accepted()[0].payload.text, /^🌊/);
  assert.equal(state.kv.has('world-news:slot:2026-07-01:11'), false);
  assert.equal(state.kv.has(worldNewsItemKey(WORLD_LINK)), false);
  assert.equal(JSON.parse(state.kv.get('croatia-news:slot:2026-07-01:11')).status, 'published');
});

test('failed Rijeka AI selection does not block the world edition', async (t) => {
  const time = '2026-07-01T09:00:00Z';
  const state = harness(t, time, { failAiScope: 'rijeka' });
  const results = await state.invoke(time);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(state.accepted().length, 1);
  assert.match(state.accepted()[0].payload.text, /^🌍/);
});

test('world metadata failure keeps the publication reservation to prevent a duplicate', async (t) => {
  const time = '2026-07-01T09:00:00Z';
  const state = harness(t, time, { failWorldMetadata: true });
  await state.runWorld(time);
  await state.runWorld(time);
  assert.equal(state.accepted().length, 1);
  assert.equal(JSON.parse(state.kv.get('world-news:slot:2026-07-01:11')).status, 'publishing');
  assert.equal(JSON.parse(state.kv.get(worldNewsItemKey(WORLD_LINK))).status, 'publishing');
});

test('invalid AI selection cannot reserve or publish a world story', async (t) => {
  const time = '2026-07-01T09:00:00Z';
  const state = harness(t, time, {
    worldSelection: { selected: true, index: 99, headline: 'Title', summary: 'Summary' }
  });
  await assert.rejects(state.runWorld(time), /invalid news selection/);
  assert.equal(state.accepted().length, 0);
  assert.equal(state.kv.size, 0);
});

test('stale, unsafe, and already processed world stories are excluded before AI selection', async (t) => {
  const time = '2026-07-01T09:00:00Z';
  const state = harness(t, time, { feeds: [[WORLD_NEWS_SOURCES[0].url, [
    { title: 'Old story', link: 'https://www.bbc.com/news/articles/old', publishedAt: Date.parse(time) - 25 * 3600000 },
    { title: 'Unsafe story', link: 'https://bbc.com.example.net/story' },
    { title: 'Already sent', link: `${WORLD_LINK}?tracking=rss` }
  ]]] });
  state.kv.set(worldNewsItemKey(WORLD_LINK), JSON.stringify({ status: 'published' }));
  await state.runWorld(time);
  assert.equal(state.ai.length, 0);
  assert.equal(state.accepted().length, 0);
});

test('national edition retains its existing skip behavior when no significant story exists', async (t) => {
  const time = '2026-07-01T17:00:00Z';
  const state = harness(t, time, { skipNational: true });
  await state.run(time, [CROATIA_NEWS_CRON_EXPRESSION]);
  assert.equal(state.ai[0].scope, 'national');
  assert.equal(state.accepted().length, 0);
  assert.equal(state.kv.size, 0);
});

test('world links, keys, and HTML formatting retain source attribution safely', () => {
  assert.equal(isOfficialWorldNewsLink(WORLD_LINK), true);
  assert.equal(isOfficialWorldNewsLink('https://www.bbc.co.uk/news/articles/story'), true);
  assert.equal(isOfficialWorldNewsLink('https://www.france24.com/en/story'), true);
  for (const link of ['http://www.bbc.com/news/story', 'https://bbc.com.evil.test/story', 'invalid']) {
    assert.equal(isOfficialWorldNewsLink(link), false);
    assert.equal(worldNewsItemKey(link), null);
    assert.equal(createWorldNewsTelegramOptions(link), null);
  }
  assert.equal(worldNewsItemKey(`${WORLD_LINK}/?at_campaign=rss#top`), `world-news:item:${WORLD_LINK}`);
  assert.equal(worldNewsSlotKey({ date: '2026-07-01', hour: 11 }), 'world-news:slot:2026-07-01:11');
  assert.equal(worldNewsSlotKey({ date: '2026-07-01', hour: 19 }), null);
  const selection = { selected: true, headline: 'A & B <news>', summary: 'A statement, according to the source.' };
  const post = formatWorldNewsPost(selection, { link: WORLD_LINK, source: 'BBC World' });
  assert.match(post, /^🌍 /);
  assert.match(post, /A &amp; B &lt;news&gt;/);
  assert.match(post, /Источник: BBC World<\/a>$/);
  assert.equal(formatWorldNewsPost(selection, { link: 'https://evil.test/story' }), null);
});

for (const { date, offset } of [
  { date: '2026-10-06', offset: 2 }, { date: '2026-12-01', offset: 1 }
]) {
  test(`actual Cloudflare timers publish both morning editions on ${date}`, async (t) => {
    const time = `${date}T${String(11 - offset).padStart(2, '0')}:00:00Z`;
    const state = harness(t, time);
    const utcHour = 11 - offset;
    const crons = LIVE_BROPRO_CRONS.filter(cron => cron.split(' ')[1].split(',').map(Number).includes(utcHour));
    await state.run(time, crons);
    assert.deepEqual(state.accepted().map(p => p.payload.text.split(' ')[0]).sort(), ['🌊', '🌍']);
    assert.equal(state.requests.some(url => url.includes('api.bybit.com')), false);
    assert.equal(state.logs.filter(([message, result]) => message === 'Scheduled editorial news result' && result.reason === 'published').length, 2);
  });
}

test('actual evening timers publish Croatia and market instead of silently returning', async (t) => {
  const state = harness(t, '2026-10-06T17:00:00Z');
  await state.run('2026-10-06T17:00:00Z', [LIVE_BROPRO_CRONS[1]]);
  await state.run('2026-10-06T19:00:00Z', [LIVE_BROPRO_CRONS[0]]);
  assert.equal(state.accepted().length, 2);
  assert.match(state.accepted()[0].payload.text, /^🇭🇷/);
  assert.match(state.accepted()[1].payload.caption, /^📊/);
  assert.ok(state.logs.some(([message, result]) => message === 'Scheduled market report result' && result.reason === 'published'));
});

test('an unknown cron is an explicit failure and cannot silently report success', async (t) => {
  const state = harness(t, '2026-10-06T09:00:00Z');
  await assert.rejects(state.run('2026-10-06T09:00:00Z', ['0 9,10 * * *']), /Unrecognized scheduled cron/);
  assert.equal(state.requests.length, 0);
});
