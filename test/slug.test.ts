import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMarketSlug,
  generateUpcomingMarketSlugs,
  parseSlugDate,
  windowStartEpoch,
} from '../src/utils/slug.js';

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
