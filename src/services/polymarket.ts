import { ClobClient, Side } from '@polymarket/clob-client';
import {
  GAMMA_API_URL,
  CLOB_API_URL,
  CHAIN_ID,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  ASSET_CONFIG,
  DISCOVERY_WINDOWS_AHEAD,
} from '../config.js';
import type { GammaMarket, PriceHistoryPoint, Asset, BookTop } from '../models/types.js';
import { logger } from '../utils/logger.js';
import { generateUpcomingMarketSlugs } from '../utils/slug.js';

// SDK Response Types (from docs)
interface TokenPrices {
  BUY?: string;
  SELL?: string;
}

type PricesResponse = {
  [tokenId: string]: TokenPrices;
};

interface OrderBookSummary {
  market: string;
  asset_id: string;
  timestamp: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
}

/**
 * Extract best bid/ask and the size resting there.
 *
 * The CLOB returns bids sorted ASCENDING by price and asks sorted DESCENDING,
 * so the best quotes are the LAST elements of each array. Verified empirically
 * against client.getMidpoint(): (bids[-1] + asks[-1]) / 2 matches the API
 * midpoint exactly, while (bids[0] + asks[0]) / 2 always yields ~0.50.
 */
function bookTopOf(book: OrderBookSummary): BookTop {
  const bids = book.bids || [];
  const asks = book.asks || [];

  const bestBidLevel = bids.length > 0 ? bids[bids.length - 1] : null;
  const bestAskLevel = asks.length > 0 ? asks[asks.length - 1] : null;

  const bid = bestBidLevel ? parseFloat(bestBidLevel.price) : 0;
  const ask = bestAskLevel ? parseFloat(bestAskLevel.price) : 0;
  const bidSize = bestBidLevel ? parseFloat(bestBidLevel.size) : 0;
  const askSize = bestAskLevel ? parseFloat(bestAskLevel.size) : 0;
  const spread = ask > 0 && bid > 0 ? ask - bid : 0;

  return { bid, ask, bidSize, askSize, spread };
}

export class PolymarketService {
  private client: ClobClient;

  constructor() {
    this.client = new ClobClient(CLOB_API_URL, CHAIN_ID);
  }

  private async retry<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        return await fn();
      } catch (err) {
        logger.warn(`${label} attempt ${i + 1} failed: ${err}`);
        if (i < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }
    logger.error(`${label} failed after ${MAX_RETRIES} attempts`);
    return null;
  }

  private parseGammaMarket(raw: any): GammaMarket {
    return {
      id: raw.id,
      question: raw.question,
      conditionId: raw.conditionId,
      slug: raw.slug,
      outcomes: raw.outcomes,
      outcomePrices: raw.outcomePrices,
      startDate: raw.startDate,
      endDate: raw.endDate,
      eventStartTime: raw.eventStartTime ?? raw.startDate,
      active: Boolean(raw.active),
      closed: Boolean(raw.closed),
      volume: Number(raw.volume) || 0,
      liquidity: Number(raw.liquidity) || 0,
      clobTokenIds: typeof raw.clobTokenIds === 'string'
        ? raw.clobTokenIds
        : JSON.stringify(raw.clobTokenIds ?? []),
      seriesSlug: raw.events?.[0]?.seriesSlug ?? raw.seriesSlug ?? '',
      bestBid: Number(raw.bestBid) || 0,
      bestAsk: Number(raw.bestAsk) || 0,
      spread: Number(raw.spread) || 0,
      lastTradePrice: Number(raw.lastTradePrice) || 0,
      volume24hr: Number(raw.volume24hr) || 0,
      acceptingOrders: Boolean(raw.acceptingOrders),
      enableOrderBook: Boolean(raw.enableOrderBook),
    };
  }

  // ============ Gamma API methods ============

  async getMarketBySlug(slug: string): Promise<GammaMarket | null> {
    const result = await this.retry(async () => {
      const url = `${GAMMA_API_URL}/markets/slug/${encodeURIComponent(slug)}`;
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data ? this.parseGammaMarket(data) : null;
    }, `getMarketBySlug(${slug})`);
    return result;
  }

  async getMarketsForNextWindows(
    asset: Asset,
    windowsAhead: number = DISCOVERY_WINDOWS_AHEAD
  ): Promise<GammaMarket[]> {
    const config = ASSET_CONFIG[asset];
    const slugs = generateUpcomingMarketSlugs(config.slugPrefix, windowsAhead);
    const markets: GammaMarket[] = [];

    for (const slug of slugs) {
      const market = await this.getMarketBySlug(slug);
      if (market) {
        markets.push(market);
      }
    }

    return markets;
  }

  async searchMarkets(seriesSlug: string): Promise<GammaMarket[]> {
    const result = await this.retry(async () => {
      const url = `${GAMMA_API_URL}/markets?series_slug=${encodeURIComponent(seriesSlug)}&active=true&closed=false&limit=50`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map((m: any) => this.parseGammaMarket(m));
    }, `searchMarkets(${seriesSlug})`);
    return result ?? [];
  }

  /**
   * Active markets for an asset.
   *
   * Slugs are computed directly from the window timestamp, so no search is
   * needed. Note that the Gamma `series_slug` filter is ignored server-side
   * (it returns arbitrary unrelated markets), which is why there is no
   * fallback search here.
   */
  async getActiveMarketsForAsset(asset: Asset): Promise<GammaMarket[]> {
    const seen = new Set<string>();
    const markets: GammaMarket[] = [];

    for (const m of await this.getMarketsForNextWindows(asset)) {
      if (!seen.has(m.conditionId) && !m.closed) {
        seen.add(m.conditionId);
        markets.push(m);
      }
    }

    return markets;
  }

  // ============ CLOB API methods ============

  /**
   * Get prices for multiple tokens.
   * Response format: { [tokenId]: { BUY?: string, SELL?: string } }
   */
  async getPrices(tokenIds: string[], side: Side = Side.BUY): Promise<Map<string, number>> {
    const prices = new Map<string, number>();

    const result = await this.retry(async () => {
      const params = tokenIds.map((token_id) => ({ token_id, side }));
      return this.client.getPrices(params) as Promise<PricesResponse>;
    }, 'getPrices');

    if (result && typeof result === 'object') {
      for (const tokenId of tokenIds) {
        const tokenPrices = result[tokenId];
        if (tokenPrices) {
          // Get price for the requested side
          const priceStr = side === Side.BUY ? tokenPrices.BUY : tokenPrices.SELL;
          if (priceStr) {
            prices.set(tokenId, parseFloat(priceStr));
          }
        }
      }
    }
    return prices;
  }

  /**
   * Get midpoint price for a token.
   * Response format: { mid: string }
   */
  async getMidpoint(tokenId: string): Promise<number | null> {
    const result = await this.retry(async () => {
      return this.client.getMidpoint(tokenId);
    }, `getMidpoint(${tokenId})`);

    if (result && typeof result === 'object' && 'mid' in result) {
      const mid = (result as { mid: string }).mid;
      return mid ? parseFloat(mid) : null;
    }
    return null;
  }

  /** Top of book for a single token. See {@link bookTopOf} for the sort-order caveat. */
  async getBookTop(tokenId: string): Promise<BookTop | null> {
    const result = await this.retry(async () => {
      return this.client.getOrderBook(tokenId) as Promise<OrderBookSummary>;
    }, `getOrderBook(${tokenId})`);

    if (result && typeof result === 'object') {
      return bookTopOf(result);
    }
    return null;
  }

  /**
   * Top of book for many tokens in a SINGLE request.
   *
   * This is what makes a 5-second snapshot cadence affordable: one call covers
   * every tracked token regardless of how many markets are active, instead of
   * one call per token per tick.
   */
  async getBookTops(tokenIds: string[]): Promise<Map<string, BookTop>> {
    const tops = new Map<string, BookTop>();
    if (tokenIds.length === 0) return tops;

    const result = await this.retry(async () => {
      // `side` is required by the SDK's BookParams type but is meaningless for
      // a book request; the endpoint ignores it.
      const params = tokenIds.map((token_id) => ({ token_id, side: Side.BUY }));
      return this.client.getOrderBooks(params) as Promise<OrderBookSummary[]>;
    }, `getOrderBooks(${tokenIds.length})`);

    if (!Array.isArray(result)) return tops;

    for (const book of result) {
      // Match on asset_id rather than array position - do not assume the
      // response preserves request order.
      if (!book?.asset_id) continue;
      tops.set(book.asset_id, bookTopOf(book));
    }
    return tops;
  }

  /** Last traded price for many tokens in a single request. */
  async getLastTradePrices(tokenIds: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    if (tokenIds.length === 0) return prices;

    const result = await this.retry(async () => {
      const params = tokenIds.map((token_id) => ({ token_id, side: Side.BUY }));
      return this.client.getLastTradesPrices(params);
    }, `getLastTradesPrices(${tokenIds.length})`);

    if (!Array.isArray(result)) return prices;

    for (const entry of result as { token_id?: string; price?: string }[]) {
      const price = entry?.price ? parseFloat(entry.price) : NaN;
      if (entry?.token_id && Number.isFinite(price)) {
        prices.set(entry.token_id, price);
      }
    }
    return prices;
  }

  /**
   * Get spread for a token.
   * Note: SDK only returns { spread: string }, not bid/ask.
   * To get bid/ask, we use getOrderBook instead.
   */
  async getSpread(tokenId: string): Promise<BookTop | null> {
    return this.getBookTop(tokenId);
  }

  /**
   * Taker fee rate in basis points for a token, per the CLOB API.
   */
  async getFeeRateBps(tokenId: string): Promise<number | null> {
    const result = await this.retry(async () => {
      return this.client.getFeeRateBps(tokenId);
    }, `getFeeRateBps(${tokenId})`);

    return typeof result === 'number' && Number.isFinite(result) ? result : null;
  }

  /**
   * Get last trade price for a token.
   * Response format: { price: string, side: string }
   */
  async getLastTradePrice(tokenId: string): Promise<number | null> {
    const result = await this.retry(async () => {
      return this.client.getLastTradePrice(tokenId);
    }, `getLastTradePrice(${tokenId})`);

    if (result && typeof result === 'object' && 'price' in result) {
      const price = (result as { price: string }).price;
      return price ? parseFloat(price) : null;
    }
    return null;
  }

  /**
   * Get historical prices for a token.
   * Response format: { t: number, p: number }[]
   */
  async getPriceHistory(tokenId: string, fidelity: number = 60): Promise<PriceHistoryPoint[]> {
    const result = await this.retry(async () => {
      return this.client.getPricesHistory({
        market: tokenId,
        interval: 'max' as any,
        fidelity,
      });
    }, `getPriceHistory(${tokenId})`);

    if (result && Array.isArray(result)) {
      return result.map((p: any) => ({ t: p.t, p: p.p }));
    }
    return [];
  }
}