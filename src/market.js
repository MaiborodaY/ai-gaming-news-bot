export const FINANCE_CRON_EXPRESSION = '0 9,10,19,20 * * *';

const COINGECKO_MARKETS_URL =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,the-open-network&price_change_percentage=1h,24h,7d';
const COINGECKO_SPCXX_URL =
  'https://api.coingecko.com/api/v3/simple/price?symbols=spcxx&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true';
const REPORT_HOURS = new Set([11, 21]);
const ZAGREB_TIME_ZONE = 'Europe/Zagreb';

const zagrebDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZAGREB_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
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
    hour: Number(parts.hour)
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

export function marketReportKey(slot) {
  return `market:report:${slot.date}:${slot.hour}`;
}

async function fetchCoinGeckoJson(url, apiKey, fetchImpl) {
  const headers = {
    accept: 'application/json',
    'user-agent': 'BroNewsBot/0.1 (+https://t.me/BroNews_bot)'
  };

  if (apiKey) {
    headers['x-cg-demo-api-key'] = apiKey;
  }

  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    const body = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`CoinGecko API error: ${response.status}${body ? ` ${body}` : ''}`);
  }

  return response.json();
}

function mapMarketAsset(markets, id, name, symbol) {
  const market = markets.find((item) => item.id === id);
  const price = asFiniteNumber(market?.current_price);
  if (price === null) {
    throw new Error(`CoinGecko response is missing ${symbol} price`);
  }

  return {
    id,
    name,
    symbol,
    price,
    change1h: asFiniteNumber(market.price_change_percentage_1h_in_currency),
    change24h: asFiniteNumber(market.price_change_percentage_24h_in_currency),
    change7d: asFiniteNumber(market.price_change_percentage_7d_in_currency),
    updatedAt: market.last_updated || null
  };
}

export async function fetchMarketSnapshot(apiKey, fetchImpl = fetch) {
  const [markets, spcxxResponse] = await Promise.all([
    fetchCoinGeckoJson(COINGECKO_MARKETS_URL, apiKey, fetchImpl),
    fetchCoinGeckoJson(COINGECKO_SPCXX_URL, apiKey, fetchImpl)
  ]);

  if (!Array.isArray(markets)) {
    throw new Error('CoinGecko markets response is invalid');
  }

  const spcxx = spcxxResponse?.spcxx;
  const spcxxPrice = asFiniteNumber(spcxx?.usd);
  if (spcxxPrice === null) {
    throw new Error('CoinGecko response is missing SPCXx price');
  }

  return {
    generatedAt: new Date().toISOString(),
    assets: [
      mapMarketAsset(markets, 'the-open-network', 'TON', 'TON'),
      mapMarketAsset(markets, 'bitcoin', 'Bitcoin', 'BTC'),
      {
        id: 'spcxx',
        name: 'SpaceX xStock',
        symbol: 'SPCXx',
        price: spcxxPrice,
        change1h: null,
        change24h: asFiniteNumber(spcxx.usd_24h_change),
        change7d: null,
        updatedAt: spcxx.last_updated_at ? new Date(spcxx.last_updated_at * 1000).toISOString() : null
      }
    ]
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

  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function getChangeSincePrevious(asset, previousSnapshot) {
  const previousAsset = previousSnapshot?.assets?.find((item) => item.id === asset.id);
  const previousPrice = asFiniteNumber(previousAsset?.price);
  if (previousPrice === null || previousPrice <= 0) {
    return null;
  }

  return ((asset.price - previousPrice) / previousPrice) * 100;
}

export function classifyMarketTrend(asset) {
  const weightedChanges = [
    [asFiniteNumber(asset.change1h), 0.4],
    [asFiniteNumber(asset.change24h), 0.45],
    [asFiniteNumber(asset.change7d), 0.15]
  ].filter(([value]) => value !== null);

  if (weightedChanges.length === 0) {
    return 'neutral';
  }

  const totalWeight = weightedChanges.reduce((sum, [, weight]) => sum + weight, 0);
  const score = weightedChanges.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;

  if (score >= 0.75) {
    return 'positive';
  }

  if (score <= -0.75) {
    return 'negative';
  }

  return 'neutral';
}

function getTrendText(trend) {
  if (trend === 'positive') {
    return {
      signal: 'положительный',
      outlook: 'рост вероятнее при сохранении текущего импульса'
    };
  }

  if (trend === 'negative') {
    return {
      signal: 'отрицательный',
      outlook: 'давление вниз может сохраниться без разворота импульса'
    };
  }

  return {
    signal: 'смешанный',
    outlook: 'вероятнее боковое движение до появления нового импульса'
  };
}

export function formatMarketReport(snapshot, previousSnapshot, slot) {
  const assetBlocks = snapshot.assets.map((asset) => {
    const trendText = getTrendText(classifyMarketTrend(asset));
    const sincePrevious = getChangeSincePrevious(asset, previousSnapshot);
    const displayName = asset.symbol === asset.name ? asset.name : `${asset.name} (${asset.symbol})`;
    const changeLines = [];

    if (Number.isFinite(asset.change1h)) {
      changeLines.push(`За 1 час: ${formatPercent(asset.change1h)}`);
    }

    changeLines.push(`За 24 часа: ${formatPercent(asset.change24h)}`);

    if (Number.isFinite(asset.change7d)) {
      changeLines.push(`За 7 дней: ${formatPercent(asset.change7d)}`);
    }

    return [
      `${displayName}: ${formatUsd(asset.price)}`,
      ...changeLines,
      `С прошлого отчёта: ${formatPercent(sincePrevious)}`,
      `Сигнал: ${trendText.signal}`,
      `Ожидание: ${trendText.outlook}`
    ].join('\n');
  });

  return [
    `📊 Рынок — ${slot.label}, Хорватия`,
    ...assetBlocks,
    'Данные: CoinGecko. SPCXx — токенизированный трекер SpaceX, а не обычная акция.',
    'Не является инвестиционной рекомендацией.'
  ].join('\n\n');
}
