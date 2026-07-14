import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMarketChartUrl,
  classifyMarketTrend,
  fetchMarketSnapshot,
  formatMarketReport,
  getMarketReportSlot,
  getMarketTestSlot,
  marketReportKey
} from '../src/market.js';

test('fetchMarketSnapshot maps public Bybit ticker and candle responses without credentials', async () => {
  const requests = [];
  const prices = {
    GRAMUSDT: 3.5,
    BTCUSDT: 64000,
    SPCXXUSDT: 150.16
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const parsedUrl = new URL(url);
    const pair = parsedUrl.searchParams.get('symbol');
    const price = prices[pair];

    if (parsedUrl.pathname.endsWith('/tickers')) {
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: 'OK',
          result: { list: [{ symbol: pair, lastPrice: String(price), price24hPcnt: '0.012' }] }
        }),
        { status: 200 }
      );
    }

    const newestCandleTime = 1784052000000;
    const candles = Array.from({ length: 169 }, (_, index) => [
      String(newestCandleTime - index * 60 * 60 * 1000),
      String(price),
      String(price),
      String(price),
      String(price),
      '1',
      String(price)
    ]);
    candles[1][4] = String(price / 1.01);
    candles.at(-1)[1] = String(price / 1.07);

    return new Response(
      JSON.stringify({
        retCode: 0,
        retMsg: 'OK',
        result: { list: candles }
      }),
      { status: 200 }
    );
  };

  const snapshot = await fetchMarketSnapshot(fetchImpl);

  assert.deepEqual(
    snapshot.assets.map((asset) => [asset.id, asset.price]),
    [
      ['the-open-network', 3.5],
      ['bitcoin', 64000],
      ['spcxx', 150.16]
    ]
  );
  assert.equal(snapshot.assets[0].change24h, 1.2);
  assert.ok(Math.abs(snapshot.assets[0].change1h - 1) < 0.001);
  assert.ok(Math.abs(snapshot.assets[0].change7d - 7) < 0.001);
  assert.equal(requests.length, 6);
  assert.equal(requests.every(({ options }) => !options.headers.authorization), true);
  assert.equal(requests.every(({ options }) => !options.headers['x-api-key']), true);
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

test('getMarketTestSlot uses the current Zagreb time without scheduled-hour filtering', () => {
  assert.deepEqual(getMarketTestSlot('2026-07-11T10:34:00Z'), {
    date: '2026-07-11',
    hour: 12,
    label: '12:34'
  });
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

test('formatMarketReport uses clear trend wording, prices and disclaimer', () => {
  const snapshot = {
    assets: [
      {
        id: 'the-open-network',
        name: 'TON',
        symbol: 'TON',
        price: 3.5,
        change1h: 0.5,
        change24h: 2.59,
        change7d: -2.17
      },
      {
        id: 'bitcoin',
        name: 'Bitcoin',
        symbol: 'BTC',
        price: 64120,
        change1h: -0.001,
        change24h: 4.21,
        change7d: 0.64
      },
      {
        id: 'spcxx',
        name: 'SpaceX xStock',
        symbol: 'SPCXx',
        price: 150.16,
        change1h: 0.11,
        change24h: 0.91,
        change7d: -8.78
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

  assert.match(text, /11:00 \(Хорватия\)/);
  assert.match(text, /💎 TON — \$3\.50/);
  assert.match(text, /1 ч: \+0\.50%/);
  assert.match(text, /7 дн\.: -2\.17%/);
  assert.match(text, /₿ Bitcoin \(BTC\) — \$64,120\.00/);
  assert.match(text, /1 ч: 0\.00% • 24 ч: \+4\.21%/);
  assert.match(text, /🚀 SpaceX xStock \(SPCXx\) — \$150\.16/);
  assert.match(text, /С прошлого выпуска: \+2\.94%/);
  assert.match(text, /📈 Прогноз: За сутки цена выросла, но недельный минус ещё не отыгран/);
  assert.match(text, /📈 Прогноз: За сутки цена заметно выросла/);
  assert.match(text, /📉 Прогноз: За сутки цена немного восстановилась/);
  assert.doesNotMatch(text, /Сигнал|смешанный|импульс|🔮|публичный Bybit API|токенизированный/);
  assert.doesNotMatch(text, /-0\.00%/);
  assert.match(text, /Не является инвестиционной рекомендацией/);
  assert.ok(text.length <= 1000);
});

test('buildMarketChartUrl creates a public chart without credentials', () => {
  const snapshot = {
    assets: [
      { symbol: 'TON', change24h: 2.47 },
      { symbol: 'BTC', change24h: -1.23 },
      { symbol: 'SPCXx', change24h: null }
    ]
  };

  const url = new URL(buildMarketChartUrl(snapshot));
  const chart = JSON.parse(url.searchParams.get('c'));

  assert.equal(url.origin, 'https://quickchart.io');
  assert.equal(url.searchParams.get('format'), 'png');
  assert.equal(url.searchParams.has('key'), false);
  assert.deepEqual(chart.data.labels, ['TON', 'BTC', 'SPCXx']);
  assert.deepEqual(chart.data.datasets[0].data, [2.47, -1.23, 0]);
  assert.deepEqual(chart.data.datasets[0].backgroundColor, ['#22c55e', '#ef4444', '#22c55e']);
});
