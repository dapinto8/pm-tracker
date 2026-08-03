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

// Assets
export const ASSETS = ['BTC', 'ETH', 'SOL'] as const;
export type Asset = typeof ASSETS[number];

// Asset configuration for market discovery.
// These are the 5-minute up/down series, e.g. btc-updown-5m-1785774300.
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
};

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