function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function parseHoldings(holdingsJson) {
  if (typeof holdingsJson !== 'string') {
    return null;
  }

  try {
    const holdings = JSON.parse(holdingsJson);
    if (!holdings || typeof holdings !== 'object' || Array.isArray(holdings)) {
      return null;
    }

    const positions = Object.entries(holdings);
    return positions.length > 0 && positions.every(([, quantity]) => isPositiveNumber(quantity))
      ? positions
      : null;
  } catch {
    return null;
  }
}

function assetsById(snapshot) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
  return new Map(assets.filter((asset) => typeof asset?.id === 'string').map((asset) => [asset.id, asset]));
}

function historicalPrice(price, changePercent) {
  if (!Number.isFinite(changePercent) || changePercent <= -100) {
    return null;
  }

  return price / (1 + changePercent / 100);
}

function totalChange(positions, referencePriceFor) {
  let change = 0;
  for (const position of positions) {
    const price = position.asset?.price;
    if (!isPositiveNumber(price)) {
      return null;
    }

    const referencePrice = referencePriceFor(position);
    if (!isPositiveNumber(referencePrice)) {
      return null;
    }

    change += position.quantity * (price - referencePrice);
  }

  return Number.isFinite(change) ? change : null;
}

export function calculatePortfolioChanges(snapshot, previousSnapshot, holdingsJson) {
  const holdings = parseHoldings(holdingsJson);
  if (!holdings) {
    return null;
  }

  const currentById = assetsById(snapshot);
  const previousById = assetsById(previousSnapshot);
  const positions = holdings.map(([id, quantity]) => ({
    quantity,
    asset: currentById.get(id),
    previousPrice: previousById.get(id)?.price
  }));

  return {
    sincePrevious: totalChange(positions, ({ previousPrice }) => previousPrice),
    change1h: totalChange(positions, ({ asset }) => historicalPrice(asset.price, asset.change1h)),
    change24h: totalChange(positions, ({ asset }) => historicalPrice(asset.price, asset.change24h)),
    change7d: totalChange(positions, ({ asset }) => historicalPrice(asset.price, asset.change7d))
  };
}
