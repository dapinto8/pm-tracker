import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookTopOf, type OrderBookSummary } from '../src/services/polymarket.js';

/**
 * Books as the CLOB returns them: bids ASCENDING, asks DESCENDING, so the best
 * quotes are the LAST element of each array.
 */
function summary(
  bids: [string, string][],
  asks: [string, string][]
): OrderBookSummary {
  return {
    market: '0xmarket',
    asset_id: '0xtoken',
    timestamp: '1785774300000',
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
  };
}

test('reads the best quotes off the END of each array', () => {
  const top = bookTopOf(
    summary(
      // ascending: 0.92 is the best bid
      [['0.88', '100'], ['0.90', '200'], ['0.92', '300']],
      // descending: 0.94 is the best ask
      [['0.99', '10'], ['0.96', '20'], ['0.94', '400']]
    )
  );
  assert.equal(top.bid, 0.92);
  assert.equal(top.ask, 0.94);
  assert.equal(top.bidSize, 300);
  assert.equal(top.askSize, 400);
  assert.ok(Math.abs(top.spread! - 0.02) < 1e-9);
});

test('empty bid side yields null, not 0', () => {
  const top = bookTopOf(summary([], [['0.99', '500']]));
  assert.equal(top.bid, null, 'an absent bid must be null so it cannot be averaged in');
  assert.equal(top.bidSize, null);
  assert.equal(top.ask, 0.99);
  assert.equal(top.askSize, 500);
  // The bug: (bid + ask) / 2 with bid coerced to 0 reported 0.495 for a market
  // that was really at 0.99. A null spread makes that impossible to compute.
  assert.equal(top.spread, null);
});

test('empty ask side yields null, not 0', () => {
  const top = bookTopOf(summary([['0.98', '750']], []));
  assert.equal(top.ask, null);
  assert.equal(top.askSize, null);
  assert.equal(top.bid, 0.98);
  assert.equal(top.bidSize, 750);
  assert.equal(top.spread, null);
});

test('both sides empty yields all nulls', () => {
  const top = bookTopOf(summary([], []));
  assert.deepEqual(top, {
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    spread: null,
  });
});

test('a genuine zero spread is preserved, not mistaken for an empty book', () => {
  // bid == ask is a real, if tight, two-sided book. Every field is a real 0 or
  // a real price - none of it may collapse to null.
  const top = bookTopOf(summary([['0.95', '120']], [['0.95', '340']]));
  assert.equal(top.bid, 0.95);
  assert.equal(top.ask, 0.95);
  assert.equal(top.spread, 0, 'a 0.000 spread is data, not a missing value');
  assert.notEqual(top.spread, null);
});

test('a genuine zero size at the top of book is preserved', () => {
  const top = bookTopOf(summary([['0.95', '0']], [['0.96', '340']]));
  assert.equal(top.bidSize, 0, 'zero size is not the same as no bid');
  assert.equal(top.bid, 0.95);
});

test('missing bids/asks arrays are treated as empty sides', () => {
  const top = bookTopOf({
    market: '0xmarket',
    asset_id: '0xtoken',
    timestamp: '1785774300000',
  } as OrderBookSummary);
  assert.equal(top.bid, null);
  assert.equal(top.ask, null);
  assert.equal(top.spread, null);
});

test('unparseable prices become null rather than NaN', () => {
  const top = bookTopOf(summary([['', '100']], [['0.94', 'oops']]));
  assert.equal(top.bid, null);
  assert.equal(top.askSize, null);
  // A null bid means the spread cannot be computed either.
  assert.equal(top.spread, null);
});
