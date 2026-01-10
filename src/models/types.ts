export type Asset = 'BTC' | 'ETH' | 'SOL';

export type SeriesSlug =
  | 'bitcoin-up-or-down-hourly'
  | 'ethereum-up-or-down-hourly'
  | 'solana-up-or-down-hourly';

export interface AssetConfig {
  asset: Asset;
  seriesSlug: SeriesSlug;
  slugPrefix: string;
}

export interface HourlyMarket {
  id: string;
  conditionId: string;
  tokenIdUp: string;
  tokenIdDown: string;
  asset: Asset;
  question: string;
  eventStartTime: string;
  hourStart: string;
  hourEnd: string;
  outcome: 'UP' | 'DOWN' | null;
  slug: string;
  seriesSlug: string;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: string;
  marketId: string;
  fetchedAt: string;
  minuteOfHour: number;
  upPrice: number;
  downPrice: number;
  upBid: number | null;
  upAsk: number | null;
  spread: number | null;
  midpoint: number | null;
  lastTradePrice: number | null;
  volume24h: number | null;
}

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  startDate: string;
  endDate: string;
  eventStartTime: string;
  active: boolean;
  closed: boolean;
  volume: number;
  liquidity: number;
  clobTokenIds: string;
  seriesSlug: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  lastTradePrice: number;
  volume24hr: number;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
}

export interface PriceHistoryPoint {
  t: number;
  p: number;
}
