import 'dotenv/config';
import type { AssetConfig, TradingMode } from './models/types.js';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${name}: ${raw}`);
  }
  return parsed;
}

// API URLs
export const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
export const CLOB_API_URL = 'https://clob.polymarket.com';
export const CHAIN_ID = 137;
export const BINANCE_API_URL = 'https://api.binance.com';

/** Public data API - the only host that serves executed trades. */
export const DATA_API_URL = 'https://data-api.polymarket.com';

// Assets
export const ASSETS = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'BNB'] as const;
export type Asset = typeof ASSETS[number];

// Asset configuration for market discovery.
//
// These are the 5-minute up/down series, e.g. btc-updown-5m-1785774300. Every
// prefix below was verified against the live Gamma API on 2026-08-12: all six
// series are active and all six follow the same `<coin>-updown-5m-<epoch>`
// event slug under a `<coin>-up-or-down-5m` series slug, with no exceptions.
export const ASSET_CONFIG: Record<Asset, AssetConfig> = {
  BTC: {
    asset: 'BTC',
    seriesSlug: 'btc-up-or-down-5m',
    slugPrefix: 'btc-updown-5m',
  },
  ETH: {
    asset: 'ETH',
    seriesSlug: 'eth-up-or-down-5m',
    slugPrefix: 'eth-updown-5m',
  },
  SOL: {
    asset: 'SOL',
    seriesSlug: 'sol-up-or-down-5m',
    slugPrefix: 'sol-updown-5m',
  },
  // Hyperliquid. Titled "Hyperliquid Up or Down" upstream, but the slug uses
  // the ticker like every other series.
  HYPE: {
    asset: 'HYPE',
    seriesSlug: 'hype-up-or-down-5m',
    slugPrefix: 'hype-updown-5m',
  },
  DOGE: {
    asset: 'DOGE',
    seriesSlug: 'doge-up-or-down-5m',
    slugPrefix: 'doge-updown-5m',
  },
  BNB: {
    asset: 'BNB',
    seriesSlug: 'bnb-up-or-down-5m',
    slugPrefix: 'bnb-updown-5m',
  },
};

/**
 * Binance symbol for each tracked asset's underlying, or null where the coin
 * has no Binance spot listing.
 *
 * Binance is a proxy for the feed these markets actually resolve against
 * (Chainlink), chosen because it is free and unauthenticated. The public
 * bookTicker endpoint takes every symbol in one request, so capturing spot
 * costs exactly one extra call per snapshot tick regardless of asset count.
 *
 * Typed as an exhaustive record rather than a partial one so that adding an
 * asset forces an explicit decision here: a symbol, or null with a reason. A
 * missing entry would otherwise degrade silently into a permanently null spot
 * column that nobody notices until the analysis needs it.
 */
export const BINANCE_SYMBOLS: Record<Asset, string | null> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  // Hyperliquid is not listed on Binance spot. Its snapshots carry a null
  // spot_price by design; a second price source is deliberately NOT added,
  // because a column whose provenance varies row to row is not usable for the
  // fair-value work this exists to feed.
  HYPE: null,
  DOGE: 'DOGEUSDT',
  BNB: 'BNBUSDT',
};

/**
 * Hard ceiling on the spot request.
 *
 * Not env-tunable on purpose: this call rides alongside the order book batch in
 * a 5-second tick, and a timeout anywhere near the tick interval would let a
 * slow Binance delay the book capture that is the point of the whole service.
 */
export const SPOT_TIMEOUT_MS = 2_000;

// ============ Trade tape ============
// Executed trades, pulled once per market after it resolves. This runs on the
// resolution watcher, never on the snapshot path, so its budget is generous
// where the spot request's is not.

/**
 * Page size for GET /trades. The endpoint clamps `limit` at 10,000; 1,000 keeps
 * each response around 700KB while covering the busiest observed 5m market
 * (~4,700 prints) in five requests.
 */
export const TAPE_PAGE_SIZE = 1_000;

/**
 * The data API rejects `offset` past 10,000 with a 400 rather than clamping it,
 * so paging stops here and the tape is recorded as truncated. Reading deeper
 * would mean windowing on start/end, which no 5m market has ever needed.
 */
export const TAPE_MAX_OFFSET = 10_000;

/** Per-page ceiling. Long, because nothing time-critical is waiting on it. */
export const TAPE_TIMEOUT_MS = 15_000;

/** Markets whose tape is attempted per resolution cycle. */
export const TAPE_BACKLOG_LIMIT = envNumber('TAPE_BACKLOG_LIMIT', 25);

/**
 * How far back the backlog will reach for a market still owed a tape.
 *
 * This bounds a RETRY queue, not a backfill. Without it, the first run against
 * an existing database would treat every market ever resolved as owed - 5,373
 * of them at the time of writing, several million prints - and spend hours
 * crawling history nobody asked for. Raise it (or set it very large for one
 * run) to deliberately backfill.
 */
export const TAPE_BACKLOG_LOOKBACK_HOURS = envNumber('TAPE_BACKLOG_LOOKBACK_HOURS', 24);

// Market window
export const WINDOW_MINUTES = envNumber('WINDOW_MINUTES', 5);
export const WINDOW_SECONDS = WINDOW_MINUTES * 60;

// Discovery: how many upcoming windows to look ahead (default ~1 hour).
export const DISCOVERY_WINDOWS_AHEAD = envNumber('DISCOVERY_WINDOWS_AHEAD', 12);

/**
 * Snapshot cadence in seconds. A 5-minute market lives for 300s, so the
 * default of 5s yields ~60 snapshots per market. Must divide 60.
 */
export const SNAPSHOT_INTERVAL_SECONDS = envNumber('SNAPSHOT_INTERVAL_SECONDS', 5);

// Cron expressions
export const CRON_FETCH = `*/${SNAPSHOT_INTERVAL_SECONDS} * * * * *`;
export const CRON_DISCOVERY = '*/5 * * * *';         // every 5 min
export const CRON_RESOLUTION_WATCH = '*/2 * * * *';  // every 2 min (resolution lags ~5 min)
export const CRON_TRADING = '*/15 * * * * *';        // every 15s; gated on time-to-close

// Database
export const DB_PATH = process.env.DB_PATH ?? './data/tracker.db';

// Retry config
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;

// ============ Trading ============
// Everything here is inert unless TRADING_MODE is set to 'paper' or 'live'.

const RAW_TRADING_MODE = (process.env.TRADING_MODE ?? 'off').toLowerCase();
export const TRADING_MODE: TradingMode =
  RAW_TRADING_MODE === 'paper' || RAW_TRADING_MODE === 'live' ? RAW_TRADING_MODE : 'off';

/** Any non-empty value refuses all trading, regardless of mode. */
export const KILL_SWITCH = Boolean(process.env.KILL_SWITCH && process.env.KILL_SWITCH !== '0');

// Strategy "favorite-late": buy the favorite shortly before close and hold to
// resolution.
//
// WARNING: the thresholds below come from a backtest of 7,766 resolved HOURLY
// markets (96.7% win rate, ~+2.8% ROI/trade at midpoint, break-even at ~2.6c of
// one-way execution cost). That backtest has NOT been re-run on the 5-minute
// series this tracker now follows. Treat these numbers as unvalidated here.
export const ENTRY_MIN_ASK = envNumber('ENTRY_MIN_ASK', 0.90);   // inclusive
export const ENTRY_MAX_ASK = envNumber('ENTRY_MAX_ASK', 0.97);   // exclusive
export const MAX_BOOK_SPREAD = envNumber('MAX_BOOK_SPREAD', 0.03);

/**
 * Enter this many seconds before the window closes. The hourly strategy entered
 * at minute 55 of 60 - the final ~8% of the window. For a 300s window the same
 * fraction is ~25s; the default of 30s is the nearest round equivalent.
 */
export const TRADING_ENTRY_LEAD_SECONDS = envNumber('TRADING_ENTRY_LEAD_SECONDS', 30);

// Risk controls
export const STAKE_USD = envNumber('STAKE_USD', 100);
export const MAX_TRADES_PER_DAY = envNumber('MAX_TRADES_PER_DAY', 10);
export const DAILY_LOSS_LIMIT_USD = envNumber('DAILY_LOSS_LIMIT_USD', 300);

/** Taker fees above this erase the edge, so live trading refuses to run. */
export const MAX_FEE_RATE_BPS = envNumber('MAX_FEE_RATE_BPS', 100);

// Live order execution
export const ORDER_FILL_TIMEOUT_MS = envNumber('ORDER_FILL_TIMEOUT_MS', 60_000);
export const ORDER_POLL_INTERVAL_MS = envNumber('ORDER_POLL_INTERVAL_MS', 3_000);

/** Shares are rounded down to this many decimals so we never exceed top-of-book size. */
export const SHARE_DECIMALS = 2;

// Wallet auth (live mode only)
export const POLY_PRIVATE_KEY = process.env.POLY_PRIVATE_KEY ?? '';
export const POLY_FUNDER_ADDRESS = process.env.POLY_FUNDER_ADDRESS ?? '';