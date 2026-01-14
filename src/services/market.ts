import { v4 as uuidv4 } from 'uuid';
import { ASSETS, ASSET_CONFIG } from '../config.js';
import type { HourlyMarket, GammaMarket, Asset } from '../models/types.js';
import type { PolymarketService } from './polymarket.js';
import type { StorageService } from './storage.js';
import { logger } from '../utils/logger.js';
import { generateUpcomingMarketSlugs } from '../utils/slug.js';

export class MarketService {
  constructor(
    private polymarket: PolymarketService,
    private storage: StorageService
  ) { }

  // === Discovery ===

  async discoverNewMarkets(): Promise<HourlyMarket[]> {
    const allNewMarkets: HourlyMarket[] = [];

    for (const asset of ASSETS) {
      const newMarkets = await this.discoverMarketsForAsset(asset);
      allNewMarkets.push(...newMarkets);
    }

    logger.info(`Discovery: found ${allNewMarkets.length} new markets total`);
    return allNewMarkets;
  }

  async discoverMarketsForAsset(asset: Asset): Promise<HourlyMarket[]> {
    logger.info(`Discovery: checking ${asset}`);
    const config = ASSET_CONFIG[asset];
    const slugs = generateUpcomingMarketSlugs(config.slugPrefix, 2);
    const newMarkets: HourlyMarket[] = [];

    for (const slug of slugs) {
      try {
        const existing = this.storage.getMarketBySlug(slug);
        if (existing) {
          logger.debug(`${slug}: already exists`);
          continue;
        }

        const gm = await this.polymarket.getMarketBySlug(slug);
        if (!gm) {
          logger.debug(`${slug}: not found`);
          continue;
        }

        const tokenIds = this.parseTokenIds(gm);
        if (!tokenIds) {
          logger.warn(`${slug}: failed to parse token IDs`);
          continue;
        }

        const now = new Date().toISOString();
        const market: HourlyMarket = {
          id: uuidv4(),
          conditionId: gm.conditionId,
          tokenIdUp: tokenIds.up,
          tokenIdDown: tokenIds.down,
          asset,
          question: gm.question,
          eventStartTime: gm.eventStartTime,
          hourStart: gm.eventStartTime,
          hourEnd: gm.endDate,
          outcome: null,
          slug: gm.slug,
          seriesSlug: gm.seriesSlug,
          createdAt: now,
          updatedAt: now,
        };

        this.storage.upsertMarket(market);
        newMarkets.push(market);
        logger.debug(`${asset}: discovered ${slug}`);
      } catch (err) {
        logger.error(`${slug}: error: ${err}`);
      }
    }

    if (newMarkets.length > 0) {
      logger.info(`${asset}: discovered ${newMarkets.length} new market(s)`);
    }
    return newMarkets;
  }

  // === Snapshot Fetching ===

  async fetchActiveMarketSnapshots(): Promise<void> {
    const markets = this.storage.getActiveMarkets();
    if (markets.length === 0) {
      logger.info('Fetch: no active markets');
      return;
    }

    const now = new Date();
    const fetchedAt = now.toISOString();
    let saved = 0;

    for (const market of markets) {
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
  }

  async fetchClosingMarketSnapshots(): Promise<void> {
    logger.debug('Last-minute: checking...');
    const markets = this.storage.getClosingMarkets(5);
    if (markets.length === 0) {
      logger.debug('Last-minute: no markets closing soon');
      return;
    }

    logger.debug(`Last-minute: checking ${markets.length} markets`);
    const now = new Date();
    const fetchedAt = now.toISOString();

    for (const market of markets) {
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

      logger.info(`Last-minute: ${market.slug} min=${minuteOfHour} up=${upPrice.toFixed(2)} down=${downPrice.toFixed(2)}`);
    }
  }

  // === Resolution ===

  async checkResolutions(): Promise<void> {
    logger.info('Resolution: checking...');
    const markets = this.storage.getPendingResolutionMarkets();
    if (markets.length === 0) {
      logger.info('Resolution: no pending markets');
      return;
    }

    logger.info(`Resolution: checking ${markets.length} markets`);
    for (const market of markets) {
      const gm = await this.polymarket.getMarketBySlug(market.slug);
      if (!gm) continue;

      if (gm.closed) {
        const outcome = this.determineOutcome(gm);
        if (outcome) {
          this.storage.updateMarketOutcome(market.id, outcome);
          logger.info(`Resolution: ${market.slug} -> ${outcome}`);
        }
      } else {
        const minutesSinceEnd = (Date.now() - new Date(market.hourEnd).getTime()) / 60000;
        logger.info(`Resolution: ${market.slug} pending ${minutesSinceEnd.toFixed(1)}m`);
      }
    }
  }

  // === Helpers ===

  getActiveMarkets(): HourlyMarket[] {
    return this.storage.getActiveMarkets();
  }

  private parseTokenIds(gm: GammaMarket): { up: string; down: string } | null {
    try {
      const ids = JSON.parse(gm.clobTokenIds) as string[];
      if (ids.length >= 2) {
        return { up: ids[0], down: ids[1] };
      }
    } catch {
      logger.error(`Discovery: ${gm.slug} failed to parse token IDs`);
    }
    return null;
  }

  private determineOutcome(gm: GammaMarket): 'UP' | 'DOWN' | null {
    try {
      const prices = JSON.parse(gm.outcomePrices) as string[];
      const upPrice = parseFloat(prices[0]);
      const downPrice = parseFloat(prices[1]);
      if (upPrice > 0.9) return 'UP';
      if (downPrice > 0.9) return 'DOWN';
    } catch {
      logger.error(`Resolution: ${gm.slug} failed to determine outcome`);
    }
    return null;
  }
}
