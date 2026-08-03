import cron from 'node-cron';
import {
  CRON_FETCH,
  CRON_DISCOVERY,
  CRON_RESOLUTION_WATCH,
  CRON_TRADING,
} from '../config.js';
import type { MarketService } from './market.js';
import type { TradingService } from './trading.js';
import { logger } from '../utils/logger.js';

export class Scheduler {
  private fetchJob: cron.ScheduledTask | null = null;
  private discoveryJob: cron.ScheduledTask | null = null;
  private resolutionWatchJob: cron.ScheduledTask | null = null;
  private tradingJob: cron.ScheduledTask | null = null;

  /**
   * Jobs currently mid-run. The fetch job fires every few seconds; if a tick
   * runs long (slow upstream, retries) the next one must not pile on top of it.
   */
  private running = new Set<string>();

  constructor(
    private market: MarketService,
    private trading?: TradingService
  ) { }

  start(): void {
    this.fetchJob = cron.schedule(CRON_FETCH, () => this.runFetchJob());
    this.discoveryJob = cron.schedule(CRON_DISCOVERY, () => this.runDiscoveryJob());
    this.resolutionWatchJob = cron.schedule(CRON_RESOLUTION_WATCH, () => this.runResolutionWatchJob());
    if (this.trading) {
      // Independent of the snapshot jobs on purpose: a trading failure must
      // never interfere with tracking.
      this.tradingJob = cron.schedule(CRON_TRADING, () => this.runTradingJob());
    }
    logger.info(
      `Scheduler started (fetch="${CRON_FETCH}", discovery="${CRON_DISCOVERY}", ` +
      `resolution="${CRON_RESOLUTION_WATCH}"${this.trading ? `, trading="${CRON_TRADING}"` : ''})`
    );
  }

  stop(): void {
    this.fetchJob?.stop();
    this.discoveryJob?.stop();
    this.resolutionWatchJob?.stop();
    this.tradingJob?.stop();
    logger.info('Scheduler stopped');
  }

  /** Run `fn` unless a previous run of the same job is still in flight. */
  private async guard(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.running.has(name)) {
      logger.warn(`${name} job still running, skipping this tick`);
      return;
    }
    this.running.add(name);
    try {
      await fn();
    } catch (err) {
      logger.error(`${name} job error: ${err}`);
    } finally {
      this.running.delete(name);
    }
  }

  async runFetchJob(): Promise<void> {
    await this.guard('Fetch', () => this.market.fetchActiveMarketSnapshots());
  }

  async runDiscoveryJob(): Promise<void> {
    await this.guard('Discovery', async () => {
      await this.market.discoverNewMarkets();
    });
  }

  async runResolutionWatchJob(): Promise<void> {
    await this.guard('Resolution', () => this.market.checkResolutions());
  }

  async runTradingJob(): Promise<void> {
    await this.guard('Trading', async () => {
      await this.trading?.runEntryCycle();
    });
  }
}
