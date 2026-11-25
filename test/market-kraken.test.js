import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchAnthropicXStock } from '../src/market-kraken.js';

const NOW = '2026-11-25T20:37:00.000Z';
const CURRENT_UTC_HOUR = Date.parse('2026-11-25T20:00:00.000Z') / 1000;
const HOUR_SECONDS = 3600;

function candle(hoursAgo, open, close) {
  return [CURRENT_UTC_HOUR - hoursAgo * HOUR_SECONDS, String(open), '120', '50', String(close), String(close), '100', 3];
}

function mockKraken(t, { ticker = { 'ANTx/USD': { c: ['90', '1'], o: '104' } }, candles = [] } = {}) {
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  const requests = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    requests.push(url.pathname);
    assert.equal(url.origin, 'https://api.kraken.com');
    assert.equal(url.searchParams.get('pair'), 'ANTx/USD');
    assert.equal(url.searchParams.get('asset_class'), 'tokenized_asset');
    assert.equal(url.searchParams.get('assetVersion'), '1');
    assert.deepEqual(options.headers, { accept: 'application/json' });

    if (url.pathname === '/0/public/Ticker') {
      return Response.json({ error: [], result: ticker });
    }
    assert.equal(url.pathname, '/0/public/OHLC');
    assert.equal(url.searchParams.get('interval'), '60');
    assert.equal(Number(url.searchParams.get('since')), CURRENT_UTC_HOUR - 169 * HOUR_SECONDS);
    return Response.json({ error: [], result: { 'ANTx/USD': candles, last: CURRENT_UTC_HOUR } });
  };
  return { fetchImpl, requests };
}

test('Anthropic uses Kraken spot xStock data and exact UTC-hour change references', async (t) => {
  const state = mockKraken(t, { candles: [
    candle(168, 72, 65),
    candle(24, 80, 70),
    candle(1, 98, 100),
    candle(0, 88, 93)
  ] });

  assert.deepEqual(await fetchAnthropicXStock(state.fetchImpl), {
    id: 'antx',
    name: 'Anthropic xStock',
    symbol: 'ANTx',
    price: 90,
    change1h: -10,
    change24h: 12.5,
    change7d: 25,
    updatedAt: NOW
  });
  assert.deepEqual(state.requests.sort(), ['/0/public/OHLC', '/0/public/Ticker']);
});

test('missing Anthropic reference candles leave changes unknown', async (t) => {
  const state = mockKraken(t, { candles: [
    candle(167, 70, 73),
    candle(25, 80, 89),
    candle(2, 98, 99),
    candle(0, 90, 91)
  ] });
  const asset = await fetchAnthropicXStock(state.fetchImpl);

  assert.equal(asset.price, 90);
  assert.equal(asset.change1h, null);
  assert.equal(asset.change24h, null);
  assert.equal(asset.change7d, null);
});

test('the Anthropic spot quote remains available when its history is unavailable', async () => {
  const fetchImpl = async (input) => new URL(input).pathname === '/0/public/Ticker'
    ? Response.json({ error: [], result: { 'ANTx/USD': { c: ['90', '1'] } } })
    : new Response(null, { status: 503 });
  const asset = await fetchAnthropicXStock(fetchImpl);

  assert.equal(asset.price, 90);
  assert.equal(asset.change24h, null);
});

test('missing xStock trade price fails instead of using an OHLC or equity quote', async (t) => {
  const state = mockKraken(t, {
    ticker: { 'ANT/USD': { c: ['83', '1'] }, 'ANTx/USD': { c: ['0', '1'], o: '104' } },
    candles: [candle(0, 90, 91)]
  });

  await assert.rejects(fetchAnthropicXStock(state.fetchImpl), /missing ANTx price/);
});

test('public Kraken API errors are reported as feed errors', async () => {
  const fetchImpl = async (input) => new URL(input).pathname === '/0/public/Ticker'
    ? Response.json({ error: ['EQuery:Unknown asset pair'] })
    : Response.json({ error: [], result: { 'ANTx/USD': [] } });

  await assert.rejects(fetchAnthropicXStock(fetchImpl), /Kraken Ticker API error: EQuery:Unknown asset pair/);
});
