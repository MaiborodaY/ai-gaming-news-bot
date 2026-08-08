import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanCroatiaFeedText,
  croatiaNewsItemKey,
  croatiaNewsSlotKey,
  formatCroatiaNewsPost,
  getCroatiaNewsSlot,
  getCroatiaNewsTestSlot,
  isFreshCroatiaNews,
  isOfficialHrtLink,
  normalizeCroatiaNewsLink,
  parseCroatiaNewsSelection
} from '../src/croatia-news.js';
import { parseFeedItems } from '../src/worker.js';

test('getCroatiaNewsSlot follows Zagreb summer and winter time', () => {
  const summerSlots = [
    ['2026-07-11T08:00:00Z', 10],
    ['2026-07-11T11:00:00Z', 13],
    ['2026-07-11T14:00:00Z', 16],
    ['2026-07-11T17:00:00Z', 19]
  ];
  const winterSlots = [
    ['2026-01-11T09:00:00Z', 10],
    ['2026-01-11T12:00:00Z', 13],
    ['2026-01-11T15:00:00Z', 16],
    ['2026-01-11T18:00:00Z', 19]
  ];

  for (const [timestamp, hour] of [...summerSlots, ...winterSlots]) {
    assert.deepEqual(getCroatiaNewsSlot(timestamp), {
      date: timestamp.slice(0, 10),
      hour,
      label: `${hour}:00`
    });
  }

  assert.equal(getCroatiaNewsSlot('2026-07-11T09:00:00Z'), null);
  assert.equal(getCroatiaNewsSlot('2026-07-11T19:00:00Z'), null);
});

test('getCroatiaNewsTestSlot keeps the current Zagreb minutes', () => {
  assert.deepEqual(getCroatiaNewsTestSlot('2026-07-11T10:34:00Z'), {
    date: '2026-07-11',
    hour: 12,
    label: '12:34'
  });
});

test('HRT URL validation accepts only official HTTPS hosts', () => {
  assert.equal(isOfficialHrtLink('https://vijesti.hrt.hr/hrvatska/test-123'), true);
  assert.equal(isOfficialHrtLink('https://hrt.hr/vijesti/test'), true);
  assert.equal(isOfficialHrtLink('http://vijesti.hrt.hr/hrvatska/test'), false);
  assert.equal(isOfficialHrtLink('https://hrt.hr.example.com/test'), false);
  assert.equal(isOfficialHrtLink('not a url'), false);
});

test('normalizeCroatiaNewsLink removes query, hash and trailing slash', () => {
  assert.equal(
    normalizeCroatiaNewsLink('https://vijesti.hrt.hr/hrvatska/test-123/?utm_source=rss#section'),
    'https://vijesti.hrt.hr/hrvatska/test-123'
  );
  assert.equal(normalizeCroatiaNewsLink('https://example.com/test'), '');
});

test('isFreshCroatiaNews enforces publication date and maximum age', () => {
  const now = '2026-07-11T18:00:00Z';
  assert.equal(isFreshCroatiaNews({ publishedAt: '2026-07-11T01:00:00Z' }, now, 18), true);
  assert.equal(isFreshCroatiaNews({ publishedAt: '2026-07-10T23:59:59Z' }, now, 18), false);
  assert.equal(isFreshCroatiaNews({ publishedAt: null }, now, 18), false);
});

test('cleanCroatiaFeedText converts RSS HTML into compact plain text', () => {
  const input = '<![CDATA[<p>Prva &amp; važna vijest.</p><script>ignore()</script><p>Drugi red&nbsp;teksta.</p>]]>';
  assert.equal(cleanCroatiaFeedText(input), 'Prva & važna vijest. Drugi red teksta.');
});

test('parseFeedItems reads the HRT description only when requested', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <rss><channel><item>
      <link>https://vijesti.hrt.hr/hrvatska/vazna-vijest-123</link>
      <title>Važna vijest</title>
      <description><![CDATA[<p>Prvi red.</p><p>Drugi red.</p>]]></description>
    </item></channel></rss>`;

  const [croatiaItem] = parseFeedItems(xml, 'HRT', { includeSummary: true });
  const [regularItem] = parseFeedItems(xml, 'HRT');

  assert.equal(croatiaItem.summary, 'Prvi red. Drugi red.');
  assert.equal(Object.hasOwn(regularItem, 'summary'), false);
});

test('parseCroatiaNewsSelection validates index and cleans generated text', () => {
  const selected = parseCroatiaNewsSelection(
    JSON.stringify({
      selected: true,
      index: 2,
      headline: '**Важное решение правительства**',
      summary: 'Первая строка.\nВторая строка.'
    }),
    3
  );

  assert.deepEqual(selected, {
    selected: true,
    index: 2,
    headline: 'Важное решение правительства',
    summary: 'Первая строка. Вторая строка.'
  });
  assert.deepEqual(
    parseCroatiaNewsSelection('{"selected":false,"index":0,"headline":"","summary":""}', 3),
    { selected: false }
  );
  assert.equal(
    parseCroatiaNewsSelection('{"selected":true,"index":4,"headline":"x","summary":"y"}', 3),
    null
  );
});

test('formatCroatiaNewsPost keeps HRT attribution and one summary paragraph', () => {
  const link = 'https://vijesti.hrt.hr/hrvatska/test-123';
  const post = formatCroatiaNewsPost(
    {
      selected: true,
      headline: 'В Хорватии приняли важное решение',
      summary: 'Изменение вступит в силу завтра.\nОно касается всей страны.'
    },
    { link }
  );

  assert.equal(
    post,
    `🇭🇷 В Хорватии приняли важное решение\n\nИсточник: HRT\n${link}\n\nИзменение вступит в силу завтра. Оно касается всей страны.`
  );
  assert.ok(post.indexOf(link) < post.indexOf('Изменение'));
  assert.ok(post.length < 1000);
});

test('Croatian news KV keys are separate and stable', () => {
  assert.equal(
    croatiaNewsItemKey('https://vijesti.hrt.hr/hrvatska/test-123/?ref=rss'),
    'croatia-news:item:https://vijesti.hrt.hr/hrvatska/test-123'
  );
  assert.equal(
    croatiaNewsSlotKey({ date: '2026-07-11', hour: 13 }),
    'croatia-news:slot:2026-07-11:13'
  );
});
