const KRAKEN_MARKET_URL = 'https://api.kraken.com/0/public';
const HOUR_SECONDS = 60 * 60;
const WEEK_HOURS = 7 * 24;

async function fetchKrakenPair(endpoint, asset, params, fetchImpl) {
  const url = new URL(KRAKEN_MARKET_URL + '/' + endpoint);
  url.search = new URLSearchParams({
    pair: asset.krakenPair,
    ...(asset.tokenized ? { asset_class: 'tokenized_asset' } : {}),
    assetVersion: '1',
    ...params
  }).toString();

  const response = await fetchImpl(url.toString(), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Kraken ' + endpoint + ' API error: HTTP ' + response.status);
  }

  const data = await response.json();
  if (!Array.isArray(data?.error) || data.error.length > 0 || !data.result) {
    const reason = data?.error?.length ? String(data.error) : 'invalid response';
    throw new Error('Kraken ' + endpoint + ' API error: ' + reason);
  }

  const pairKey = asset.krakenPair.replace('/', '').toUpperCase();
  const pair = Object.keys(data.result).find((key) => key.replace('/', '').toUpperCase() === pairKey);
  return pair ? data.result[pair] : null;
}

function positivePrice(value) {
  const price = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function percentageChange(price, reference) {
  const previous = positivePrice(reference);
  return previous === null ? null : ((price - previous) / previous) * 100;
}

export async function fetchKrakenAsset(asset, fetchImpl = fetch) {
  const now = Date.now();
  const currentHour = Math.floor(now / (HOUR_SECONDS * 1000)) * HOUR_SECONDS;
  const [tickerResponse, historyResponse] = await Promise.allSettled([
    fetchKrakenPair('Ticker', asset, {}, fetchImpl),
    fetchKrakenPair('OHLC', asset, {
      interval: '60',
      since: String(currentHour - (WEEK_HOURS + 1) * HOUR_SECONDS)
    }, fetchImpl)
  ]);

  if (tickerResponse.status === 'rejected') {
    throw tickerResponse.reason;
  }
  const ticker = tickerResponse.value;
  const price = positivePrice(Array.isArray(ticker?.c) ? ticker.c[0] : undefined);
  if (price === null) {
    throw new Error(`Kraken response is missing ${asset.symbol} price`);
  }

  const candles = historyResponse.status === 'fulfilled' && Array.isArray(historyResponse.value)
    ? historyResponse.value : [];
  const candlesByHour = new Map(candles.filter(Array.isArray).map((candle) => [Number(candle[0]), candle]));
  const previousHour = candlesByHour.get(currentHour - HOUR_SECONDS);
  const previousDay = candlesByHour.get(currentHour - 24 * HOUR_SECONDS);
  const previousWeek = candlesByHour.get(currentHour - WEEK_HOURS * HOUR_SECONDS);

  return {
    id: asset.id,
    name: asset.name,
    symbol: asset.symbol,
    price,
    change1h: percentageChange(price, previousHour?.[4]),
    change24h: percentageChange(price, previousDay?.[1]),
    change7d: percentageChange(price, previousWeek?.[1]),
    updatedAt: new Date(now).toISOString()
  };
}
