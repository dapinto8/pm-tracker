import cron from 'node-cron';
import { CRON_FETCH, CRON_DISCOVERY, CRON_OUTCOME_CHECK } from '../config.js';
import type { PolymarketService } from './polymarket.js';
import type { StorageService } from './storage.js';
import type { MarketDiscoveryService } from './market-discovery.js';
import { logger } from '../utils/logger.js';

export class Scheduler {
  private fetchJob: cron.ScheduledTask | null = null;
  private discoveryJob: cron.ScheduledTask | null = null;
  private outcomeJob: cron.ScheduledTask | null = null;

  constructor(
    private polymarket: PolymarketService,
    private storage: StorageService,
    private discovery: MarketDiscoveryService
  ) { }

  start(): void {
    this.fetchJob = cron.schedule(CRON_FETCH, () => this.runFetchJob());
    this.discoveryJob = cron.schedule(CRON_DISCOVERY, () => this.runDiscoveryJob());
    this.outcomeJob = cron.schedule(CRON_OUTCOME_CHECK, () => this.runOutcomeCheckJob());

    logger.info(`Scheduler started - fetch: ${CRON_FETCH}, discovery: ${CRON_DISCOVERY}, outcome: ${CRON_OUTCOME_CHECK}`);
  }

  stop(): void {
    this.fetchJob?.stop();
    this.discoveryJob?.stop();
    this.outcomeJob?.stop();
    logger.info('Scheduler stopped');
  }

  async runFetchJob(): Promise<void> {
    try {
      const markets = this.discovery.getActiveMarkets();
      if (markets.length === 0) {
        logger.debug('Fetch: no active markets');
        return;
      }

      const now = new Date();
      const fetchedAt = now.toISOString();
      let saved = 0;

      for (const market of markets) {
        // Minutes elapsed since hour started (0-59)
        const marketStart = new Date(market.eventStartTime);
        const minuteOfHour = Math.floor((now.getTime() - marketStart.getTime()) / 60000);

        const [prices, midpoint, spreadData, gm] = await Promise.all([
          this.polymarket.getPrices([market.tokenIdUp, market.tokenIdDown]),
          this.polymarket.getMidpoint(market.tokenIdUp),
          this.polymarket.getSpread(market.tokenIdUp),
          this.polymarket.getMarketBySlug(market.slug),
        ]);

        const upPrice = prices.get(market.tokenIdUp) ?? 0;
        const downPrice = prices.get(market.tokenIdDown) ?? 0;

        this.storage.insertSnapshot({
          marketId: market.id,
          fetchedAt,
          minuteOfHour,
          upPrice,
          downPrice,
          upBid: spreadData?.bid ?? null,
          upAsk: spreadData?.ask ?? null,
          spread: spreadData?.spread ?? null,
          midpoint: midpoint ?? null,
          lastTradePrice: gm?.lastTradePrice ?? null,
          volume24h: gm?.volume24hr ?? null,
        });
        saved++;
      }

      logger.info(`Fetch: saved ${saved} snapshots for ${markets.length} markets`);
    } catch (err) {
      logger.error(`Fetch job error: ${err}`);
    }
  }

  async runDiscoveryJob(): Promise<void> {
    try {
      const newMarkets = await this.discovery.discoverNewMarkets();
      logger.info(`Discovery job: found ${newMarkets.length} new markets`);
    } catch (err) {
      logger.error(`Discovery job error: ${err}`);
    }
  }

  async runOutcomeCheckJob(): Promise<void> {
    try {
      const updated = await this.discovery.updateMarketOutcomes();
      logger.info(`Outcome check: updated ${updated} markets`);
    } catch (err) {
      logger.error(`Outcome check error: ${err}`);
    }
  }
}
