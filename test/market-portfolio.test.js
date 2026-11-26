import test from 'node:test';
import assert from 'node:assert/strict';

import { calculatePortfolioChanges } from '../src/market-portfolio.js';

test('portfolio changes sum the dollar movements of held assets and match prior prices by id', () => {
  const snapshot = {
    assets: [
      { id: 'spcxx', price: 120, change1h: 20, change24h: -20, change7d: 50 },
      { id: 'googlx', price: 40, change1h: -20, change24h: 25, change7d: 0 },
      { id: 'bitcoin', price: 60000, change1h: -10, change24h: 10, change7d: 20 }
    ]
  };
  const previousSnapshot = {
    assets: [
      { id: 'googlx', price: 51 },
      { id: 'spcxx', price: 100 },
      { id: 'bitcoin', price: 40000 }
    ]
  };

  assert.deepEqual(calculatePortfolioChanges(snapshot, previousSnapshot, '{"spcxx":2.5,"googlx":1.5}'), {
    sincePrevious: 33.5,
    change1h: 35,
    change24h: -63,
    change7d: 100
  });
});

test('unavailable prices for a holding leave all portfolio changes unknown', () => {
  const snapshot = { assets: [{ id: 'spcxx', price: 50, change1h: 10, change24h: 10, change7d: 10 }] };
  const previousSnapshot = { assets: [{ id: 'spcxx', price: 48 }, { id: 'antx', price: 40 }] };
  const holdings = '{"spcxx":1,"antx":3}';
  const unavailable = { sincePrevious: null, change1h: null, change24h: null, change7d: null };

  assert.deepEqual(calculatePortfolioChanges(snapshot, previousSnapshot, holdings), unavailable);
  snapshot.assets.push({ id: 'antx', price: 0, change1h: 10, change24h: 10, change7d: 10 });
  assert.deepEqual(calculatePortfolioChanges(snapshot, previousSnapshot, holdings), unavailable);
});

test('invalid historical changes and partial previous snapshots affect only their periods', () => {
  const snapshot = {
    assets: [
      { id: 'nvdax', price: 80, change1h: 0, change24h: -100, change7d: 10 },
      { id: 'xaut', price: 100, change1h: 0, change24h: 25, change7d: null }
    ]
  };
  const previousSnapshot = { assets: [{ id: 'nvdax', price: 80 }] };

  assert.deepEqual(calculatePortfolioChanges(snapshot, previousSnapshot, '{"nvdax":1,"xaut":2}'), {
    sincePrevious: null,
    change1h: 0,
    change24h: null,
    change7d: null
  });
  assert.deepEqual(calculatePortfolioChanges(snapshot, previousSnapshot, '{"nvdax":1}'), {
    sincePrevious: 0,
    change1h: 0,
    change24h: null,
    change7d: 80 - 80 / 1.1
  });
});

test('missing, malformed, empty, or invalid holdings disable the calculation', () => {
  for (const holdings of [
    undefined, null, '', '{}', '[3]', 'null', '{', '"string"', '{"antx":0}',
    '{"antx":-5}', '{"antx":"2"}', '{"antx":true}', '{"antx":1e999}', '{"antx":2,"spcxx":null}'
  ]) {
    assert.equal(calculatePortfolioChanges(null, null, holdings), null);
  }
});
