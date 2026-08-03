export type Asset = 'BTC' | 'ETH' | 'SOL';

export type SeriesSlug =
  | 'btc-up-or-down-5m'
  | 'eth-up-or-down-5m'
  | 'sol-up-or-down-5m';

export interface AssetConfig {
  asset: Asset;
  seriesSlug: SeriesSlug;
  slugPrefix: string;
}

/**
 * One up/down market covering a fixed time window.
 *
 * `windowStart`/`windowEnd` persist to the legacy `hour_start`/`hour_end`
 * columns - the table predates the move to 5-minute windows and migrations
 * here are additive only, so the column names stayed put. Use
 * `durationMinutes` to tell the series apart (null on rows written before the
 * column existed, which were all hourly).
 */
export interface TrackedMarket {
  id: string;
  conditionId: string;
  tokenIdUp: string;
  tokenIdDown: string;
  asset: Asset;
  question: string;
  eventStartTime: string;
  windowStart: string;
  windowEnd: string;
  durationMinutes: number | null;
  outcome: 'UP' | 'DOWN' | null;
  slug: string;
  seriesSlug: string;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: string;
  marketId: string;
  fetchedAt: string;
  /** Whole minutes since the window opened. Kept for continuity with hourly rows. */
  minuteOfHour: number;
  /** Seconds since the window opened - the useful resolution for 5m markets. */
  secondOfWindow: number | null;
  /**
   * Best bid on each side, or null when that side of the book is empty.
   * Null is the only representation of "no quote" - never 0, which would be
   * indistinguishable from a real price.
   */
  upPrice: number | null;
  downPrice: number | null;
  upBid: number | null;
  upAsk: number | null;
  upBidSize: number | null;
  upAskSize: number | null;
  spread: number | null;
  midpoint: number | null;
  lastTradePrice: number | null;
  volume24h: number | null;
}

/**
 * Top of the order book for a single token.
 *
 * Polymarket's CLOB returns bids sorted ascending and asks sorted descending,
 * so the best quotes are the LAST elements of each array.
 *
 * Every field is nullable because a side of the book can be genuinely EMPTY -
 * common in the final seconds of a window once the outcome is near-certain and
 * nobody is left quoting the losing side. Null means "no quote on that side";
 * it must never be conflated with a price of 0, which is a real (if unlikely)
 * quote. `spread` is null unless BOTH sides are present, so an absent side can
 * never masquerade as a tight book.
 */
export interface BookTop {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  spread: number | null;
}

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  startDate: string;
  endDate: string;
  eventStartTime: string;
  active: boolean;
  closed: boolean;
  volume: number;
  liquidity: number;
  clobTokenIds: string;
  seriesSlug: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  lastTradePrice: number;
  volume24hr: number;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
}

export interface PriceHistoryPoint {
  t: number;
  p: number;
}

// === Trading ===

export type TradingMode = 'off' | 'paper' | 'live';

export type TradeSide = 'UP' | 'DOWN';

/**
 * open      - live order posted, not yet filled
 * filled    - position held, awaiting market resolution
 * cancelled - live order was not filled in time and was pulled; no position
 * settled   - market resolved and pnl recorded
 * failed    - order placement errored; no position
 */
export type TradeStatus = 'open' | 'filled' | 'cancelled' | 'settled' | 'failed';

export interface Trade {
  id: string;
  mode: Exclude<TradingMode, 'off'>;
  marketId: string;
  side: TradeSide;
  entryPrice: number;
  spreadAtEntry: number;
  askSizeAtEntry: number;
  shares: number;
  stakeUsd: number;
  enteredAt: string;
  orderId: string | null;
  fillPrice: number | null;
  outcome: TradeSide | null;
  pnl: number | null;
  settledAt: string | null;
  status: TradeStatus;
}
