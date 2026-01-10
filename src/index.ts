import { DB_PATH, CRON_FETCH, CRON_DISCOVERY, CRON_OUTCOME_CHECK } from './config.js';
import { StorageService } from './services/storage.js';
import { PolymarketService } from './services/polymarket.js';
import { MarketDiscoveryService } from './services/market-discovery.js';
import { Scheduler } from './services/scheduler.js';
import { logger } from './utils/logger.js';

const storage = new StorageService();
const polymarket = new PolymarketService();
const discovery = new MarketDiscoveryService(polymarket, storage);
const scheduler = new Scheduler(polymarket, storage, discovery);

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
  logger.info(`Cron: fetch=${CRON_FETCH}, discovery=${CRON_DISCOVERY}, outcome=${CRON_OUTCOME_CHECK}`);

  // Initial discovery
  logger.info('Running initial discovery...');
  await discovery.discoverNewMarkets();

  // Initial fetch
  logger.info('Running initial fetch...');
  await scheduler.runFetchJob();

  // Start scheduler
  scheduler.start();

  logger.info('Tracker running, press Ctrl+C to stop');
}

main().catch((err) => {
  logger.error(`Startup error: ${err}`);
  process.exit(1);
});
