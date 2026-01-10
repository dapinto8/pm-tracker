import 'dotenv/config';
import type { AssetConfig } from './models/types.js';

// API URLs
export const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
export const CLOB_API_URL = 'https://clob.polymarket.com';
export const CHAIN_ID = 137;

// Assets
export const ASSETS = ['BTC', 'ETH', 'SOL'] as const;
export type Asset = typeof ASSETS[number];

// Asset configuration for market discovery
export const ASSET_CONFIG: Record<Asset, AssetConfig> = {
  BTC: {
    asset: 'BTC',
    seriesSlug: 'bitcoin-up-or-down-hourly',
    slugPrefix: 'bitcoin-up-or-down',
  },
  ETH: {
    asset: 'ETH',
    seriesSlug: 'ethereum-up-or-down-hourly',
    slugPrefix: 'ethereum-up-or-down',
  },
  SOL: {
    asset: 'SOL',
    seriesSlug: 'solana-up-or-down-hourly',
    slugPrefix: 'solana-up-or-down',
  },
};

// Discovery config
export const DISCOVERY_HOURS_AHEAD = 24;

// Cron expressions
export const CRON_FETCH = '*/10 * * * *';        // every 10 min
export const CRON_DISCOVERY = '5 * * * *';       // every hour at :05
export const CRON_OUTCOME_CHECK = '*/5 * * * *'; // every 5 min

// Database
export const DB_PATH = process.env.DB_PATH ?? './data/tracker.db';

// Retry config
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;
