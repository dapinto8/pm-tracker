import { v4 as uuidv4 } from 'uuid';
import { ASSETS, ASSET_CONFIG, DISCOVERY_WINDOWS_AHEAD, WINDOW_MINUTES } from '../config.js';
import type { TrackedMarket, GammaMarket, Asset, Snapshot, BookTop } from '../models/types.js';
import type { PolymarketService } from './polymarket.js';
import type { SpotService } from './spot.js';
import type { StorageService } from './storage.js';
import type { TradingService } from './trading.js';
import { logger } from '../utils/logger.js';
import { generateUpcomingMarketSlugs } from '../utils/slug.js';

export class MarketService {
  constructor(
    private polymarket: PolymarketService,
    private storage: StorageService,
    private spot: SpotService,
    private trading?: TradingService
  ) { }

  // === Discovery ===

  async discoverNewMarkets(): Promise<TrackedMarket[]> {
    const allNewMarkets: TrackedMarket[] = [];

    for (const asset of ASSETS) {
      const newMarkets = await this.discoverMarketsForAsset(asset);
      allNewMarkets.push(...newMarkets);
    }

    logger.info(`Discovery: found ${allNewMarkets.length} new markets total`);
    return allNewMarkets;
  }

  async discoverMarketsForAsset(asset: Asset): Promise<TrackedMarket[]> {
    logger.debug(`Discovery: checking ${asset}`);
    const config = ASSET_CONFIG[asset];
    const slugs = generateUpcomingMarketSlugs(config.slugPrefix, DISCOVERY_WINDOWS_AHEAD);
    const newMarkets: TrackedMarket[] = [];

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
        const market: TrackedMarket = {
          id: uuidv4(),
          conditionId: gm.conditionId,
          tokenIdUp: tokenIds.up,
          tokenIdDown: tokenIds.down,
          asset,
          question: gm.question,
          // Gamma's startDate is the row's creation time (often a day early);
          // eventStartTime is the actual window open.
          eventStartTime: gm.eventStartTime,
          windowStart: gm.eventStartTime,
          windowEnd: gm.endDate,
          durationMinutes: WINDOW_MINUTES,
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

  /**
   * Snapshot every active market.
   *
   * Runs on a seconds-level cadence, so it is built around batch endpoints:
   * exactly THREE upstream calls per tick (order books, last trade prices, and
   * Binance spot) regardless of how many markets are active.
   *
   * All three are issued CONCURRENTLY. The point of capturing spot at all is to
   * compare it against the book at the same instant, so anything that widens
   * the gap between them - fetching in sequence, reusing a stale quote - eats
   * directly into what the data can support.
   *
   * Deliberately does NOT call Gamma per snapshot. Gamma lags badly at this
   * timescale - observed reporting 0.505/0.50 for a market whose real book was
   * 0.27/0.28 - so prices come from the CLOB only. That drops `volume24h`
   * (Gamma-only), which is now null on 5m rows.
   */
  async fetchActiveMarketSnapshots(): Promise<void> {
    const markets = this.storage.getActiveMarkets();
    if (markets.length === 0) {
      logger.debug('Fetch: no active markets');
      return;
    }

    const tokenIds = markets.flatMap((m) => [m.tokenIdUp, m.tokenIdDown]);
    // One spot request covers every asset, so this stays three calls per tick
    // however many markets are active. getSpotMids never throws or retries:
    // on failure it yields an empty map and the rows record a null spot.
    const [books, lastTrades, spots] = await Promise.all([
      this.polymarket.getBookTops(tokenIds),
      this.polymarket.getLastTradePrices(tokenIds),
      this.spot.getSpotMids(),
    ]);

    const now = new Date();
    const fetchedAt = now.toISOString();
    const rows: Omit<Snapshot, 'id'>[] = [];

    for (const market of markets) {
      const up = books.get(market.tokenIdUp);
      const down = books.get(market.tokenIdDown);
      if (!up || !down) {
        logger.warn(`Fetch: ${market.slug} missing book data, skipping`);
        continue;
      }

      const elapsedMs = now.getTime() - new Date(market.eventStartTime).getTime();
      const secondOfWindow = Math.floor(elapsedMs / 1000);
      const spot = spots.get(market.asset);

      // A one-sided book is normal near the close, once the outcome is settled
      // enough that nobody quotes the losing side. Record it as absent rather
      // than inventing a price: a midpoint computed against a missing side is
      // worse than no midpoint at all.
      const oneSided = [up, down].some((b) => b.bid === null || b.ask === null);
      if (oneSided) {
        logger.debug(
          `Fetch: ${market.slug} one-sided book at t+${secondOfWindow}s ` +
          `(up ${fmtBook(up)}, down ${fmtBook(down)})`
        );
      }

      rows.push({
        marketId: market.id,
        fetchedAt,
        minuteOfHour: Math.floor(elapsedMs / 60000),
        secondOfWindow,
        // NOTE FOR BACKTESTS: this column changed meaning between versions.
        // Legacy hourly rows stored the best ASK here - they came from
        // getPrices(side=BUY), and the buy-side price is what you pay to buy,
        // i.e. the ask. Rows from this version store the best BID; the ask is
        // in up_ask. Null when that side has no bid at all.
        upPrice: up.bid,
        downPrice: down.bid,
        upBid: up.bid,
        upAsk: up.ask,
        upBidSize: up.bidSize,
        upAskSize: up.askSize,
        spread: up.spread,
        midpoint: up.bid !== null && up.ask !== null ? (up.bid + up.ask) / 2 : null,
        lastTradePrice: lastTrades.get(market.tokenIdUp) ?? null,
        volume24h: null,
        // Both null together when spot was unavailable this tick. The
        // timestamp is the spot response's own, not `fetchedAt`, so the skew
        // between book and spot is recoverable per row.
        spotPrice: spot?.mid ?? null,
        spotFetchedAt: spot?.fetchedAt ?? null,
      });
    }

    if (rows.length > 0) {
      this.storage.insertSnapshots(rows);
    }
    logger.debug(`Fetch: saved ${rows.length} snapshots for ${markets.length} markets`);
  }

  // === Resolution ===

  async checkResolutions(): Promise<void> {
    logger.info('Resolution: checking...');
    const markets = this.storage.getPendingResolutionMarkets();
    if (markets.length === 0) {
      logger.debug('Resolution: no pending markets');
      return;
    }

    logger.debug(`Resolution: checking ${markets.length} markets`);
    let resolved = 0;
    for (const market of markets) {
      const gm = await this.polymarket.getMarketBySlug(market.slug);
      if (!gm) continue;

      if (gm.closed) {
        const outcome = this.determineOutcome(gm);
        if (outcome) {
          this.storage.updateMarketOutcome(market.id, outcome);
          resolved++;
          // Log the raw Gamma fields the outcome was derived from, so a
          // recorded outcome can later be audited against the final book
          // rather than taken on trust.
          logger.info(
            `Resolution: ${market.slug} -> ${outcome} ` +
            `[outcomes=${gm.outcomes} outcomePrices=${gm.outcomePrices} ` +
            `conditionId=${gm.conditionId}]`
          );

          // Settle any positions on this market. Isolated so a settlement
          // failure never stops the resolution watcher.
          try {
            this.trading?.settleMarket(market, outcome);
          } catch (err) {
            logger.error(`Resolution: ${market.slug} settlement error: ${err}`);
          }
        }
      } else {
        // Windows stay open for a few minutes past their end before settling.
        const minutesSinceEnd = (Date.now() - new Date(market.windowEnd).getTime()) / 60000;
        logger.debug(`Resolution: ${market.slug} pending ${minutesSinceEnd.toFixed(1)}m`);
      }
    }

    if (resolved > 0) {
      logger.info(`Resolution: resolved ${resolved}/${markets.length} pending market(s)`);
    }
  }

  // === Helpers ===

  getActiveMarkets(): TrackedMarket[] {
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

  /**
   * Read the winner off Gamma's settled outcome prices.
   *
   * Returns null when neither side is decisive, which is normal for a market
   * that has closed but not yet settled. The raw fields are logged either way
   * so a recorded outcome is auditable after the fact.
   */
  private determineOutcome(gm: GammaMarket): 'UP' | 'DOWN' | null {
    try {
      const prices = JSON.parse(gm.outcomePrices) as string[];
      const upPrice = parseFloat(prices[0]);
      const downPrice = parseFloat(prices[1]);
      if (upPrice > 0.9) return 'UP';
      if (downPrice > 0.9) return 'DOWN';
      logger.info(
        `Resolution: ${gm.slug} closed but undecided ` +
        `[outcomes=${gm.outcomes} outcomePrices=${gm.outcomePrices}]`
      );
    } catch {
      logger.error(
        `Resolution: ${gm.slug} failed to determine outcome ` +
        `[outcomes=${gm.outcomes} outcomePrices=${gm.outcomePrices}]`
      );
    }
    return null;
  }
}

/** Compact book rendering for logs; `-` marks an empty side. */
function fmtBook(book: BookTop): string {
  const px = (n: number | null) => (n === null ? '-' : n.toFixed(4));
  return `${px(book.bid)}/${px(book.ask)}`;
}
