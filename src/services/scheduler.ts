import cron from 'node-cron';
import { CRON_FETCH, CRON_DISCOVERY, CRON_LAST_MINUTE, CRON_RESOLUTION_WATCH } from '../config.js';
import type { MarketService } from './market.js';
import { logger } from '../utils/logger.js';

export class Scheduler {
  private fetchJob: cron.ScheduledTask | null = null;
  private discoveryJob: cron.ScheduledTask | null = null;
  private lastMinuteJob: cron.ScheduledTask | null = null;
  private resolutionWatchJob: cron.ScheduledTask | null = null;

  constructor(private market: MarketService) { }

  start(): void {
    this.fetchJob = cron.schedule(CRON_FETCH, () => this.runFetchJob());
    this.discoveryJob = cron.schedule(CRON_DISCOVERY, () => this.runDiscoveryJob());
    this.lastMinuteJob = cron.schedule(CRON_LAST_MINUTE, () => this.runLastMinuteFetchJob());
    this.resolutionWatchJob = cron.schedule(CRON_RESOLUTION_WATCH, () => this.runResolutionWatchJob());
    logger.info('Scheduler started');
  }

  stop(): void {
    this.fetchJob?.stop();
    this.discoveryJob?.stop();
    this.lastMinuteJob?.stop();
    this.resolutionWatchJob?.stop();
    logger.info('Scheduler stopped');
  }

  async runFetchJob(): Promise<void> {
    try {
      await this.market.fetchActiveMarketSnapshots();
    } catch (err) {
      logger.error(`Fetch job error: ${err}`);
    }
  }

  async runDiscoveryJob(): Promise<void> {
    try {
      await this.market.discoverNewMarkets();
    } catch (err) {
      logger.error(`Discovery job error: ${err}`);
    }
  }

  async runLastMinuteFetchJob(): Promise<void> {
    try {
      await this.market.fetchClosingMarketSnapshots();
    } catch (err) {
      logger.error(`Last-minute fetch error: ${err}`);
    }
  }

  async runResolutionWatchJob(): Promise<void> {
    try {
      await this.market.checkResolutions();
    } catch (err) {
      logger.error(`Resolution watch error: ${err}`);
    }
  }
}
