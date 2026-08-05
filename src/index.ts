import {
  DB_PATH,
  TRADING_MODE,
  KILL_SWITCH,
  STAKE_USD,
  WINDOW_MINUTES,
  SNAPSHOT_INTERVAL_SECONDS,
  ASSETS,
} from './config.js';
import { StorageService } from './services/storage.js';
import { PolymarketService } from './services/polymarket.js';
import { MarketService } from './services/market.js';
import { SpotService } from './services/spot.js';
import { TradingService } from './services/trading.js';
import { Scheduler } from './services/scheduler.js';
import { logger } from './utils/logger.js';

const storage = new StorageService();
const polymarket = new PolymarketService();
const spot = new SpotService();
const trading = new TradingService(polymarket, storage);
const market = new MarketService(polymarket, storage, spot, trading);
const scheduler = new Scheduler(market, trading);

function shutdown(): void {
  logger.info('Shutting down...');
  scheduler.stop();
  storage.close();
  logger.info('Goodbye');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main(): Promise<void> {
  logger.info('=== pm-tracker ===');
  logger.info(`DB: ${DB_PATH}`);
  logger.info(
    `Tracking ${ASSETS.join('/')} ${WINDOW_MINUTES}m markets, ` +
    `snapshot every ${SNAPSHOT_INTERVAL_SECONDS}s ` +
    `(~${Math.floor((WINDOW_MINUTES * 60) / SNAPSHOT_INTERVAL_SECONDS)} per window)`
  );

  if (KILL_SWITCH) {
    logger.warn('Trading: KILL_SWITCH set - trading disabled regardless of mode');
  } else if (TRADING_MODE === 'live') {
    logger.warn(`!!! Trading: LIVE MODE - real orders, real funds, $${STAKE_USD} per trade !!!`);
  } else if (TRADING_MODE === 'paper') {
    logger.info(`Trading: paper mode, $${STAKE_USD} simulated stake per trade`);
  } else {
    logger.info('Trading: off');
  }

  // Before anything else can place a new order: resolve any live trade left
  // open by a previous run. A no-op unless mode is live and such trades exist.
  try {
    await trading.reconcileOpenTrades();
  } catch (err) {
    logger.error(`Reconcile: failed: ${err}`);
  }

  // Initial discovery
  logger.info('Running initial discovery...');
  await market.discoverNewMarkets();

  // Initial fetch
  logger.info('Running initial fetch...');
  await market.fetchActiveMarketSnapshots();

  // Start scheduler
  scheduler.start();

  logger.info('Tracker running, press Ctrl+C to stop');
}

main().catch((err) => {
  logger.error(`Startup error: ${err}`);
  process.exit(1);
});
