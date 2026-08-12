import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/services/market.js';
import { StorageService } from '../src/services/storage.js';
import type { PolymarketService } from '../src/services/polymarket.js';
import type { SpotService } from '../src/services/spot.js';
import type { MarketTape, TapeService } from '../src/services/tape.js';
import type { TrackedMarket, TradeTapeEntry } from '../src/models/types.js';

/** A market that settled `hoursAgo` ago, so nothing is pending resolution. */
function resolvedMarket(id: string, hoursAgo = 1): TrackedMarket {
  const at = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  return {
    id,
    conditionId: `0xcond-${id}`,
    tokenIdUp: `${id}-up`,
    tokenIdDown: `${id}-down`,
    asset: 'HYPE',
    question: 'q',
    eventStartTime: at,
    windowStart: at,
    windowEnd: at,
    durationMinutes: 5,
    outcome: 'UP',
    slug: `hype-updown-5m-${id}`,
    seriesSlug: 'hype-up-or-down-5m',
    tapeFetchedAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

function print(marketId: string, externalId: string): TradeTapeEntry {
  return {
    marketId,
    tokenSide: 'UP',
    price: 0.42,
    size: 100,
    takerSide: 'BUY',
    tradedAt: new Date(Date.now() - 3600_000).toISOString(),
    externalId,
  };
}

/** Records which markets were asked for, and serves a scripted answer each. */
function fakeTape(answer: (m: TrackedMarket) => MarketTape | null) {
  const asked: string[] = [];
  const service = {
    async fetchMarketTape(market: TrackedMarket) {
      asked.push(market.id);
      return answer(market);
    },
  } as unknown as TapeService;
  return { service, asked };
}

const tapeOf = (entries: TradeTapeEntry[]): MarketTape => ({
  entries,
  dropped: 0,
  truncated: false,
  pages: 1,
});

/** Gamma must not be touched when nothing is pending resolution. */
const NO_GAMMA = {
  getMarketBySlug() {
    throw new Error('resolution should not have called Gamma');
  },
} as unknown as PolymarketService;

const NO_SPOT = {} as SpotService;

function setup(tape: TapeService, markets: TrackedMarket[]) {
  const storage = new StorageService(':memory:');
  for (const m of markets) storage.upsertMarket(m);
  return { storage, market: new MarketService(NO_GAMMA, storage, NO_SPOT, undefined, tape) };
}

test('a tape still owed is fetched even when nothing is pending resolution', async () => {
  // The regression: the tape pass used to sit after checkResolutions' early
  // return, so a market whose fetch had failed was only retried on a cycle that
  // happened to have other markets resolving.
  const { service, asked } = fakeTape((m) => tapeOf([print(m.id, 'tx-1')]));
  const { storage, market } = setup(service, [resolvedMarket('m1')]);

  await market.checkResolutions();

  assert.deepEqual(asked, ['m1']);
  assert.equal(storage.getTradeTapeByMarket('m1').length, 1);
  assert.notEqual(storage.getMarketById('m1')?.tapeFetchedAt, null);
  storage.close();
});

test('a failed fetch marks nothing, so the next cycle tries again', async () => {
  let attempt = 0;
  const { service, asked } = fakeTape((m) => {
    attempt++;
    return attempt === 1 ? null : tapeOf([print(m.id, 'tx-1')]);
  });
  const { storage, market } = setup(service, [resolvedMarket('m1')]);

  await market.checkResolutions();
  assert.equal(storage.getMarketById('m1')?.tapeFetchedAt, null, 'not marked on failure');
  assert.equal(storage.getTradeTapeByMarket('m1').length, 0);

  await market.checkResolutions();
  assert.deepEqual(asked, ['m1', 'm1']);
  assert.notEqual(storage.getMarketById('m1')?.tapeFetchedAt, null);
  assert.equal(storage.getTradeTapeByMarket('m1').length, 1);
  storage.close();
});

test('a market is not fetched twice once its tape has landed', async () => {
  const { service, asked } = fakeTape((m) => tapeOf([print(m.id, 'tx-1')]));
  const { storage, market } = setup(service, [resolvedMarket('m1')]);

  await market.checkResolutions();
  await market.checkResolutions();

  assert.deepEqual(asked, ['m1'], 'the second cycle has nothing owed');
  assert.equal(storage.getTradeTapeByMarket('m1').length, 1);
  storage.close();
});

test('one market failing does not stop the rest of the backlog', async () => {
  const { service, asked } = fakeTape((m) =>
    m.id === 'bad' ? null : tapeOf([print(m.id, `tx-${m.id}`)])
  );
  const { storage, market } = setup(service, [
    resolvedMarket('bad', 1),
    resolvedMarket('good', 2),
  ]);

  await market.checkResolutions();

  assert.deepEqual(asked.sort(), ['bad', 'good']);
  assert.equal(storage.getMarketById('bad')?.tapeFetchedAt, null);
  assert.notEqual(storage.getMarketById('good')?.tapeFetchedAt, null);
  storage.close();
});

test('a tape service that throws cannot take down the resolution watcher', async () => {
  const service = {
    async fetchMarketTape() {
      throw new Error('data API on fire');
    },
  } as unknown as TapeService;
  const { storage, market } = setup(service, [resolvedMarket('m1')]);

  await market.checkResolutions();

  assert.equal(storage.getMarketById('m1')?.tapeFetchedAt, null);
  storage.close();
});

test('with no tape service wired in, the watcher behaves exactly as before', async () => {
  const storage = new StorageService(':memory:');
  storage.upsertMarket(resolvedMarket('m1'));
  const market = new MarketService(NO_GAMMA, storage, NO_SPOT);

  await market.checkResolutions();

  assert.equal(storage.getTradeTapeByMarket('m1').length, 0);
  storage.close();
});
