import {
  ENTRY_MIN_ASK,
  ENTRY_MAX_ASK,
  MAX_BOOK_SPREAD,
  SHARE_DECIMALS,
} from '../config.js';
import type { BookTop, TradeSide } from '../models/types.js';

/**
 * Strategy "favorite-late".
 *
 * Shortly before the window closes, buy the favorite (midpoint >= 0.5) and
 * hold to resolution. Derived from a backtest of 7,766 resolved HOURLY markets
 * entering at minute 55: 96.7% win rate, ~+2.8% ROI per trade at midpoint.
 * Break-even sits at ~2.6 cents of one-way execution cost, so the price band
 * and spread guard below are what keep the edge alive - above ~3c of spread
 * the edge is gone.
 *
 * WARNING: the tracker now follows 5-MINUTE markets. That backtest has not
 * been re-run on this series, and a 300s window is not a 3600s window scaled
 * down: less time for the favorite to hold, thinner books, and the same
 * execution cost spread over a shorter horizon. The thresholds here are
 * inherited, not validated. Collect data before trusting them.
 *
 * This module is deliberately pure: no network, no clock, no database. All
 * inputs are passed in so the entry decision can be unit tested.
 */

export interface EntryThresholds {
  /** Inclusive lower bound on the favorite's best ask. */
  minAsk: number;
  /** Exclusive upper bound on the favorite's best ask. */
  maxAsk: number;
  /** Maximum tolerated (bestAsk - bestBid) on the favorite's book. */
  maxSpread: number;
  /** Decimal places to round share count down to. */
  shareDecimals: number;
}

export const DEFAULT_THRESHOLDS: EntryThresholds = {
  minAsk: ENTRY_MIN_ASK,
  maxAsk: ENTRY_MAX_ASK,
  maxSpread: MAX_BOOK_SPREAD,
  shareDecimals: SHARE_DECIMALS,
};

export interface EntryInput {
  up: BookTop;
  down: BookTop;
  stakeUsd: number;
}

export interface EntryPlan {
  side: TradeSide;
  /** Best ask on the favorite - the price we will pay. */
  entryPrice: number;
  spread: number;
  askSize: number;
  shares: number;
  stakeUsd: number;
}

export type EntryDecision =
  | { enter: true; plan: EntryPlan }
  | { enter: false; reason: string };

/** Midpoint, or null if either side of the book is empty. */
export function midpointOf(book: BookTop): number | null {
  if (book.bid === null || book.ask === null) return null;
  return (book.bid + book.ask) / 2;
}

/** A book with both sides quoted - what every check below assumes. */
interface TwoSidedBook {
  bid: number;
  ask: number;
  askSize: number | null;
  spread: number;
}

/**
 * Narrow a book to one with both sides present, or null if it is one-sided.
 *
 * Null and 0 are both treated as "no quote": null is an empty side, and a
 * resting order at 0 does not exist on this venue. Rejecting both keeps the
 * behaviour identical to the pre-nullable version, which only ever saw 0.
 */
function twoSided(book: BookTop): TwoSidedBook | null {
  const { bid, ask } = book;
  if (bid === null || ask === null || bid <= 0 || ask <= 0) return null;
  return { bid, ask, askSize: book.askSize, spread: book.spread ?? ask - bid };
}

/** Round down so we never try to take more than what rests at the top of book. */
export function roundShares(shares: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(shares * factor) / factor;
}

/**
 * Decide whether to enter, given both sides' top of book.
 * Returns the reason for declining so the caller can log it.
 */
export function evaluateEntry(
  input: EntryInput,
  thresholds: EntryThresholds = DEFAULT_THRESHOLDS
): EntryDecision {
  const { up, down, stakeUsd } = input;

  if (stakeUsd <= 0) {
    return { enter: false, reason: `stake must be positive (got ${stakeUsd})` };
  }

  const upBook = twoSided(up);
  if (!upBook) {
    return { enter: false, reason: `up book is one-sided or empty` };
  }
  const downBook = twoSided(down);
  if (!downBook) {
    return { enter: false, reason: `down book is one-sided or empty` };
  }

  const upMid = (upBook.bid + upBook.ask) / 2;
  const downMid = (downBook.bid + downBook.ask) / 2;

  // Favorite = the side whose midpoint is at or above 0.5. If a crossed or
  // stale book puts both above 0.5, take the higher one.
  let side: TradeSide;
  if (upMid >= 0.5 && downMid >= 0.5) {
    side = upMid >= downMid ? 'UP' : 'DOWN';
  } else if (upMid >= 0.5) {
    side = 'UP';
  } else if (downMid >= 0.5) {
    side = 'DOWN';
  } else {
    return {
      enter: false,
      reason: `no favorite: up mid=${upMid.toFixed(4)} down mid=${downMid.toFixed(4)}`,
    };
  }

  const book = side === 'UP' ? upBook : downBook;
  const entryPrice = book.ask;

  if (entryPrice < thresholds.minAsk || entryPrice >= thresholds.maxAsk) {
    return {
      enter: false,
      reason: `${side} ask ${entryPrice.toFixed(4)} outside [${thresholds.minAsk}, ${thresholds.maxAsk})`,
    };
  }

  if (book.spread > thresholds.maxSpread) {
    return {
      enter: false,
      reason: `${side} spread ${book.spread.toFixed(4)} > ${thresholds.maxSpread}`,
    };
  }

  const shares = roundShares(stakeUsd / entryPrice, thresholds.shareDecimals);
  if (shares <= 0) {
    return { enter: false, reason: `computed share size rounds to zero` };
  }

  if (book.askSize === null || book.askSize < shares) {
    return {
      enter: false,
      reason: `${side} ask size ${book.askSize ?? 'unknown'} < required ${shares} shares`,
    };
  }

  return {
    enter: true,
    plan: {
      side,
      entryPrice,
      spread: book.spread,
      askSize: book.askSize,
      shares,
      stakeUsd: shares * entryPrice,
    },
  };
}

/** pnl for a settled position: shares held to resolution pay $1 if right, $0 if wrong. */
export function settlePnl(shares: number, entryPrice: number, won: boolean): number {
  return won ? shares * (1 - entryPrice) : -shares * entryPrice;
}

export interface FillOutcome {
  status: 'filled' | 'cancelled';
  /** Shares actually acquired. 0 when nothing matched. */
  shares: number;
  /** What those shares actually cost. */
  stakeUsd: number;
  /** True when only part of the intended size was acquired. */
  partial: boolean;
}

/**
 * Turn "how much of the order matched" into the position we actually hold.
 *
 * A PARTIAL match is a real position holding real money. Treating it as a
 * cancel - which is what happens if you only accept `matched >= plan.shares` -
 * leaves an unsettled position on the exchange that the trades table never
 * knows about. So anything above zero is recorded as `filled`, sized to what
 * actually matched.
 *
 * A full fill keeps the plan's numbers untouched; only a partial recomputes,
 * because only then do shares and stake differ from what was intended.
 */
export function resolveFill(
  plan: EntryPlan,
  matchedShares: number,
  fillPrice: number | null
): FillOutcome {
  const matched = Number.isFinite(matchedShares) && matchedShares > 0 ? matchedShares : 0;

  if (matched <= 0) {
    return { status: 'cancelled', shares: 0, stakeUsd: 0, partial: false };
  }
  if (matched >= plan.shares) {
    return { status: 'filled', shares: plan.shares, stakeUsd: plan.stakeUsd, partial: false };
  }

  // Price actually paid, falling back to the limit price we posted at - a GTC
  // buy can only fill at or below it, so this is a conservative cost estimate.
  const price = fillPrice ?? plan.entryPrice;
  return { status: 'filled', shares: matched, stakeUsd: matched * price, partial: true };
}

/**
 * Whether the daily loss limit is breached, counting money still at risk.
 *
 * Realized pnl alone understates the worst case: with all three assets closing
 * on the same 5-minute boundaries, several stakes can be in flight and
 * unsettled when this is checked. Every open position is treated as a total
 * loss, which is exactly what it is if the market resolves against us.
 */
export function isLossLimitBreached(
  realizedPnl: number,
  openExposureUsd: number,
  limitUsd: number
): boolean {
  return realizedPnl - openExposureUsd <= -limitUsd;
}
