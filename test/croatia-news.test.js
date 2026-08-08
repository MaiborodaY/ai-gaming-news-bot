import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanCroatiaFeedText,
  createCroatiaNewsTelegramOptions,
  croatiaNewsItemKey,
  croatiaNewsSlotKey,
  escapeTelegramHtml,
  formatCroatiaNewsPost,
  getCroatiaNewsSlot,
  getCroatiaNewsTestSlot,
  isFreshCroatiaNews,
  isOfficialCroatiaNewsLink,
  isOfficialHrtLink,
  isRijekaNewsSlot,
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

test('16:00 Zagreb slot is reserved for the daily Rijeka post', () => {
  assert.equal(isRijekaNewsSlot({ hour: 16 }), true);
  assert.equal(isRijekaNewsSlot({ hour: 13 }), false);
  assert.equal(isRijekaNewsSlot(null), false);
});

test('HRT URL validation accepts only official HTTPS hosts', () => {
  assert.equal(isOfficialHrtLink('https://vijesti.hrt.hr/hrvatska/test-123'), true);
  assert.equal(isOfficialHrtLink('https://hrt.hr/vijesti/test'), true);
  assert.equal(isOfficialHrtLink('http://vijesti.hrt.hr/hrvatska/test'), false);
  assert.equal(isOfficialHrtLink('https://hrt.hr.example.com/test'), false);
  assert.equal(isOfficialHrtLink('not a url'), false);
});

test('Croatian news URL validation also accepts the official Rijeka city portal', () => {
  assert.equal(isOfficialCroatiaNewsLink('https://www.rijeka.hr/vazna-vijest/'), true);
  assert.equal(isOfficialCroatiaNewsLink('https://data.rijeka.hr/test'), true);
  assert.equal(isOfficialCroatiaNewsLink('http://www.rijeka.hr/test'), false);
  assert.equal(isOfficialCroatiaNewsLink('https://rijeka.hr.example.com/test'), false);
});

test('normalizeCroatiaNewsLink removes query, hash and trailing slash', () => {
  assert.equal(
    normalizeCroatiaNewsLink('https://vijesti.hrt.hr/hrvatska/test-123/?utm_source=rss#section'),
    'https://vijesti.hrt.hr/hrvatska/test-123'
  );
  assert.equal(normalizeCroatiaNewsLink('https://example.com/test'), '');
  assert.equal(
    normalizeCroatiaNewsLink('https://www.rijeka.hr/vijest/?ref=rss#program'),
    'https://www.rijeka.hr/vijest'
  );
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
  assert.equal(
    cleanCroatiaFeedText('Važna gradska vijest. Post Važna gradska vijest je prvi puta viđen na Grad Rijeka .'),
    'Važna gradska vijest.'
  );
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

test('escapeTelegramHtml protects generated text and link attributes', () => {
  assert.equal(escapeTelegramHtml('A & B <test> "quote"'), 'A &amp; B &lt;test&gt; &quot;quote&quot;');
});

test('formatCroatiaNewsPost uses linked headline and bottom source attribution', () => {
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
    `🇭🇷 <a href="${link}">В Хорватии приняли важное решение</a>\n\nИзменение вступит в силу завтра. Оно касается всей страны.\n\n<a href="${link}">Источник: HRT</a>`
  );
  assert.ok(post.indexOf(link) < post.indexOf('Изменение'));
  assert.ok(post.lastIndexOf('Источник: HRT') > post.indexOf('Изменение'));
  assert.equal(post.includes(`\n${link}`), false);
  assert.ok(post.length < 1000);
});

test('formatCroatiaNewsPost marks Rijeka posts and escapes AI text', () => {
  const link = 'https://www.rijeka.hr/vijest/';
  const post = formatCroatiaNewsPost(
    {
      selected: true,
      headline: 'Риека: дороги & транспорт',
      summary: 'Работы пройдут на участке <центра>.'
    },
    { link, source: 'Grad Rijeka' },
    { isRijeka: true }
  );

  assert.match(post, /^🌊 /);
  assert.match(post, /дороги &amp; транспорт/);
  assert.match(post, /&lt;центра&gt;/);
  assert.match(post, /Источник: Grad Rijeka/);
});

test('createCroatiaNewsTelegramOptions enables a large preview above the post', () => {
  const link = 'https://radio.hrt.hr/radio-rijeka/vijesti/test-123';
  assert.deepEqual(createCroatiaNewsTelegramOptions(link), {
    parse_mode: 'HTML',
    link_preview_options: {
      is_disabled: false,
      url: link,
      prefer_large_media: true,
      show_above_text: true
    }
  });
  assert.equal(createCroatiaNewsTelegramOptions('https://example.com/test'), null);
});

test('Croatian news KV keys are separate and stable', () => {
  assert.equal(
    croatiaNewsItemKey('https://vijesti.hrt.hr/hrvatska/test-123/?ref=rss'),
    'croatia-news:item:https://vijesti.hrt.hr/hrvatska/test-123'
  );
  assert.equal(
    croatiaNewsItemKey('https://www.rijeka.hr/vijest/?ref=rss'),
    'croatia-news:item:https://www.rijeka.hr/vijest'
  );
  assert.equal(
    croatiaNewsSlotKey({ date: '2026-07-11', hour: 13 }),
    'croatia-news:slot:2026-07-11:13'
  );
});
