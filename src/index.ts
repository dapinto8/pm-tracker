import { DB_PATH } from './config.js';
import { StorageService } from './services/storage.js';
import { PolymarketService } from './services/polymarket.js';
import { MarketService } from './services/market.js';
import { Scheduler } from './services/scheduler.js';
import { logger } from './utils/logger.js';

const storage = new StorageService();
const polymarket = new PolymarketService();
const market = new MarketService(polymarket, storage);
const scheduler = new Scheduler(market);

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
