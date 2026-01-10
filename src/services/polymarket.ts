import { ClobClient, Side } from '@polymarket/clob-client';
import {
  GAMMA_API_URL,
  CLOB_API_URL,
  CHAIN_ID,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  ASSET_CONFIG,
  DISCOVERY_HOURS_AHEAD,
} from '../config.js';
import type { GammaMarket, PriceHistoryPoint, Asset } from '../models/types.js';
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

  async getMarketsForNextHours(asset: Asset, hoursAhead: number = DISCOVERY_HOURS_AHEAD): Promise<GammaMarket[]> {
    const config = ASSET_CONFIG[asset];
    const slugs = generateUpcomingMarketSlugs(config.slugPrefix, hoursAhead);
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

  async getActiveHourlyMarkets(asset: Asset): Promise<GammaMarket[]> {
    const config = ASSET_CONFIG[asset];
    const seen = new Set<string>();
    const markets: GammaMarket[] = [];

    // First try direct slug lookups
    const directResults = await this.getMarketsForNextHours(asset);
    for (const m of directResults) {
      if (!seen.has(m.conditionId)) {
        seen.add(m.conditionId);
        markets.push(m);
      }
    }

    // Fall back to series_slug search if few results
    if (markets.length < 3) {
      const searchResults = await this.searchMarkets(config.seriesSlug);
      for (const m of searchResults) {
        if (!seen.has(m.conditionId) && m.active && !m.closed) {
          seen.add(m.conditionId);
          markets.push(m);
        }
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

  /**
   * Get spread for a token.
   * Note: SDK only returns { spread: string }, not bid/ask.
   * To get bid/ask, we use getOrderBook instead.
   */
  async getSpread(tokenId: string): Promise<{ spread: number; bid: number; ask: number } | null> {
    // Get order book to extract bid/ask/spread
    const result = await this.retry(async () => {
      return this.client.getOrderBook(tokenId) as Promise<OrderBookSummary>;
    }, `getOrderBook(${tokenId})`);

    if (result && typeof result === 'object') {
      const bids = result.bids || [];
      const asks = result.asks || [];

      // Best bid is highest bid price, best ask is lowest ask price
      const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
      const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0;
      const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

      return { spread, bid: bestBid, ask: bestAsk };
    }
    return null;
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