import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageService } from '../src/services/storage.js';
import type { Trade, TrackedMarket, Snapshot, TradeTapeEntry } from '../src/models/types.js';

const DAY = '2026-08-03';
const AT = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function market(id: string, over: Partial<TrackedMarket> = {}): TrackedMarket {
  const now = AT('12:00');
  return {
    id,
    conditionId: `cond-${id}`,
    tokenIdUp: 'up',
    tokenIdDown: 'down',
    asset: 'BTC',
    question: 'q',
    eventStartTime: now,
    windowStart: now,
    windowEnd: now,
    durationMinutes: 5,
    outcome: null,
    slug: `slug-${id}`,
    seriesSlug: 'btc-up-or-down-5m',
    tapeFetchedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** A market that resolved `hoursAgo` ago, so the tape backlog can see it. */
function resolvedMarket(id: string, hoursAgo: number): TrackedMarket {
  const end = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  return market(id, { outcome: 'UP', windowStart: end, windowEnd: end, eventStartTime: end });
}

let tapeSeq = 0;
function tapeEntry(over: Partial<TradeTapeEntry> = {}): TradeTapeEntry {
  tapeSeq += 1;
  return {
    marketId: 'm1',
    tokenSide: 'UP',
    price: 0.62,
    size: 150,
    takerSide: 'BUY',
    tradedAt: AT('12:01'),
    externalId: `0xtx${tapeSeq}:token-up:150:0.62`,
    ...over,
  };
}

let seq = 0;
function trade(over: Partial<Trade> = {}): Trade {
  seq += 1;
  return {
    id: `t${seq}`,
    mode: 'live',
    marketId: 'm1',
    side: 'UP',
    entryPrice: 0.94,
    spreadAtEntry: 0.01,
    askSizeAtEntry: 500,
    shares: 100,
    stakeUsd: 94,
    enteredAt: AT('12:00'),
    orderId: null,
    fillPrice: null,
    outcome: null,
    pnl: null,
    settledAt: null,
    status: 'filled',
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Omit<Snapshot, 'id'> {
  return {
    marketId: 'm1',
    fetchedAt: AT('12:00'),
    minuteOfHour: 0,
    secondOfWindow: 15,
    upPrice: 0.61,
    downPrice: 0.38,
    upBid: 0.61,
    upAsk: 0.63,
    upBidSize: 500,
    upAskSize: 400,
    spread: 0.02,
    midpoint: 0.62,
    lastTradePrice: 0.62,
    volume24h: null,
    spotPrice: null,
    spotFetchedAt: null,
    ...over,
  };
}

/** In-memory database with one market to hang trades off. */
function freshStorage(): StorageService {
  const s = new StorageService(':memory:');
  s.upsertMarket(market('m1'));
  return s;
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// === spot columns ===

test('a snapshot round-trips its spot price and its own spot timestamp', () => {
  const s = freshStorage();
  const spotAt = '2026-08-03T12:00:00.187Z';
  s.insertSnapshot(snapshot({ fetchedAt: AT('12:00'), spotPrice: 113250.2, spotFetchedAt: spotAt }));

  const [stored] = s.getSnapshotsByMarket('m1');
  assert.equal(stored.spotPrice, 113250.2);
  // Stored separately from fetchedAt on purpose: the gap between them is the
  // book-vs-spot skew the fair-value analysis has to be able to measure.
  assert.equal(stored.spotFetchedAt, spotAt);
  assert.notEqual(stored.spotFetchedAt, stored.fetchedAt);
  s.close();
});

test('a failed spot fetch stores nulls and leaves the book row intact', () => {
  const s = freshStorage();
  s.insertSnapshot(snapshot({ spotPrice: null, spotFetchedAt: null }));

  const [stored] = s.getSnapshotsByMarket('m1');
  assert.equal(stored.spotPrice, null);
  assert.equal(stored.spotFetchedAt, null);
  assert.equal(stored.upBid, 0.61, 'the book capture must not be affected');
  assert.equal(stored.upAsk, 0.63);
  s.close();
});

// === countTradesOnDay ===

test('the daily cap counts only entries that took risk', () => {
  const s = freshStorage();
  s.insertTrade(trade({ status: 'open' }));
  s.insertTrade(trade({ status: 'filled' }));
  s.insertTrade(trade({ status: 'settled' }));
  // Neither of these ever acquired a position.
  s.insertTrade(trade({ status: 'cancelled' }));
  s.insertTrade(trade({ status: 'failed' }));

  assert.equal(s.countTradesOnDay('live', DAY), 3);
  s.close();
});

test('a run of unfilled orders cannot exhaust the daily cap', () => {
  // The regression this guards: on a 15s entry cadence, cancelled orders used
  // to count, so a thin book could burn the whole cap without risking a cent.
  const s = freshStorage();
  for (let i = 0; i < 25; i++) s.insertTrade(trade({ status: 'cancelled' }));
  assert.equal(s.countTradesOnDay('live', DAY), 0);
  s.close();
});

test('the daily cap is scoped by mode and by UTC day', () => {
  const s = freshStorage();
  s.insertTrade(trade({ status: 'filled', mode: 'live' }));
  s.insertTrade(trade({ status: 'filled', mode: 'paper' }));
  s.insertTrade(trade({ status: 'filled', mode: 'live', enteredAt: '2026-08-02T23:00:00.000Z' }));

  assert.equal(s.countTradesOnDay('live', DAY), 1);
  assert.equal(s.countTradesOnDay('paper', DAY), 1);
  assert.equal(s.countTradesOnDay('live', '2026-08-02'), 1);
  s.close();
});

// === getOpenExposure ===

test('open exposure is zero when nothing is at risk', () => {
  const s = freshStorage();
  assert.equal(s.getOpenExposure('live'), 0);
  s.insertTrade(trade({ status: 'settled' }));
  s.insertTrade(trade({ status: 'cancelled' }));
  assert.equal(s.getOpenExposure('live'), 0, 'settled and cancelled carry no risk');
  s.close();
});

test('open exposure uses the fill price when known, the entry price otherwise', () => {
  const s = freshStorage();
  // Filled at a better price than planned.
  s.insertTrade(trade({ status: 'filled', shares: 100, entryPrice: 0.94, fillPrice: 0.93 }));
  // Still working, so only the intended price is known.
  s.insertTrade(trade({ status: 'open', shares: 50, entryPrice: 0.92, fillPrice: null }));

  assert.ok(close(s.getOpenExposure('live'), 100 * 0.93 + 50 * 0.92));
  s.close();
});

test('open exposure is scoped by mode', () => {
  const s = freshStorage();
  s.insertTrade(trade({ status: 'filled', mode: 'live', shares: 100, fillPrice: 0.9 }));
  s.insertTrade(trade({ status: 'filled', mode: 'paper', shares: 100, fillPrice: 0.9 }));
  assert.ok(close(s.getOpenExposure('live'), 90));
  assert.ok(close(s.getOpenExposure('paper'), 90));
  s.close();
});

test('a partial fill contributes only what it actually cost', () => {
  const s = freshStorage();
  s.insertTrade(trade({ status: 'filled', shares: 40, entryPrice: 0.94, fillPrice: 0.93 }));
  assert.ok(close(s.getOpenExposure('live'), 40 * 0.93));
  s.close();
});

// === getOpenLiveTrades ===

test('only live trades left open are picked up for reconciliation', () => {
  const s = freshStorage();
  const orphan = trade({ status: 'open', mode: 'live', orderId: 'order-1' });
  s.insertTrade(orphan);
  s.insertTrade(trade({ status: 'open', mode: 'paper' }));
  s.insertTrade(trade({ status: 'filled', mode: 'live' }));
  s.insertTrade(trade({ status: 'cancelled', mode: 'live' }));

  const open = s.getOpenLiveTrades();
  assert.equal(open.length, 1);
  assert.equal(open[0].id, orphan.id);
  assert.equal(open[0].orderId, 'order-1');
  s.close();
});

// === updateTradeExecution ===

test('a partial fill rewrites shares and stake so settlement pays out correctly', () => {
  const s = freshStorage();
  const t = trade({ status: 'open', shares: 106.38, stakeUsd: 99.99 });
  s.insertTrade(t);

  s.updateTradeExecution(t.id, {
    status: 'filled',
    orderId: 'order-9',
    fillPrice: 0.93,
    shares: 40,
    stakeUsd: 40 * 0.93,
  });

  const [stored] = s.getTradesByMode('live');
  assert.equal(stored.status, 'filled');
  assert.equal(stored.shares, 40);
  assert.equal(stored.orderId, 'order-9');
  assert.equal(stored.fillPrice, 0.93);
  assert.ok(close(stored.stakeUsd, 37.2));
  s.close();
});

test('omitted fields are left alone rather than nulled', () => {
  const s = freshStorage();
  const t = trade({ status: 'open', orderId: 'order-3', shares: 100, stakeUsd: 94 });
  s.insertTrade(t);

  // The cancel path passes neither shares nor stake.
  s.updateTradeExecution(t.id, { status: 'cancelled' });

  const [stored] = s.getTradesByMode('live');
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.orderId, 'order-3', 'order id must survive');
  assert.equal(stored.shares, 100);
  assert.equal(stored.stakeUsd, 94);
  s.close();
});

// === trade tape ===

test('a print round-trips every column it was given', () => {
  const s = freshStorage();
  const entry = tapeEntry({ tokenSide: 'DOWN', price: 0.1031460619, size: 158.222221, takerSide: 'SELL' });
  assert.equal(s.insertTradeTape([entry]), 1);

  assert.deepEqual(s.getTradeTapeByMarket('m1'), [entry]);
  s.close();
});

test('a taker side the API did not give is stored as null', () => {
  const s = freshStorage();
  s.insertTradeTape([tapeEntry({ takerSide: null })]);
  assert.equal(s.getTradeTapeByMarket('m1')[0].takerSide, null);
  s.close();
});

test('re-inserting the same prints is a no-op', () => {
  // This is what makes a failed fetch safe to retry: the pages that landed the
  // first time are re-offered on every attempt and must not duplicate.
  const s = freshStorage();
  const page = [tapeEntry(), tapeEntry(), tapeEntry()];

  assert.equal(s.insertTradeTape(page), 3);
  assert.equal(s.insertTradeTape(page), 0, 'nothing new the second time');
  assert.equal(s.getTradeTapeByMarket('m1').length, 3);
  s.close();
});

test('a retry that overlaps the previous attempt inserts only the new prints', () => {
  const s = freshStorage();
  const [a, b, c] = [tapeEntry(), tapeEntry(), tapeEntry()];

  assert.equal(s.insertTradeTape([a, b]), 2);
  // The retry re-fetches from page zero, so it re-offers a and b alongside c.
  assert.equal(s.insertTradeTape([a, b, c]), 1);
  assert.equal(s.getTradeTapeByMarket('m1').length, 3);
  s.close();
});

test('two prints that differ only in external id are both kept', () => {
  const s = freshStorage();
  const shared = { price: 0.5, size: 100, tradedAt: AT('12:02') };
  s.insertTradeTape([
    tapeEntry({ ...shared, externalId: '0xtx:token-up:100:0.5' }),
    tapeEntry({ ...shared, externalId: '0xtx:token-down:100:0.5' }),
  ]);
  assert.equal(s.getTradeTapeByMarket('m1').length, 2);
  s.close();
});

test('inserting an empty tape touches nothing', () => {
  const s = freshStorage();
  assert.equal(s.insertTradeTape([]), 0);
  s.close();
});

// === the tape backlog ===

test('a market is owed a tape once it resolves, and stops being owed once marked', () => {
  const s = new StorageService(':memory:');
  s.upsertMarket(resolvedMarket('r1', 1));

  assert.deepEqual(s.getMarketsAwaitingTape().map((m) => m.id), ['r1']);
  s.markTapeFetched('r1', AT('12:30'));
  assert.deepEqual(s.getMarketsAwaitingTape(), []);
  assert.equal(s.getMarketById('r1')?.tapeFetchedAt, AT('12:30'));
  s.close();
});

test('an unresolved market is not owed a tape yet', () => {
  // Its window may still be open, and its prints are not final until it settles.
  const s = new StorageService(':memory:');
  s.upsertMarket(market('open1', { outcome: null }));
  assert.deepEqual(s.getMarketsAwaitingTape(), []);
  s.close();
});

test('a market whose fetch failed comes back on the next cycle', () => {
  // Failure marks nothing, so "resolved with a null marker" is the whole retry
  // condition - there is no separate retry list to fall out of sync.
  const s = new StorageService(':memory:');
  s.upsertMarket(resolvedMarket('r1', 1));

  assert.equal(s.getMarketsAwaitingTape().length, 1);
  assert.equal(s.getMarketsAwaitingTape().length, 1, 'still owed until it is marked');
  s.close();
});

test('the backlog is capped and takes the freshest markets first', () => {
  // A market that fails forever must not starve the ones resolving behind it.
  const s = new StorageService(':memory:');
  for (let i = 0; i < 6; i++) s.upsertMarket(resolvedMarket(`r${i}`, i + 1));

  const batch = s.getMarketsAwaitingTape(3);
  assert.deepEqual(batch.map((m) => m.id), ['r0', 'r1', 'r2']);
  s.close();
});

test('the backlog is a retry queue, not a crawl over all history', () => {
  // Without the lookback, deploying this against an existing database would
  // treat thousands of long-settled markets as owed.
  const s = new StorageService(':memory:');
  s.upsertMarket(resolvedMarket('recent', 2));
  s.upsertMarket(resolvedMarket('ancient', 30 * 24));

  assert.deepEqual(s.getMarketsAwaitingTape(50, 24).map((m) => m.id), ['recent']);
  // Widening the window is how a deliberate backfill is done.
  assert.equal(s.getMarketsAwaitingTape(50, 365 * 24).length, 2);
  s.close();
});

test('re-upserting a market does not wipe its tape marker', () => {
  // upsertMarket is INSERT OR REPLACE, so a column left off the list would come
  // back null and the market would be fetched all over again.
  const s = new StorageService(':memory:');
  const m = resolvedMarket('r1', 1);
  s.upsertMarket(m);
  s.markTapeFetched('r1', AT('12:30'));

  const reloaded = s.getMarketById('r1')!;
  s.upsertMarket({ ...reloaded, question: 'edited' });

  assert.equal(s.getMarketById('r1')?.tapeFetchedAt, AT('12:30'));
  assert.deepEqual(s.getMarketsAwaitingTape(), []);
  s.close();
});

// === getMarketById (used to settle recovered positions) ===

test('a recovered position can find its market to settle against', () => {
  const s = freshStorage();
  assert.equal(s.getMarketById('m1')?.slug, 'slug-m1');
  assert.equal(s.getMarketById('nope'), null);
  s.close();
});
