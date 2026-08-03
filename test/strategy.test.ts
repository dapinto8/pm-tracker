import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEntry,
  midpointOf,
  roundShares,
  settlePnl,
  type EntryThresholds,
} from '../src/services/strategy.js';
import type { BookTop } from '../src/models/types.js';

const THRESHOLDS: EntryThresholds = {
  minAsk: 0.90,
  maxAsk: 0.97,
  maxSpread: 0.03,
  shareDecimals: 2,
};

/** Build a top-of-book with a plentiful resting size unless told otherwise. */
function book(bid: number, ask: number, askSize = 100_000): BookTop {
  return { bid, ask, bidSize: askSize, askSize, spread: ask - bid };
}

// The mirror side of a favorite at ~0.94 sits at ~0.06.
const DOG = book(0.05, 0.06);

test('enters on the favorite when price, spread and size all pass', () => {
  const d = evaluateEntry({ up: book(0.93, 0.94), down: DOG, stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, true);
  assert.ok(d.enter);
  assert.equal(d.plan.side, 'UP');
  assert.equal(d.plan.entryPrice, 0.94);
  // 100 / 0.94 = 106.382..., rounded down to 2dp
  assert.equal(d.plan.shares, 106.38);
  assert.ok(Math.abs(d.plan.stakeUsd - 106.38 * 0.94) < 1e-9);
});

test('picks DOWN when DOWN is the favorite', () => {
  const d = evaluateEntry({ up: DOG, down: book(0.93, 0.94), stakeUsd: 100 }, THRESHOLDS);
  assert.ok(d.enter);
  assert.equal(d.plan.side, 'DOWN');
});

test('rejects when the favorite is too cheap (below 0.90)', () => {
  const d = evaluateEntry({ up: book(0.87, 0.89), down: book(0.11, 0.13), stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
  assert.ok(!d.enter && /outside/.test(d.reason));
});

test('rejects at the 0.97 boundary (exclusive upper bound)', () => {
  const d = evaluateEntry({ up: book(0.96, 0.97), down: DOG, stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
});

test('accepts at the 0.90 boundary (inclusive lower bound)', () => {
  const d = evaluateEntry({ up: book(0.89, 0.90), down: book(0.10, 0.11), stakeUsd: 100 }, THRESHOLDS);
  assert.ok(d.enter);
  assert.equal(d.plan.entryPrice, 0.90);
});

test('rejects when the book spread exceeds the guard', () => {
  // 0.90 / 0.94 is a 4c spread - above the ~2.6c break-even, edge is gone.
  const d = evaluateEntry({ up: book(0.90, 0.94), down: DOG, stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
  assert.ok(!d.enter && /spread/.test(d.reason));
});

test('accepts exactly at the spread guard', () => {
  const d = evaluateEntry({ up: book(0.91, 0.94), down: DOG, stakeUsd: 100 }, THRESHOLDS);
  assert.ok(d.enter);
});

test('rejects when top-of-book size cannot cover the order', () => {
  // Need 106.38 shares, only 50 resting.
  const d = evaluateEntry({ up: book(0.93, 0.94, 50), down: DOG, stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
  assert.ok(!d.enter && /ask size/.test(d.reason));
});

test('rejects when neither side is a favorite', () => {
  const d = evaluateEntry({ up: book(0.48, 0.49), down: book(0.48, 0.49), stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
  assert.ok(!d.enter && /no favorite/.test(d.reason));
});

test('rejects a book with an empty bid side (null)', () => {
  // What the final seconds of a window actually look like: nobody left bidding
  // the favorite, so bid/bidSize/spread are all null.
  const up: BookTop = { bid: null, ask: 0.94, bidSize: null, askSize: 500, spread: null };
  const d = evaluateEntry({ up, down: DOG, stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
  assert.ok(!d.enter && /up book is one-sided or empty/.test(d.reason));
});

test('rejects a book with an empty ask side (null)', () => {
  // No ask means nothing to buy, whatever the bid implies about the favorite.
  const up: BookTop = { bid: 0.93, ask: null, bidSize: 500, askSize: null, spread: null };
  const d = evaluateEntry({ up, down: DOG, stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
  assert.ok(!d.enter && /up book is one-sided or empty/.test(d.reason));
});

test('rejects when the DOG side is one-sided, even if the favorite looks fine', () => {
  const down: BookTop = { bid: null, ask: null, bidSize: null, askSize: null, spread: null };
  const d = evaluateEntry({ up: book(0.93, 0.94), down, stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
  assert.ok(!d.enter && /down book is one-sided or empty/.test(d.reason));
});

test('rejects a fully empty book on both sides', () => {
  const empty: BookTop = { bid: null, ask: null, bidSize: null, askSize: null, spread: null };
  const d = evaluateEntry({ up: empty, down: empty, stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
  assert.ok(!d.enter && /one-sided or empty/.test(d.reason));
});

test('still rejects a legacy zero-price book', () => {
  // Pre-fix callers represented an absent side as 0; that must keep being
  // rejected rather than read as a real quote.
  const up: BookTop = { bid: 0, ask: 0.94, bidSize: 0, askSize: 500, spread: 0 };
  const d = evaluateEntry({ up, down: DOG, stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
  assert.ok(!d.enter && /one-sided/.test(d.reason));
});

test('rejects when the ask size is unknown', () => {
  const up: BookTop = { bid: 0.93, ask: 0.94, bidSize: 100, askSize: null, spread: 0.01 };
  const d = evaluateEntry({ up, down: DOG, stakeUsd: 100 }, THRESHOLDS);
  assert.equal(d.enter, false);
  assert.ok(!d.enter && /ask size/.test(d.reason));
});

test('midpointOf is null when a side is missing, and exact when both are present', () => {
  assert.equal(midpointOf({ bid: null, ask: 0.99, bidSize: null, askSize: 5, spread: null }), null);
  assert.equal(midpointOf({ bid: 0.99, ask: null, bidSize: 5, askSize: null, spread: null }), null);
  assert.equal(midpointOf(book(0.93, 0.95)), 0.94);
});

test('roundShares always rounds down', () => {
  assert.equal(roundShares(106.3829, 2), 106.38);
  assert.equal(roundShares(106.3899, 2), 106.38);
  assert.equal(roundShares(0.004, 2), 0);
});

test('settlePnl pays out the winning side and loses the stake otherwise', () => {
  assert.ok(Math.abs(settlePnl(100, 0.94, true) - 6) < 1e-9);
  assert.ok(Math.abs(settlePnl(100, 0.94, false) + 94) < 1e-9);
});
