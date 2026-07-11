import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMarketTrend,
  fetchMarketSnapshot,
  formatMarketReport,
  getMarketReportSlot,
  marketReportKey
} from '../src/market.js';

test('fetchMarketSnapshot maps CoinGecko market and SPCXx responses', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });

    if (url.includes('/coins/markets')) {
      return new Response(
        JSON.stringify([
          {
            id: 'bitcoin',
            current_price: 64000,
            price_change_percentage_1h_in_currency: 0.1,
            price_change_percentage_24h_in_currency: 1.2,
            price_change_percentage_7d_in_currency: 3.4,
            last_updated: '2026-07-11T09:00:00Z'
          },
          {
            id: 'the-open-network',
            current_price: 3.5,
            price_change_percentage_1h_in_currency: -0.2,
            price_change_percentage_24h_in_currency: 0.8,
            price_change_percentage_7d_in_currency: -1.1,
            last_updated: '2026-07-11T09:00:00Z'
          }
        ]),
        { status: 200 }
      );
    }

    return new Response(
      JSON.stringify({
        spcxx: {
          usd: 150.16,
          usd_24h_change: -0.5,
          last_updated_at: 1783760400
        }
      }),
      { status: 200 }
    );
  };

  const snapshot = await fetchMarketSnapshot('demo-key', fetchImpl);

  assert.deepEqual(
    snapshot.assets.map((asset) => [asset.id, asset.price]),
    [
      ['the-open-network', 3.5],
      ['bitcoin', 64000],
      ['spcxx', 150.16]
    ]
  );
  assert.equal(snapshot.assets[2].change1h, null);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers['x-cg-demo-api-key'], 'demo-key');
});

test('getMarketReportSlot follows Zagreb summer and winter time', () => {
  assert.deepEqual(getMarketReportSlot('2026-07-11T09:00:00Z'), {
    date: '2026-07-11',
    hour: 11,
    label: '11:00'
  });
  assert.deepEqual(getMarketReportSlot('2026-07-11T19:00:00Z'), {
    date: '2026-07-11',
    hour: 21,
    label: '21:00'
  });
  assert.deepEqual(getMarketReportSlot('2026-01-11T10:00:00Z'), {
    date: '2026-01-11',
    hour: 11,
    label: '11:00'
  });
  assert.equal(getMarketReportSlot('2026-07-11T10:00:00Z'), null);
});

test('marketReportKey creates one idempotency key per report slot', () => {
  assert.equal(
    marketReportKey({ date: '2026-07-11', hour: 21 }),
    'market:report:2026-07-11:21'
  );
});

test('classifyMarketTrend classifies positive, negative and neutral momentum', () => {
  assert.equal(classifyMarketTrend({ change1h: 1, change24h: 2, change7d: 4 }), 'positive');
  assert.equal(classifyMarketTrend({ change1h: -1, change24h: -2, change7d: -4 }), 'negative');
  assert.equal(classifyMarketTrend({ change1h: 0.1, change24h: -0.1, change7d: 0.2 }), 'neutral');
  assert.equal(classifyMarketTrend({ change1h: null, change24h: 1, change7d: null }), 'positive');
});

test('formatMarketReport includes prices, previous change and disclaimer', () => {
  const snapshot = {
    assets: [
      {
        id: 'the-open-network',
        name: 'TON',
        symbol: 'TON',
        price: 3.5,
        change1h: 0.5,
        change24h: 2,
        change7d: 4
      },
      {
        id: 'bitcoin',
        name: 'Bitcoin',
        symbol: 'BTC',
        price: 64120,
        change1h: -0.1,
        change24h: -1.2,
        change7d: 1
      },
      {
        id: 'spcxx',
        name: 'SpaceX xStock',
        symbol: 'SPCXx',
        price: 150.16,
        change1h: null,
        change24h: 0.1,
        change7d: null
      }
    ]
  };
  const previousSnapshot = {
    assets: [
      { id: 'the-open-network', price: 3.4 },
      { id: 'bitcoin', price: 65000 },
      { id: 'spcxx', price: 150 }
    ]
  };

  const text = formatMarketReport(snapshot, previousSnapshot, { label: '11:00' });

  assert.match(text, /11:00, Хорватия/);
  assert.match(text, /TON: \$3\.50/);
  assert.match(text, /За 1 час: \+0\.50%/);
  assert.match(text, /За 7 дней: \+4\.00%/);
  assert.match(text, /Bitcoin \(BTC\): \$64,120\.00/);
  assert.match(text, /SpaceX xStock \(SPCXx\): \$150\.16/);
  assert.match(text, /С прошлого отчёта: \+2\.94%/);
  assert.match(text, /SPCXx — токенизированный трекер SpaceX/);
  assert.match(text, /Не является инвестиционной рекомендацией/);
});
