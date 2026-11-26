import { fetchAnthropicXStock } from './market-kraken.js';

// Reuse the existing morning/evening timer; publication hours are checked in the worker.
export const FINANCE_CRON_EXPRESSION = '0 9,10,19,20 * * *';

const BYBIT_API_BASE_URL = 'https://api.bybit.com/v5/market';
const MARKET_ASSETS = [
  { id: 'the-open-network', name: 'TON', symbol: 'TON', pair: 'GRAMUSDT' },
  { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', pair: 'BTCUSDT' },
  { id: 'spcxx', name: 'SpaceX xStock', symbol: 'SPCXx', pair: 'SPCXXUSDT' },
  { symbol: 'ANTx', fetchQuote: fetchAnthropicXStock },
  { id: 'nvdax', name: 'NVIDIA xStock', symbol: 'NVDAx', pair: 'NVDAXUSDT' },
  { id: 'googlx', name: 'Alphabet xStock', symbol: 'GOOGLx', pair: 'GOOGLXUSDT' },
  { id: 'xaut', name: 'Tether Gold', symbol: 'XAUT', pair: 'XAUTUSDT' }
];
const BYBIT_KLINE_LIMIT = 169;
const MARKET_ASSETS_PER_BATCH = 3;
const HOUR_MS = 60 * 60 * 1000;
const REPORT_HOURS = new Set([21]);
const ZAGREB_TIME_ZONE = 'Europe/Zagreb';

const zagrebDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZAGREB_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getZagrebDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = Object.fromEntries(
    zagrebDateTimeFormatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

export function getMarketReportSlot(value) {
  const zagrebTime = getZagrebDateTime(value);
  if (!zagrebTime || !REPORT_HOURS.has(zagrebTime.hour)) {
    return null;
  }

  return {
    date: zagrebTime.date,
    hour: zagrebTime.hour,
    label: `${String(zagrebTime.hour).padStart(2, '0')}:00`
  };
}

export function getMarketTestSlot(value) {
  const zagrebTime = getZagrebDateTime(value);
  if (!zagrebTime) {
    return null;
  }

  return {
    date: zagrebTime.date,
    hour: zagrebTime.hour,
    label: `${String(zagrebTime.hour).padStart(2, '0')}:${String(zagrebTime.minute).padStart(2, '0')}`
  };
}

export function marketReportKey(slot) {
  return `market:report:${slot.date}:${slot.hour}`;
}

async function fetchBybitJson(path, params, fetchImpl) {
  const url = new URL(`${BYBIT_API_BASE_URL}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  // These endpoints expose public market data and do not require credentials.
  const response = await fetchImpl(url.toString(), {
    signal: AbortSignal.timeout(8000),
    headers: {
      accept: 'application/json',
      'user-agent': 'BroNewsBot/0.1 (+https://t.me/BroNews_bot)'
    }
  });
  if (!response.ok) {
    const body = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Bybit API error: ${response.status}${body ? ` ${body}` : ''}`);
  }

  const data = await response.json();
  if (data?.retCode !== 0) {
    throw new Error(`Bybit API error: ${data?.retMsg || 'invalid response'}`);
  }

  return data;
}

function percentageChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return null;
  }

  return ((current - previous) / previous) * 100;
}

async function fetchBybitAsset(asset, fetchImpl) {
  const [tickerResponse, klineResponse] = await Promise.allSettled([
    fetchBybitJson('tickers', { category: 'spot', symbol: asset.pair }, fetchImpl),
    fetchBybitJson(
      'kline',
      { category: 'spot', symbol: asset.pair, interval: '60', limit: BYBIT_KLINE_LIMIT },
      fetchImpl
    )
  ]);

  if (tickerResponse.status === 'rejected') {
    throw tickerResponse.reason;
  }
  if (klineResponse.status === 'rejected') {
    throw klineResponse.reason;
  }

  const ticker = tickerResponse.value?.result?.list?.[0];
  const price = asFiniteNumber(ticker?.lastPrice);
  if (price === null || price <= 0) {
    throw new Error(`Bybit response is missing ${asset.symbol} price`);
  }

  const candles = klineResponse.value?.result?.list;
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error(`Bybit response is missing ${asset.symbol} candles`);
  }

  const previousHourClose = asFiniteNumber(candles[1]?.[4]);
  const newestCandleTime = asFiniteNumber(candles[0]?.[0]);
  const oldestCandleTime = asFiniteNumber(candles.at(-1)?.[0]);
  const hasFullWeek =
    newestCandleTime !== null && oldestCandleTime !== null && newestCandleTime - oldestCandleTime >= 167 * HOUR_MS;
  const weekReferencePrice = hasFullWeek ? asFiniteNumber(candles.at(-1)?.[1]) : null;
  const change24hFraction = asFiniteNumber(ticker.price24hPcnt);

  return {
    id: asset.id,
    name: asset.name,
    symbol: asset.symbol,
    price,
    change1h: percentageChange(price, previousHourClose),
    change24h: change24hFraction === null ? null : change24hFraction * 100,
    change7d: percentageChange(price, weekReferencePrice),
    updatedAt: new Date().toISOString()
  };
}

export async function fetchMarketSnapshot(fetchImpl = fetch) {
  const assets = [];
  const unavailableAssets = [];
  let firstError;

  // Workers allow six simultaneous outgoing connections, and each quote uses two requests.
  for (let start = 0; start < MARKET_ASSETS.length; start += MARKET_ASSETS_PER_BATCH) {
    const batch = MARKET_ASSETS.slice(start, start + MARKET_ASSETS_PER_BATCH);
    const quotes = await Promise.allSettled(batch.map((asset) =>
      asset.fetchQuote ? asset.fetchQuote(fetchImpl) : fetchBybitAsset(asset, fetchImpl)
    ));

    for (const [index, quote] of quotes.entries()) {
      if (quote.status === 'fulfilled') {
        assets.push(quote.value);
      } else {
        firstError ??= quote.reason;
        unavailableAssets.push(batch[index].symbol);
      }
    }
  }

  if (assets.length === 0) {
    throw firstError ?? new Error('No market quotes available');
  }

  return {
    generatedAt: new Date().toISOString(),
    assets,
    ...(unavailableAssets.length ? { unavailableAssets } : {})
  };
}

function formatUsd(value) {
  const maximumFractionDigits = value >= 10 ? 2 : 3;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits })}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return 'нет данных';
  }

  const roundedValue = Math.abs(value) < 0.005 ? 0 : value;
  const sign = roundedValue > 0 ? '+' : '';
  return `${sign}${roundedValue.toFixed(2)}%`;
}

function getChangeSincePrevious(asset, previousSnapshot) {
  const previousAsset = previousSnapshot?.assets?.find((item) => item.id === asset.id);
  const previousPrice = asFiniteNumber(previousAsset?.price);
  if (previousPrice === null || previousPrice <= 0) {
    return null;
  }

  return ((asset.price - previousPrice) / previousPrice) * 100;
}

function formatMarketObservation(asset) {
  const reading = [
    ['сутки', asset.change24h],
    ['неделю', asset.change7d],
    ['час', asset.change1h]
  ].find(([, change]) => Number.isFinite(change));

  if (!reading) {
    return 'нет данных';
  }

  const [period, change] = reading;
  if (Math.abs(change) < 0.005) {
    return `без изменений за ${period}`;
  }
  return `${change > 0 ? 'рост' : 'снижение'} за ${period}`;
}

function formatSignedUsd(value) {
  return Number.isFinite(value)
    ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD', signDisplay: 'exceptZero' })
    : 'нет данных';
}

export function buildMarketChartUrl(snapshot) {
  const values = snapshot.assets.map((asset) =>
    Number.isFinite(asset.change24h) ? Number(asset.change24h.toFixed(2)) : null
  );
  const chart = {
    type: 'bar',
    data: {
      labels: snapshot.assets.map((asset) => asset.symbol),
      datasets: [
        {
          data: values,
          backgroundColor: values.map((value) => value === null ? '#9ca3af' : value >= 0 ? '#22c55e' : '#ef4444'),
          borderWidth: 0,
          borderRadius: 8
        }
      ]
    },
    options: {
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: 'Изменение цены за 24 часа, %',
          color: '#f9fafb',
          font: { size: 28, weight: 'bold' }
        }
      },
      scales: {
        x: {
          ticks: { color: '#f9fafb', font: { size: 20, weight: 'bold' } },
          grid: { display: false }
        },
        y: {
          ticks: { color: '#d1d5db', font: { size: 16 } },
          grid: { color: '#374151' },
          title: { display: true, text: '%', color: '#d1d5db', font: { size: 16 } }
        }
      }
    }
  };
  const url = new URL('https://quickchart.io/chart');
  url.searchParams.set('width', '1200');
  url.searchParams.set('height', '630');
  url.searchParams.set('devicePixelRatio', '1');
  url.searchParams.set('format', 'png');
  url.searchParams.set('backgroundColor', '#111827');
  url.searchParams.set('version', '4');
  url.searchParams.set('c', JSON.stringify(chart));
  return url.toString();
}

export function formatMarketReport(snapshot, previousSnapshot, { compact = false, portfolioChanges } = {}) {
  const assetEmojis = {
    'the-open-network': '💎',
    bitcoin: '₿',
    spcxx: '🚀',
    antx: '🤖',
    nvdax: '🎮',
    googlx: '🔎'
  };
  const bitcoin = snapshot.assets.find((asset) => asset.id === 'bitcoin');
  const bitcoinIntro = bitcoin
    ? `Если бы вы купили 100 биткойнов в 2010 году, то сейчас у вас было бы ${formatUsd(bitcoin.price * 100)}.`
    : '';
  const assetBlocks = snapshot.assets.filter((asset) => asset.id !== 'xaut').map((asset) => {
    const sincePrevious = getChangeSincePrevious(asset, previousSnapshot);
    const name = compact ? asset.name.replace(/ xStock$/, '') : asset.name;
    const displayName = asset.symbol === name ? name : `${name} (${asset.symbol})`;
    const changes = [
      Number.isFinite(asset.change1h) ? `1 ч: ${formatPercent(asset.change1h)}` : null,
      `24 ч: ${formatPercent(asset.change24h)}`,
      Number.isFinite(asset.change7d) ? `7 дн.: ${formatPercent(asset.change7d)}` : null,
      compact ? `с выпуска: ${formatPercent(sincePrevious)}` : null
    ].filter(Boolean);

    return [
      `${assetEmojis[asset.id] || '📌'} ${displayName} — ${formatUsd(asset.price)}`,
      changes.join(' • '),
      compact ? null : `С прошлого выпуска: ${formatPercent(sincePrevious)}`,
      `Наблюдение: ${formatMarketObservation(asset)}`
    ].filter(Boolean).join('\n');
  });

  const portfolioBlock = portfolioChanges ? [
    '💼 Изменение портфеля (примерно)',
    `С прошлого выпуска: ${formatSignedUsd(portfolioChanges.sincePrevious)}`,
    `1 ч: ${formatSignedUsd(portfolioChanges.change1h)} • 24 ч: ${formatSignedUsd(portfolioChanges.change24h)} • 7 дн.: ${formatSignedUsd(portfolioChanges.change7d)}`
  ].join('\n') : '';

  return [
    '📊 Рынок',
    bitcoinIntro,
    ...assetBlocks,
    ...(snapshot.unavailableAssets?.length ? [`Нет котировок: ${snapshot.unavailableAssets.join(', ')}.`] : []),
    portfolioBlock
  ].filter(Boolean).join('\n\n');
}
