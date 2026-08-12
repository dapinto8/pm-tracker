import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMarketSlug,
  generateUpcomingMarketSlugs,
  parseSlugDate,
  windowStartEpoch,
} from '../src/utils/slug.js';
import { ASSETS, ASSET_CONFIG } from '../src/config.js';

// Real market from the live API: btc-updown-5m-1785774300
// covers 2026-08-03T16:25:00Z -> 2026-08-03T16:30:00Z
const KNOWN_EPOCH = 1785774300;
const KNOWN_SLUG = 'btc-updown-5m-1785774300';
const KNOWN_START = '2026-08-03T16:25:00.000Z';

test('builds the known live slug from its window epoch', () => {
  assert.equal(generateMarketSlug('btc-updown-5m', KNOWN_EPOCH), KNOWN_SLUG);
});

test('window start floors to the 300s boundary', () => {
  // Mid-window: 16:27:33 belongs to the 16:25 window.
  const mid = new Date('2026-08-03T16:27:33.500Z');
  assert.equal(windowStartEpoch(mid), KNOWN_EPOCH);
  assert.equal(new Date(windowStartEpoch(mid) * 1000).toISOString(), KNOWN_START);
});

test('window start is idempotent on an exact boundary', () => {
  const exact = new Date(KNOWN_START);
  assert.equal(windowStartEpoch(exact), KNOWN_EPOCH);
});

test('upcoming slugs step forward in 5-minute windows', () => {
  const now = new Date('2026-08-03T16:27:33Z');
  const slugs = generateUpcomingMarketSlugs('btc-updown-5m', 3, now);
  assert.deepEqual(slugs, [
    'btc-updown-5m-1785774300',
    'btc-updown-5m-1785774600',
    'btc-updown-5m-1785774900',
  ]);
  // Consecutive windows are exactly 5 minutes apart.
  const [a, b] = [parseSlugDate(slugs[0])!, parseSlugDate(slugs[1])!];
  assert.equal(b.getTime() - a.getTime(), 5 * 60 * 1000);
});

test('parses the window start back out of a slug', () => {
  assert.equal(parseSlugDate(KNOWN_SLUG)?.toISOString(), KNOWN_START);
  assert.equal(parseSlugDate('eth-updown-5m-1785774300')?.toISOString(), KNOWN_START);
});

test('rejects slugs without a timestamp suffix', () => {
  // The old hourly format - no epoch, so it must not parse as one.
  assert.equal(parseSlugDate('bitcoin-up-or-down-august-3-1pm-et'), null);
  assert.equal(parseSlugDate('btc-updown-5m'), null);
});

// === per-asset slugs ===

/**
 * Live windows read back off the Gamma API on 2026-08-12. Every one of these
 * resolved to a real market, which is the only thing that makes the prefixes
 * below trustworthy - the format is a convention upstream, not a contract.
 */
const LIVE_SLUGS: Record<string, string> = {
  BTC: 'btc-updown-5m-1786542600',
  ETH: 'eth-updown-5m-1786542600',
  SOL: 'sol-updown-5m-1786542600',
  HYPE: 'hype-updown-5m-1786542600',
  DOGE: 'doge-updown-5m-1786542600',
  BNB: 'bnb-updown-5m-1786542600',
};
const LIVE_EPOCH = 1786542600;

test('every tracked asset builds its verified live slug', () => {
  // Fails loudly if an asset is added to ASSETS without a checked slug, rather
  // than silently discovering nothing at runtime.
  assert.deepEqual([...ASSETS].sort(), Object.keys(LIVE_SLUGS).sort());

  for (const asset of ASSETS) {
    assert.equal(
      generateMarketSlug(ASSET_CONFIG[asset].slugPrefix, LIVE_EPOCH),
      LIVE_SLUGS[asset],
      `${asset} slug`
    );
  }
});

test('the new coins follow the same epoch-suffixed format as BTC', () => {
  const now = new Date('2026-08-12T13:50:00Z');
  for (const asset of ['HYPE', 'DOGE', 'BNB'] as const) {
    const slugs = generateUpcomingMarketSlugs(ASSET_CONFIG[asset].slugPrefix, 3, now);
    assert.deepEqual(slugs, [
      `${ASSET_CONFIG[asset].slugPrefix}-1786542600`,
      `${ASSET_CONFIG[asset].slugPrefix}-1786542900`,
      `${ASSET_CONFIG[asset].slugPrefix}-1786543200`,
    ]);
    // The parser is prefix-agnostic, so a new coin needs no change to it.
    assert.equal(parseSlugDate(slugs[0])?.toISOString(), '2026-08-12T13:50:00.000Z');
  }
});

test('each asset maps to its own series and a distinct prefix', () => {
  const prefixes = ASSETS.map((a) => ASSET_CONFIG[a].slugPrefix);
  assert.equal(new Set(prefixes).size, prefixes.length, 'prefixes must not collide');

  for (const asset of ASSETS) {
    const { seriesSlug, slugPrefix } = ASSET_CONFIG[asset];
    // Upstream pairs `<coin>-up-or-down-5m` with `<coin>-updown-5m`.
    assert.equal(seriesSlug, `${slugPrefix.replace('-updown-5m', '')}-up-or-down-5m`);
  }
});

test('honours a non-default window length', () => {
  const now = new Date('2026-08-03T16:27:33Z');
  // 60-minute windows floor to the top of the hour.
  assert.equal(
    new Date(windowStartEpoch(now, 3600) * 1000).toISOString(),
    '2026-08-03T16:00:00.000Z'
  );
  const slugs = generateUpcomingMarketSlugs('x', 2, now, 3600);
  const [a, b] = [parseSlugDate(slugs[0])!, parseSlugDate(slugs[1])!];
  assert.equal(b.getTime() - a.getTime(), 60 * 60 * 1000);
});
