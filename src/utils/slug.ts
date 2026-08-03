import { WINDOW_SECONDS } from '../config.js';

/**
 * Slugs for the 5-minute up/down series are deterministic:
 *
 *   btc-updown-5m-1785774300
 *                 ^ unix seconds of the window START, aligned to a 300s boundary
 *
 * The market and its event share the same slug, so no search endpoint is
 * needed - every window can be addressed directly by computing its timestamp.
 *
 * (The old hourly series used an ET calendar slug like
 * `bitcoin-up-or-down-august-3-1pm-et`. That format carries no year, so those
 * slugs now collide with the prior year's markets and always resolve closed.)
 */

/** Start of the window containing `date`, as unix seconds. */
export function windowStartEpoch(date: Date, windowSeconds: number = WINDOW_SECONDS): number {
  return Math.floor(date.getTime() / 1000 / windowSeconds) * windowSeconds;
}

export function generateMarketSlug(assetPrefix: string, windowEpoch: number): string {
  return `${assetPrefix}-${windowEpoch}`;
}

/**
 * Slugs for the current window plus the next `windowsAhead - 1` windows.
 * Polymarket publishes these many hours in advance.
 */
export function generateUpcomingMarketSlugs(
  assetPrefix: string,
  windowsAhead: number,
  now: Date = new Date(),
  windowSeconds: number = WINDOW_SECONDS
): string[] {
  const start = windowStartEpoch(now, windowSeconds);
  const slugs: string[] = [];
  for (let i = 0; i < windowsAhead; i++) {
    slugs.push(generateMarketSlug(assetPrefix, start + i * windowSeconds));
  }
  return slugs;
}

/** Window start encoded in a slug, or null if it does not match the format. */
export function parseSlugDate(slug: string): Date | null {
  const match = slug.match(/-(\d{9,11})$/);
  if (!match) return null;
  const epoch = parseInt(match[1], 10);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch * 1000);
}
