import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalIdOf, parseTradePage, TapeService, type DataApiTrade } from '../src/services/tape.js';
import { TAPE_MAX_OFFSET, TAPE_PAGE_SIZE } from '../src/config.js';
import type { TrackedMarket } from '../src/models/types.js';

const UP_TOKEN = '22710727662751764171814898162129970081342786871151734200266798384284320012529';
const DOWN_TOKEN = '12955135178107771109403252680833875011750411979252631505261621150614675594726';

const MARKET: TrackedMarket = {
  id: 'm1',
  conditionId: '0xc8b2581dcafdc9e4735e3eac0fc23d3429a6cf0a566621ec1491fb6de971be96',
  tokenIdUp: UP_TOKEN,
  tokenIdDown: DOWN_TOKEN,
  asset: 'DOGE',
  question: 'Dogecoin Up or Down - August 12, 9:35AM-9:40AM ET',
  eventStartTime: '2026-08-12T13:35:00Z',
  windowStart: '2026-08-12T13:35:00Z',
  windowEnd: '2026-08-12T13:40:00Z',
  durationMinutes: 5,
  outcome: 'DOWN',
  slug: 'doge-updown-5m-1786541700',
  seriesSlug: 'doge-up-or-down-5m',
  tapeFetchedAt: null,
  createdAt: '2026-08-12T13:30:00Z',
  updatedAt: '2026-08-12T13:45:00Z',
};

/**
 * Two rows copied from a real GET /trades response, trimmed of the profile
 * fields the tape does not store. Note `timestamp` is unix SECONDS and `price`
 * and `size` arrive as JSON numbers, not strings.
 */
const PAGE: DataApiTrade[] = [
  {
    asset: DOWN_TOKEN,
    side: 'BUY',
    size: 158.222221,
    price: 0.1031460619,
    timestamp: 1786541988,
    transactionHash: '0x652341944298c76d6286fab477a9a30e78c29d308a660a1c03248faff3b2f438',
  },
  {
    asset: UP_TOKEN,
    side: 'SELL',
    size: 2313.66,
    price: 0.99,
    timestamp: 1786542087,
    transactionHash: '0x66a8d9e59028439b3bdfa7f696ca7e7b1423091f85392ad3e3bd52536ae84272',
  },
];

/** Swap global fetch for the duration of one call. */
async function withFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** `n` synthetic prints, each with its own transaction hash. */
function fillerPage(n: number, from = 0): DataApiTrade[] {
  return Array.from({ length: n }, (_, i) => ({
    asset: i % 2 === 0 ? UP_TOKEN : DOWN_TOKEN,
    side: i % 2 === 0 ? 'BUY' : 'SELL',
    size: 10 + i,
    price: 0.5,
    timestamp: 1786541700 + from + i,
    transactionHash: `0xhash${from + i}`,
  }));
}

/**
 * A fetch stub that serves `pages` in order and records the URLs requested.
 * Anything past the last page 404s, which would fail the test rather than
 * quietly look like the end of the tape.
 */
function pageServer(pages: DataApiTrade[][]) {
  const urls: string[] = [];
  const stub = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    const page = pages[urls.length - 1];
    return Promise.resolve(page ? json(page) : new Response('no more pages', { status: 404 }));
  }) as typeof fetch;
  return { stub, urls };
}

const offsetOf = (url: string) => Number(new URL(url).searchParams.get('offset'));

// === parseTradePage ===

test('a real page parses into prints keyed to the right side of the market', () => {
  const { entries, dropped } = parseTradePage(PAGE, MARKET);

  assert.equal(dropped, 0);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    marketId: 'm1',
    tokenSide: 'DOWN',
    price: 0.1031460619,
    size: 158.222221,
    takerSide: 'BUY',
    tradedAt: '2026-08-12T13:39:48.000Z',
    externalId: externalIdOf(PAGE[0].transactionHash!, DOWN_TOKEN, 158.222221, 0.1031460619),
  });
  assert.equal(entries[1].tokenSide, 'UP');
  assert.equal(entries[1].takerSide, 'SELL');
});

test('unix seconds become an ISO instant, not an epoch in milliseconds', () => {
  // 1786541988s is 2026-08-12T13:39:48Z. Read as ms it would land in 1970.
  const [entry] = parseTradePage([PAGE[0]], MARKET).entries;
  assert.equal(entry.tradedAt, '2026-08-12T13:39:48.000Z');
  assert.equal(new Date(entry.tradedAt).getUTCFullYear(), 2026);
});

test('numeric strings parse the same as JSON numbers', () => {
  // The endpoint returns numbers today; a string would be equally valid JSON.
  const asStrings = parseTradePage(
    [{ ...PAGE[1], size: '2313.66', price: '0.99', timestamp: '1786542087' }],
    MARKET
  ).entries;
  const asNumbers = parseTradePage([PAGE[1]], MARKET).entries;
  assert.deepEqual(asStrings, asNumbers, 'including the external id, which must not drift');
});

test('a print on some other market is dropped, never guessed at', () => {
  const { entries, dropped } = parseTradePage(
    [{ ...PAGE[0], asset: '999999999999999999' }],
    MARKET
  );
  assert.equal(entries.length, 0);
  assert.equal(dropped, 1, 'and counted, so the gap is visible in the logs');
});

test('rows that cannot be an honest print are dropped and counted', () => {
  const bad: DataApiTrade[] = [
    { ...PAGE[0], price: 1.4 },                  // not a probability
    { ...PAGE[0], price: -0.1 },
    { ...PAGE[0], size: 0 },                     // not a fill
    { ...PAGE[0], size: -5 },
    { ...PAGE[0], price: 'oops' },               // unparseable
    { ...PAGE[0], timestamp: 0 },                // no usable time
    { ...PAGE[0], transactionHash: undefined },  // no stable identity
  ];
  const { entries, dropped } = parseTradePage(bad, MARKET);
  assert.equal(entries.length, 0);
  assert.equal(dropped, bad.length);
});

test('the boundary prices 0 and 1 are real prints', () => {
  const { entries } = parseTradePage(
    [{ ...PAGE[0], price: 0 }, { ...PAGE[1], price: 1 }],
    MARKET
  );
  assert.deepEqual(entries.map((e) => e.price), [0, 1]);
});

test('an unrecognised taker side is null rather than invented', () => {
  const { entries } = parseTradePage([{ ...PAGE[0], side: 'MAKER' }, { ...PAGE[1], side: undefined }], MARKET);
  assert.deepEqual(entries.map((e) => e.takerSide), [null, null]);
  assert.equal(entries.length, 2, 'the print itself is still real');
});

test('a lowercase side is normalised', () => {
  const [entry] = parseTradePage([{ ...PAGE[0], side: 'buy' }], MARKET).entries;
  assert.equal(entry.takerSide, 'BUY');
});

test('a payload that is not an array yields nothing', () => {
  for (const bad of [null, undefined, {}, 'oops', { error: 'nope' }]) {
    assert.deepEqual(parseTradePage(bad, MARKET), { entries: [], dropped: 0 });
  }
});

// === external ids ===

test('the same print always yields the same id, and different prints do not', () => {
  const a = parseTradePage(PAGE, MARKET).entries;
  const b = parseTradePage(PAGE, MARKET).entries;
  assert.deepEqual(a.map((e) => e.externalId), b.map((e) => e.externalId));
  assert.equal(new Set(a.map((e) => e.externalId)).size, 2);
});

test('two fills in one transaction stay distinct', () => {
  // Never observed in 6,353 sampled prints, but the unique index would drop the
  // second one silently, so the id folds in the fields that separate them.
  const sameTx: DataApiTrade[] = [
    { ...PAGE[0], size: 100, price: 0.4 },
    { ...PAGE[0], size: 250, price: 0.41 },
  ];
  const { entries } = parseTradePage(sameTx, MARKET);
  assert.equal(new Set(entries.map((e) => e.externalId)).size, 2);
});

test('the same transaction hitting both sides stays distinct', () => {
  const bothSides: DataApiTrade[] = [
    { ...PAGE[0], asset: UP_TOKEN },
    { ...PAGE[0], asset: DOWN_TOKEN },
  ];
  const { entries } = parseTradePage(bothSides, MARKET);
  assert.equal(new Set(entries.map((e) => e.externalId)).size, 2);
});

// === fetchMarketTape: pagination ===

test('a short first page is the whole tape and costs one request', async () => {
  const { stub, urls } = pageServer([PAGE]);
  const tape = await withFetch(stub, () => new TapeService().fetchMarketTape(MARKET));

  assert.equal(urls.length, 1);
  assert.equal(tape!.pages, 1);
  assert.equal(tape!.entries.length, 2);
  assert.equal(tape!.truncated, false);
  assert.equal(offsetOf(urls[0]), 0);
});

test('an empty tape is a success, not a failure', async () => {
  const { stub } = pageServer([[]]);
  const tape = await withFetch(stub, () => new TapeService().fetchMarketTape(MARKET));

  assert.notEqual(tape, null, 'a market nobody traded must still be marked fetched');
  assert.deepEqual(tape!.entries, []);
});

test('a full page is followed up, and the pages are concatenated in order', async () => {
  const first = fillerPage(TAPE_PAGE_SIZE);
  const second = fillerPage(7, TAPE_PAGE_SIZE);
  const { stub, urls } = pageServer([first, second]);

  const tape = await withFetch(stub, () => new TapeService().fetchMarketTape(MARKET));

  assert.equal(urls.length, 2);
  assert.equal(tape!.pages, 2);
  assert.equal(tape!.entries.length, TAPE_PAGE_SIZE + 7);
  // Offsets step by the page size, and the page size is what was asked for.
  assert.deepEqual(urls.map(offsetOf), [0, TAPE_PAGE_SIZE]);
  assert.equal(Number(new URL(urls[0]).searchParams.get('limit')), TAPE_PAGE_SIZE);
  // First print of page one and last of page two, in that order.
  assert.equal(tape!.entries[0].externalId, externalIdOf('0xhash0', UP_TOKEN, 10, 0.5));
  assert.equal(
    tape!.entries.at(-1)!.externalId,
    externalIdOf(`0xhash${TAPE_PAGE_SIZE + 6}`, UP_TOKEN, 16, 0.5)
  );
  assert.equal(new Set(tape!.entries.map((e) => e.externalId)).size, tape!.entries.length);
});

test('paging stops at the API offset ceiling and says the tape is truncated', async () => {
  // The endpoint 400s past this offset rather than clamping, so there is no
  // deeper page to ask for - it is a limit, not a failure, and not retryable.
  const pages = Array.from({ length: TAPE_MAX_OFFSET / TAPE_PAGE_SIZE + 1 }, (_, i) =>
    fillerPage(TAPE_PAGE_SIZE, i * TAPE_PAGE_SIZE)
  );
  const { stub, urls } = pageServer(pages);

  const tape = await withFetch(stub, () => new TapeService().fetchMarketTape(MARKET));

  assert.equal(tape!.truncated, true);
  assert.equal(urls.length, pages.length);
  assert.equal(offsetOf(urls.at(-1)!), TAPE_MAX_OFFSET, 'never requests past the ceiling');
});

test('the request asks for one row per print, not one per maker match', async () => {
  const { stub, urls } = pageServer([PAGE]);
  await withFetch(stub, () => new TapeService().fetchMarketTape(MARKET));

  assert.equal(new URL(urls[0]).searchParams.get('takerOnly'), 'true');
  assert.equal(new URL(urls[0]).searchParams.get('market'), MARKET.conditionId);
});

// === fetchMarketTape: failure is all-or-nothing ===

test('a failure on a later page discards the whole tape', async () => {
  // Half a tape recorded as complete looks exactly like a quiet market, which
  // a fill simulation would believe. Better to return nothing and retry.
  const { stub, urls } = pageServer([fillerPage(TAPE_PAGE_SIZE)]); // page 2 -> 404
  const tape = await withFetch(stub, () => new TapeService().fetchMarketTape(MARKET));

  assert.equal(tape, null);
  assert.equal(urls.length, 2);
});

test('a network error yields null rather than throwing', async () => {
  const tape = await withFetch(
    () => Promise.reject(new Error('ECONNRESET')),
    () => new TapeService().fetchMarketTape(MARKET)
  );
  assert.equal(tape, null);
});

test('a timeout yields null rather than throwing', async () => {
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const tape = await withFetch(
    () => Promise.reject(abort),
    () => new TapeService().fetchMarketTape(MARKET)
  );
  assert.equal(tape, null);
});

test('a non-array body is a failure, not an empty tape', async () => {
  // An HTML error page or a rate-limit object must not be read as "no trades",
  // which would mark the market fetched and lose its prints for good.
  for (const body of ['<html>proxy error</html>', JSON.stringify({ error: 'rate limited' })]) {
    const tape = await withFetch(
      () => Promise.resolve(new Response(body, { status: 200 })),
      () => new TapeService().fetchMarketTape(MARKET)
    );
    assert.equal(tape, null);
  }
});

test('a non-OK response yields null', async () => {
  const tape = await withFetch(
    () => Promise.resolve(new Response('rate limited', { status: 429 })),
    () => new TapeService().fetchMarketTape(MARKET)
  );
  assert.equal(tape, null);
});
