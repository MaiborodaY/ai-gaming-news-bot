import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deduplicateNewsItems,
  formatStatsMessage,
  formatImageDebugList,
  isSupportedImageUrl,
  normalizeNewsLink,
  parsePublishedAt
} from '../src/worker.js';

test('isSupportedImageUrl accepts supported extensions', () => {
  assert.equal(isSupportedImageUrl('https://site.com/image.jpg'), true);
  assert.equal(isSupportedImageUrl('https://site.com/image.jpeg'), true);
  assert.equal(isSupportedImageUrl('https://site.com/image.png'), true);
  assert.equal(isSupportedImageUrl('https://site.com/image.webp'), true);
  assert.equal(isSupportedImageUrl('https://site.com/image.gif'), true);
  assert.equal(isSupportedImageUrl('https://site.com/image.jpg?w=1200'), true);
});

test('isSupportedImageUrl rejects unsupported and invalid values', () => {
  assert.equal(isSupportedImageUrl('https://site.com/audio.mp3'), false);
  assert.equal(isSupportedImageUrl('https://site.com/video.mp4'), false);
  assert.equal(isSupportedImageUrl(''), false);
  assert.equal(isSupportedImageUrl(null), false);
  assert.equal(isSupportedImageUrl('not-a-url'), false);
});

test('normalizeNewsLink normalizes case, hash and trailing slash', () => {
  assert.equal(normalizeNewsLink('HTTPS://Example.COM/News/Item/#Top'), 'https://example.com/news/item');
  assert.equal(normalizeNewsLink('https://example.com/path///'), 'https://example.com/path');
});

test('parsePublishedAt parses valid dates and rejects invalid', () => {
  assert.equal(parsePublishedAt('2026-05-01T12:00:00Z'), '2026-05-01T12:00:00.000Z');
  assert.equal(parsePublishedAt('not-a-date'), null);
  assert.equal(parsePublishedAt(''), null);
});

test('deduplicateNewsItems removes duplicate normalized titles and respects maxItems', () => {
  const items = [
    { title: 'Hello   World', link: 'https://a.com/1' },
    { title: 'hello world', link: 'https://a.com/2' },
    { title: 'Another News', link: 'https://a.com/3' }
  ];

  const uniqueAll = deduplicateNewsItems(items, 10);
  assert.equal(uniqueAll.length, 2);
  assert.equal(uniqueAll[0].link, 'https://a.com/1');
  assert.equal(uniqueAll[1].link, 'https://a.com/3');

  const uniqueLimited = deduplicateNewsItems(items, 1);
  assert.equal(uniqueLimited.length, 1);
  assert.equal(uniqueLimited[0].link, 'https://a.com/1');
});

test('formatImageDebugList includes source/title/image/link and candidates info', () => {
  const blocks = formatImageDebugList([
    {
      source: 'Xbox Wire',
      title: 'News A',
      imageUrl: 'https://site.com/a.jpg',
      imageCandidates: ['https://site.com/a.jpg', 'https://site.com/b.png'],
      link: 'https://site.com/post-a'
    },
    {
      source: 'Gematsu',
      title: 'News B',
      imageUrl: null,
      imageCandidates: [],
      link: 'https://site.com/post-b'
    }
  ]);

  assert.equal(Array.isArray(blocks), true);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /1\. \[Xbox Wire\] News A/);
  assert.match(blocks[0], /image: yes/);
  assert.match(blocks[0], /primary: https:\/\/site\.com\/a\.jpg/);
  assert.match(blocks[0], /candidates: 2/);
  assert.match(blocks[0], /candidate 1: https:\/\/site\.com\/a\.jpg/);
  assert.match(blocks[0], /link: https:\/\/site\.com\/post-a/);
  assert.match(blocks[1], /2\. \[Gematsu\] News B/);
  assert.match(blocks[1], /image: no/);
  assert.match(blocks[1], /link: https:\/\/site\.com\/post-b/);
});

test('formatStatsMessage renders compact stats output', () => {
  const text = formatStatsMessage({
    draftCount: 3,
    publishedCount: 12,
    skippedCount: 5,
    totalDrafts: 20,
    processedNewsIndexCount: 27,
    createdToday: 8,
    publishedToday: 4,
    skippedToday: 2,
    sourceLines: ['PlayStation Blog: 7', 'Xbox Wire: 6', 'Gematsu: 5', 'Steam: 2', 'Unknown: 0']
  });

  assert.match(text, /📊 BroNews stats/);
  assert.match(text, /Drafts: 3/);
  assert.match(text, /Published: 12/);
  assert.match(text, /Processed news index: 27/);
  assert.match(text, /Today UTC:/);
  assert.match(text, /PlayStation Blog: 7/);
});
