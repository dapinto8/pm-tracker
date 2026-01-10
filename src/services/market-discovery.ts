import { v4 as uuidv4 } from 'uuid';
import { ASSETS, ASSET_CONFIG } from '../config.js';
import type { HourlyMarket, GammaMarket, Asset } from '../models/types.js';
import type { PolymarketService } from './polymarket.js';
import type { StorageService } from './storage.js';
import { logger } from '../utils/logger.js';
import { generateUpcomingMarketSlugs } from '../utils/slug.js';

export class MarketDiscoveryService {
  constructor(
    private polymarket: PolymarketService,
    private storage: StorageService
  ) { }

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
    const config = ASSET_CONFIG[asset];
    // Only check current + next hour to minimize API calls
    const slugs = generateUpcomingMarketSlugs(config.slugPrefix, 2);
    const newMarkets: HourlyMarket[] = [];

    for (const slug of slugs) {
      try {
        // Check DB first - skip API call if market exists
        const existing = this.storage.getMarketBySlug(slug);
        if (existing) {
          logger.debug(`${slug}: market already exists`);
          continue;
        }

        const gm = await this.polymarket.getMarketBySlug(slug);
        if (!gm) {
          logger.debug(`${slug}: market not found`);
          continue;
        }

        // Parse token IDs
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
        logger.error(`${slug}: error fetching market: ${err}`);
      }
    }

    if (newMarkets.length > 0) {
      logger.info(`${asset}: discovered ${newMarkets.length} new market(s)`);
    }
    return newMarkets;
  }

  async updateMarketOutcomes(): Promise<number> {
    const now = new Date();
    const activeMarkets = this.storage.getActiveMarkets();
    let updated = 0;

    for (const market of activeMarkets) {
      // Only check markets past their end time
      if (new Date(market.hourEnd) > now) continue;

      const gm = await this.polymarket.getMarketBySlug(market.slug);
      if (!gm || !gm.closed) continue;

      const outcome = this.determineOutcome(gm);
      if (outcome) {
        this.storage.updateMarketOutcome(market.id, outcome);
        updated++;
        logger.debug(`Updated outcome for ${market.slug}: ${outcome}`);
      }
    }

    logger.info(`Outcomes: updated ${updated} markets`);
    return updated;
  }

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
      // ignore parse errors
    }
    return null;
  }

  private determineOutcome(gm: GammaMarket): 'UP' | 'DOWN' | null {
    // outcomePrices is JSON string like "[\"0.95\",\"0.05\"]"
    // Index 0 = Up, Index 1 = Down
    try {
      const prices = JSON.parse(gm.outcomePrices) as string[];
      const upPrice = parseFloat(prices[0]);
      const downPrice = parseFloat(prices[1]);

      if (upPrice > 0.9) return 'UP';
      if (downPrice > 0.9) return 'DOWN';
    } catch {
      // ignore parse errors
    }
    return null;
  }
}
