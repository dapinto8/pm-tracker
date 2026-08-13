import { BINANCE_API_URL, BINANCE_SYMBOLS, SPOT_TIMEOUT_MS } from '../config.js';
import type { Asset, SpotQuote } from '../models/types.js';
import { logger } from '../utils/logger.js';

/** One entry of Binance's /api/v3/ticker/bookTicker response. */
interface BookTickerEntry {
  symbol?: string;
  bidPrice?: string;
  askPrice?: string;
}

const SYMBOL_ENTRIES = Object.entries(BINANCE_SYMBOLS) as [Asset, string | null][];

/** Reverse of BINANCE_SYMBOLS, derived so the two can never drift apart. */
const ASSET_BY_SYMBOL = new Map<string, Asset>(
  SYMBOL_ENTRIES.filter((e): e is [Asset, string] => e[1] !== null).map(
    ([asset, symbol]) => [symbol, asset]
  )
);

/**
 * Assets with no Binance spot listing, whose `spot_price` is null on every row.
 *
 * Surfaced once at startup rather than warned about per tick: at a 5-second
 * cadence a known, permanent gap would otherwise emit ~17k identical warnings a
 * day and bury the transient failures that actually need attention.
 */
export const SPOT_UNLISTED_ASSETS: readonly Asset[] = SYMBOL_ENTRIES
  .filter(([, symbol]) => symbol === null)
  .map(([asset]) => asset);

/** The endpoint takes a JSON array of symbols: symbols=["BTCUSDT",...]. */
const SYMBOLS_PARAM = JSON.stringify([...ASSET_BY_SYMBOL.keys()]);

/** parseFloat, but a missing or unparseable value is null rather than NaN. */
function numOrNull(value: string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn a bookTicker payload into one mid per tracked asset.
 *
 * Pure, so the mapping and the arithmetic are testable without a network.
 * Entries that cannot yield an honest mid are dropped rather than guessed at:
 * a fabricated spot would feed a fabricated distance-from-open straight into
 * the fair-value model, which is worse than a null.
 */
export function parseBookTickers(payload: unknown, fetchedAt: string): Map<Asset, SpotQuote> {
  const mids = new Map<Asset, SpotQuote>();
  if (!Array.isArray(payload)) return mids;

  for (const entry of payload as BookTickerEntry[]) {
    // Binance echoes back only the symbols we asked for, but match explicitly
    // rather than trusting response order or contents.
    const asset = entry?.symbol ? ASSET_BY_SYMBOL.get(entry.symbol) : undefined;
    if (!asset) continue;

    const bid = numOrNull(entry.bidPrice);
    const ask = numOrNull(entry.askPrice);
    if (bid === null || ask === null || bid <= 0 || ask <= 0) continue;

    mids.set(asset, { mid: (bid + ask) / 2, fetchedAt });
  }
  return mids;
}

/**
 * Underlying spot prices from Binance's public REST API. No key, no cache, one
 * request covering every asset Binance lists.
 *
 * Single-source by design. A fallback provider would quietly change what
 * `spot_price` means from row to row, and a column whose source is ambiguous is
 * not usable for the fair-value analysis this exists to feed. That is also why
 * an unlisted asset (see {@link SPOT_UNLISTED_ASSETS}) simply gets no quote
 * rather than one from somewhere else.
 */
export class SpotService {
  /**
   * Best bid/ask mid per asset.
   *
   * Never throws and never retries. This runs inside a 5-second snapshot tick
   * alongside the order book batch, so a spot outage degrades to an empty map
   * immediately - the caller stores nulls and the book capture is untouched.
   * Retrying would spend the tick's budget on the one thing that is optional.
   *
   * Failures log once per tick, at the request, rather than once per market.
   */
  async getSpotMids(): Promise<Map<Asset, SpotQuote>> {
    const url =
      `${BINANCE_API_URL}/api/v3/ticker/bookTicker` +
      `?symbols=${encodeURIComponent(SYMBOLS_PARAM)}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(SPOT_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();

      // Stamped here, with the payload in hand - not at tick start, and not
      // shared with the book timestamp. The difference between the two is the
      // skew the analysis needs to be able to measure per row.
      const fetchedAt = new Date().toISOString();

      const mids = parseBookTickers(payload, fetchedAt);
      if (mids.size === 0) {
        logger.warn('Spot: Binance returned no usable quotes; storing null spot');
      }
      return mids;
    } catch (err) {
      logger.warn(`Spot: fetch failed, storing null spot for this tick: ${err}`);
      return new Map();
    }
  }
}
