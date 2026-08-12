import {
  DATA_API_URL,
  TAPE_MAX_OFFSET,
  TAPE_PAGE_SIZE,
  TAPE_TIMEOUT_MS,
} from '../config.js';
import type { TrackedMarket, TradeTapeEntry } from '../models/types.js';
import { logger } from '../utils/logger.js';

/**
 * One row of the public data API's `GET /trades` response.
 *
 * Every field is optional here because the payload is untrusted input: the
 * shape below is what was observed, not what is guaranteed.
 */
export interface DataApiTrade {
  /** CLOB token id of the side that traded - matches one of the market's two. */
  asset?: string;
  /** BUY or SELL, from the TAKER's perspective (see the takerOnly note below). */
  side?: string;
  size?: number | string;
  price?: number | string;
  /** Unix SECONDS, not milliseconds. */
  timestamp?: number | string;
  transactionHash?: string;
}

/** Outcome of parsing one page: what was usable, and what was not. */
export interface ParsedPage {
  entries: TradeTapeEntry[];
  dropped: number;
}

export interface MarketTape {
  entries: TradeTapeEntry[];
  dropped: number;
  /** True when the offset ceiling was hit before the tape ran out. */
  truncated: boolean;
  pages: number;
}

/** Number from either a JSON number or a numeric string; null if neither. */
function numOrNull(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Stable identity for a print.
 *
 * The data API exposes no trade id, so one is synthesized. The transaction hash
 * alone was unique across every row of five sampled markets (6,353 prints, zero
 * collisions), but the token, size and price are folded in anyway: a single
 * transaction carrying two distinct fills is cheap to survive and expensive to
 * discover later, since the loser would be silently dropped by the unique index
 * and the tape would simply be missing a trade.
 *
 * Only ever built from values already parsed to numbers, so re-fetching the
 * same trade yields a byte-identical id no matter how the API formats it.
 */
export function externalIdOf(
  transactionHash: string,
  tokenId: string,
  size: number,
  price: number
): string {
  return `${transactionHash}:${tokenId}:${size}:${price}`;
}

/**
 * Turn one page of the response into tape entries for `market`.
 *
 * Pure, so parsing and pagination are testable without a network. A row that
 * cannot be represented honestly is dropped and counted rather than patched:
 * the point of this table is real prints, and a repaired one is not a print.
 */
export function parseTradePage(payload: unknown, market: TrackedMarket): ParsedPage {
  const entries: TradeTapeEntry[] = [];
  let dropped = 0;
  if (!Array.isArray(payload)) return { entries, dropped };

  for (const raw of payload as DataApiTrade[]) {
    const entry = parseTrade(raw, market);
    if (entry) entries.push(entry);
    else dropped++;
  }
  return { entries, dropped };
}

function parseTrade(raw: DataApiTrade, market: TrackedMarket): TradeTapeEntry | null {
  if (!raw || typeof raw !== 'object') return null;

  // Resolved from the token id, never from the response's `outcome` label. The
  // two agreed on all 6,353 sampled rows, but the id is what the market is
  // actually defined by and the label is prose.
  const tokenSide =
    raw.asset === market.tokenIdUp ? 'UP' : raw.asset === market.tokenIdDown ? 'DOWN' : null;
  if (!tokenSide) return null;

  const price = numOrNull(raw.price);
  const size = numOrNull(raw.size);
  // A share price outside [0, 1] is not a price on a binary market, and a
  // non-positive size is not a fill. Either one would poison a maker
  // simulation more quietly than a missing row would.
  if (price === null || price < 0 || price > 1) return null;
  if (size === null || size <= 0) return null;

  const timestamp = numOrNull(raw.timestamp);
  if (timestamp === null || timestamp <= 0) return null;

  // No hash means no stable id, and no stable id means a re-fetch would
  // duplicate the row instead of ignoring it.
  if (!raw.transactionHash) return null;

  const side = typeof raw.side === 'string' ? raw.side.toUpperCase() : null;

  return {
    marketId: market.id,
    tokenSide,
    price,
    size,
    takerSide: side === 'BUY' || side === 'SELL' ? side : null,
    tradedAt: new Date(timestamp * 1000).toISOString(),
    externalId: externalIdOf(raw.transactionHash, raw.asset as string, size, price),
  };
}

/**
 * Executed trades for a resolved market, from Polymarket's public data API.
 *
 * Runs on the resolution watcher, never on the snapshot path. Nothing here is
 * time-critical: a market that has already settled is immutable, so a tape
 * missed now is identical to the same tape fetched an hour later.
 */
export class TapeService {
  /**
   * The complete tape for one market, paging until the API runs out.
   *
   * Returns null on ANY page failure - deliberately all-or-nothing. A partial
   * tape recorded as complete is indistinguishable from a quiet market, which
   * is exactly the kind of error a fill simulation would swallow and act on.
   * The caller leaves `tape_fetched_at` null and the next cycle starts over;
   * the pages that did land are re-offered and ignored by the unique index.
   */
  async fetchMarketTape(market: TrackedMarket): Promise<MarketTape | null> {
    const entries: TradeTapeEntry[] = [];
    let dropped = 0;
    let truncated = false;
    let pages = 0;
    let offset = 0;

    for (;;) {
      const page = await this.fetchPage(market, offset);
      if (page === null) return null;

      pages++;
      const parsed = parseTradePage(page, market);
      entries.push(...parsed.entries);
      dropped += parsed.dropped;

      // A short page is the end of the tape. Only a full one implies more.
      if (page.length < TAPE_PAGE_SIZE) break;

      offset += TAPE_PAGE_SIZE;
      if (offset > TAPE_MAX_OFFSET) {
        truncated = true;
        break;
      }
    }

    if (dropped > 0) {
      logger.warn(`Tape: ${market.slug} dropped ${dropped} unusable row(s) of ${entries.length + dropped}`);
    }
    if (truncated) {
      // Not a failure and not retryable - the API will not serve past this
      // offset for any request. Recorded as fetched, and said out loud.
      logger.warn(
        `Tape: ${market.slug} truncated at the API's offset ceiling ` +
        `(${TAPE_MAX_OFFSET}); tape holds ${entries.length} of an unknown total`
      );
    }
    return { entries, dropped, truncated, pages };
  }

  /** One page, or null if it could not be read as one. */
  private async fetchPage(market: TrackedMarket, offset: number): Promise<unknown[] | null> {
    const url =
      `${DATA_API_URL}/trades` +
      `?market=${encodeURIComponent(market.conditionId)}` +
      `&limit=${TAPE_PAGE_SIZE}&offset=${offset}` +
      // One row per print. With takerOnly=false the same print reappears once
      // per maker it matched against, which would inflate traded volume.
      `&takerOnly=true`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TAPE_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      // An unexpected shape is a failure, not an empty tape: reading it as the
      // latter would mark the market fetched and lose its trades for good.
      if (!Array.isArray(body)) throw new Error('expected a JSON array');
      return body;
    } catch (err) {
      logger.warn(`Tape: ${market.slug} page at offset ${offset} failed: ${err}`);
      return null;
    }
  }
}
