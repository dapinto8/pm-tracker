import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBookTickers, SpotService } from '../src/services/spot.js';

const AT = '2026-08-05T16:25:03.412Z';

/** Shape of a real /api/v3/ticker/bookTicker?symbols=[...] response. */
const PAYLOAD = [
  { symbol: 'BTCUSDT', bidPrice: '113250.10000000', bidQty: '3.21', askPrice: '113250.30000000', askQty: '1.05' },
  { symbol: 'ETHUSDT', bidPrice: '3612.44000000', bidQty: '18.9', askPrice: '3612.56000000', askQty: '22.4' },
  { symbol: 'SOLUSDT', bidPrice: '184.9100000', bidQty: '405', askPrice: '184.9300000', askQty: '311' },
];

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

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

// === parseBookTickers ===

test('every tracked symbol maps to its asset with the mid of its top of book', () => {
  const mids = parseBookTickers(PAYLOAD, AT);

  assert.equal(mids.size, 3);
  assert.ok(close(mids.get('BTC')!.mid, (113250.1 + 113250.3) / 2));
  assert.ok(close(mids.get('ETH')!.mid, (3612.44 + 3612.56) / 2));
  assert.ok(close(mids.get('SOL')!.mid, (184.91 + 184.93) / 2));
});

test('the observation timestamp is carried onto every quote', () => {
  const mids = parseBookTickers(PAYLOAD, AT);
  for (const asset of ['BTC', 'ETH', 'SOL'] as const) {
    assert.equal(mids.get(asset)!.fetchedAt, AT);
  }
});

test('symbols we do not track are ignored', () => {
  // Guards against a response that echoes more than was asked for.
  const mids = parseBookTickers(
    [...PAYLOAD, { symbol: 'DOGEUSDT', bidPrice: '0.31', askPrice: '0.32' }],
    AT
  );
  assert.equal(mids.size, 3);
});

test('a quote that cannot yield an honest mid is dropped, not guessed', () => {
  const mids = parseBookTickers(
    [
      { symbol: 'BTCUSDT', bidPrice: '113250.1', askPrice: '113250.3' },
      { symbol: 'ETHUSDT', bidPrice: '3612.44' },                        // no ask
      { symbol: 'SOLUSDT', bidPrice: 'not-a-number', askPrice: '184.93' }, // unparseable
    ],
    AT
  );

  // A half-quote would otherwise average against 0 and report half the real
  // price - the same failure mode that corrupted the order book columns.
  assert.deepEqual([...mids.keys()], ['BTC']);
});

test('a zero or negative price is not a price', () => {
  const mids = parseBookTickers(
    [
      { symbol: 'BTCUSDT', bidPrice: '0', askPrice: '113250.3' },
      { symbol: 'ETHUSDT', bidPrice: '-1', askPrice: '3612.56' },
    ],
    AT
  );
  assert.equal(mids.size, 0);
});

test('a payload that is not an array yields nothing', () => {
  // Binance returns a bare object for a single-symbol query and an error object
  // on a bad request; neither should be coerced into a price.
  for (const bad of [null, undefined, {}, { code: -1121, msg: 'Invalid symbol.' }, 'oops']) {
    assert.equal(parseBookTickers(bad, AT).size, 0);
  }
});

// === getSpotMids: the error path must never break a tick ===

test('a network failure yields an empty map rather than throwing', async () => {
  const mids = await withFetch(
    () => Promise.reject(new Error('ECONNRESET')),
    () => new SpotService().getSpotMids()
  );
  assert.equal(mids.size, 0);
});

test('a timeout yields an empty map rather than throwing', async () => {
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const mids = await withFetch(
    () => Promise.reject(abort),
    () => new SpotService().getSpotMids()
  );
  assert.equal(mids.size, 0);
});

test('a non-OK response yields an empty map rather than throwing', async () => {
  const mids = await withFetch(
    () => Promise.resolve(new Response('rate limited', { status: 429 })),
    () => new SpotService().getSpotMids()
  );
  assert.equal(mids.size, 0);
});

test('a malformed body yields an empty map rather than throwing', async () => {
  const mids = await withFetch(
    () => Promise.resolve(new Response('<html>proxy error</html>', { status: 200 })),
    () => new SpotService().getSpotMids()
  );
  assert.equal(mids.size, 0);
});

test('a good response is parsed and stamped with a real timestamp', async () => {
  const before = Date.now();
  const mids = await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify(PAYLOAD), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      ),
    () => new SpotService().getSpotMids()
  );

  assert.equal(mids.size, 3);
  const stamped = Date.parse(mids.get('BTC')!.fetchedAt);
  assert.ok(stamped >= before && stamped <= Date.now(), 'stamped when the response landed');
  assert.match(mids.get('BTC')!.fetchedAt, /\.\d{3}Z$/, 'millisecond precision is required');
});
