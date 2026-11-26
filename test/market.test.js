import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMarketChartUrl,
  fetchMarketSnapshot,
  formatMarketReport,
  getMarketReportSlot,
  getMarketTestSlot,
  marketReportKey
} from '../src/market.js';

test('fetchMarketSnapshot maps public Bybit and Kraken prices without credentials', async () => {
  const requests = [];
  const prices = {
    GRAMUSDT: 3.5,
    BTCUSDT: 64000,
    SPCXXUSDT: 150.16,
    NVDAXUSDT: 148.25,
    GOOGLXUSDT: 268.75,
    XAUTUSDT: 3700
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === 'api.kraken.com') {
      const market = parsedUrl.pathname.endsWith('/Ticker') ? { c: ['82.5', '1'] } : [];
      return Response.json({ error: [], result: { 'ANTx/USD': market } });
    }
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
      ['spcxx', 150.16],
      ['antx', 82.5],
      ['nvdax', 148.25],
      ['googlx', 268.75],
      ['xaut', 3700]
    ]
  );
  assert.equal(snapshot.assets[0].change24h, 1.2);
  assert.ok(Math.abs(snapshot.assets[0].change1h - 1) < 0.001);
  assert.ok(Math.abs(snapshot.assets[0].change7d - 7) < 0.001);
  assert.equal(requests.length, 14);
  assert.ok(requests.some(({ url }) => new URL(url).searchParams.get('symbol') === 'NVDAXUSDT'));
  assert.ok(requests.some(({ url }) => new URL(url).searchParams.get('symbol') === 'GOOGLXUSDT'));
  assert.equal(requests.filter(({ url }) => {
    const params = new URL(url).searchParams;
    return params.get('symbol') === 'XAUTUSDT' && params.get('category') === 'spot';
  }).length, 2);
  assert.equal(requests.every(({ options }) => !options.headers.authorization), true);
  assert.equal(requests.every(({ options }) => !options.headers['x-api-key']), true);

  const partial = await fetchMarketSnapshot((url, options) =>
    new URL(url).hostname === 'api.kraken.com'
      ? new Response(null, { status: 503 })
      : fetchImpl(url, options)
  );
  assert.deepEqual(partial.unavailableAssets, ['ANTx']);
  assert.deepEqual(partial.assets.map((asset) => asset.id), ['the-open-network', 'bitcoin', 'spcxx', 'nvdax', 'googlx', 'xaut']);
  assert.match(formatMarketReport(partial, null), /Нет котировок: ANTx/);
});

test('getMarketReportSlot follows Zagreb summer and winter time', () => {
  assert.deepEqual(getMarketReportSlot('2026-07-11T19:00:00Z'), {
    date: '2026-07-11',
    hour: 21,
    label: '21:00'
  });
  assert.deepEqual(getMarketReportSlot('2026-01-11T20:00:00Z'), {
    date: '2026-01-11',
    hour: 21,
    label: '21:00'
  });
  assert.equal(getMarketReportSlot('2026-07-11T09:00:00Z'), null);
  assert.equal(getMarketReportSlot('2026-01-11T10:00:00Z'), null);
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

test('observations fall back to a period with data and treat tiny changes as flat', () => {
  const text = formatMarketReport({
    assets: [
      { id: 'nvdax', name: 'NVIDIA xStock', symbol: 'NVDAx', price: 150, change24h: null, change7d: -3 },
      { id: 'antx', name: 'Anthropic xStock', symbol: 'ANTx', price: 80, change1h: 0.001, change24h: null },
      { id: 'googlx', name: 'Alphabet xStock', symbol: 'GOOGLx', price: 250, change24h: null }
    ]
  }, null);
  assert.match(text, /Наблюдение: снижение за неделю/);
  assert.match(text, /Наблюдение: без изменений за час/);
  assert.match(text, /Наблюдение: нет данных/);
  assert.doesNotMatch(text, /100 биткойнов|Изменение портфеля/);
});

test('the market report opens with 100 BTC at the current price and ends with portfolio changes', () => {
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
        change24h: -0.91,
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

  const text = formatMarketReport(snapshot, previousSnapshot, {
    portfolioChanges: { sincePrevious: 14.2, change1h: -3.1, change24h: 0, change7d: null }
  });

  assert.match(text, /^📊 Рынок\n\nЕсли бы вы купили 100 биткойнов в 2010 году, то сейчас у вас было бы \$6,412,000\.00\./);
  assert.match(text, /💎 TON — \$3\.50/);
  assert.match(text, /1 ч: \+0\.50%/);
  assert.match(text, /7 дн\.: -2\.17%/);
  assert.match(text, /₿ Bitcoin \(BTC\) — \$64,120\.00/);
  assert.match(text, /1 ч: 0\.00% • 24 ч: \+4\.21%/);
  assert.match(text, /🚀 SpaceX xStock \(SPCXx\) — \$150\.16/);
  assert.match(text, /С прошлого выпуска: \+2\.94%/);
  assert.match(text, /Наблюдение: рост за сутки/);
  assert.match(text, /Наблюдение: снижение за сутки/);
  assert.match(text, /Изменение портфеля \(примерно\)\nС прошлого выпуска: \+\$14\.20\n1 ч: -\$3\.10 • 24 ч: \$0\.00 • 7 дн\.: нет данных$/);
  assert.doesNotMatch(text, /Хорватия|Прогноз|рекомендаци|может продолжиться/);
  assert.doesNotMatch(text, /-0\.00%/);
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
  assert.deepEqual(chart.data.datasets[0].data, [2.47, -1.23, null]);
  assert.deepEqual(chart.data.datasets[0].backgroundColor, ['#22c55e', '#ef4444', '#9ca3af']);
});
