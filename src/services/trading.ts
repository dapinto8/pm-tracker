import { v4 as uuidv4 } from 'uuid';
import { Wallet } from '@ethersproject/wallet';
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import {
  CLOB_API_URL,
  CHAIN_ID,
  TRADING_MODE,
  KILL_SWITCH,
  STAKE_USD,
  MAX_TRADES_PER_DAY,
  DAILY_LOSS_LIMIT_USD,
  MAX_FEE_RATE_BPS,
  ORDER_FILL_TIMEOUT_MS,
  ORDER_POLL_INTERVAL_MS,
  POLY_PRIVATE_KEY,
  POLY_FUNDER_ADDRESS,
  TRADING_ENTRY_LEAD_SECONDS,
} from '../config.js';
import type {
  TrackedMarket,
  Trade,
  TradeSide,
  TradingMode,
  BookTop,
} from '../models/types.js';
import type { PolymarketService } from './polymarket.js';
import type { StorageService } from './storage.js';
import { evaluateEntry, settlePnl, type EntryPlan } from './strategy.js';
import { logger } from '../utils/logger.js';

type ActiveMode = Exclude<TradingMode, 'off'>;

interface LiveFill {
  orderId: string;
  fillPrice: number | null;
  filled: boolean;
}

/**
 * Automated execution of strategy "favorite-late" (see strategy.ts).
 *
 * Off by default. TRADING_MODE=paper records simulated fills; TRADING_MODE=live
 * posts real GTC limit orders and spends real funds.
 *
 * The entry cycle is driven by time-to-close, not by a fixed clock minute: it
 * runs frequently and acts only on markets whose window closes within
 * TRADING_ENTRY_LEAD_SECONDS. That keeps it correct for any window length.
 */
export class TradingService {
  private liveClient: ClobClient | null = null;
  private feeCheckPassed = false;

  constructor(
    private polymarket: PolymarketService,
    private storage: StorageService,
    private mode: TradingMode = TRADING_MODE
  ) { }

  // === Entry point (called by the scheduler at :55) ===

  async runEntryCycle(): Promise<void> {
    if (KILL_SWITCH) {
      logger.warn('Trading: KILL_SWITCH is set, refusing to trade');
      return;
    }
    if (this.mode === 'off') {
      logger.debug('Trading: mode=off, skipping');
      return;
    }

    const mode = this.mode;
    const day = utcDay(new Date());

    const realized = this.storage.getRealizedPnlOnDay(mode, day);
    if (realized <= -DAILY_LOSS_LIMIT_USD) {
      logger.error(
        `!!! Trading: DAILY LOSS LIMIT HIT (${mode}) - realized ${realized.toFixed(2)} USD ` +
        `on ${day} <= -${DAILY_LOSS_LIMIT_USD}. No further trades until tomorrow (UTC). !!!`
      );
      return;
    }

    const tradesToday = this.storage.countTradesOnDay(mode, day);
    if (tradesToday >= MAX_TRADES_PER_DAY) {
      logger.warn(`Trading: daily trade cap reached (${tradesToday}/${MAX_TRADES_PER_DAY})`);
      return;
    }

    // Only markets in their final stretch before resolution.
    const markets = this.storage.getMarketsClosingWithinSeconds(TRADING_ENTRY_LEAD_SECONDS);
    if (markets.length === 0) {
      logger.debug('Trading: no markets within the entry window');
      return;
    }

    let remaining = MAX_TRADES_PER_DAY - tradesToday;
    logger.info(
      `Trading: evaluating ${markets.length} market(s) closing within ` +
      `${TRADING_ENTRY_LEAD_SECONDS}s [mode=${mode}, budget=${remaining}]`
    );

    for (const market of markets) {
      if (remaining <= 0) {
        logger.warn('Trading: daily trade cap reached mid-cycle, stopping');
        break;
      }
      try {
        const entered = await this.evaluateMarket(market, mode);
        if (entered) remaining--;
      } catch (err) {
        logger.error(`Trading: ${market.slug} error: ${err}`);
      }
    }
  }

  private async evaluateMarket(market: TrackedMarket, mode: ActiveMode): Promise<boolean> {
    // Never more than one open trade per market.
    const open = this.storage.getOpenTradesForMarket(market.id);
    if (open.length > 0) {
      logger.info(`Trading: ${market.slug} already has an open trade, skipping`);
      return false;
    }

    const [up, down] = await Promise.all([
      this.polymarket.getBookTop(market.tokenIdUp),
      this.polymarket.getBookTop(market.tokenIdDown),
    ]);

    if (!up || !down) {
      logger.warn(`Trading: ${market.slug} could not fetch both order books`);
      return false;
    }

    const decision = evaluateEntry({ up, down, stakeUsd: STAKE_USD });
    if (!decision.enter) {
      logger.info(`Trading: ${market.slug} no entry - ${decision.reason}`);
      return false;
    }

    const plan = decision.plan;
    const tokenId = plan.side === 'UP' ? market.tokenIdUp : market.tokenIdDown;
    logger.info(
      `Trading: ${market.slug} ENTRY ${plan.side} ${plan.shares} sh @ ${plan.entryPrice} ` +
      `(spread=${plan.spread.toFixed(4)}, askSize=${plan.askSize}, stake=$${plan.stakeUsd.toFixed(2)})`
    );

    return mode === 'paper'
      ? this.enterPaper(market, plan)
      : this.enterLive(market, plan, tokenId);
  }

  // === Paper ===

  private enterPaper(market: TrackedMarket, plan: EntryPlan): boolean {
    const trade = this.buildTrade(market, plan, 'paper', 'filled');
    trade.fillPrice = plan.entryPrice; // simulated fill at the current best ask
    this.storage.insertTrade(trade);
    logger.info(`Trading: [paper] recorded fill ${trade.id} for ${market.slug}`);
    return true;
  }

  // === Live ===

  private async enterLive(
    market: TrackedMarket,
    plan: EntryPlan,
    tokenId: string
  ): Promise<boolean> {
    const client = await this.getLiveClient();
    if (!client) return false;

    if (!(await this.checkFees(client, tokenId))) return false;

    const trade = this.buildTrade(market, plan, 'live', 'open');
    this.storage.insertTrade(trade);

    // Never wait for a fill past the window close - on a 5-minute market the
    // configured timeout can outlive the market itself.
    const msUntilClose = new Date(market.windowEnd).getTime() - Date.now();
    const waitMs = Math.max(0, Math.min(ORDER_FILL_TIMEOUT_MS, msUntilClose));
    if (waitMs < ORDER_FILL_TIMEOUT_MS) {
      logger.debug(
        `Trading: [live] fill wait clamped to ${(waitMs / 1000).toFixed(0)}s by window close`
      );
    }

    let fill: LiveFill;
    try {
      fill = await this.placeAndAwaitFill(client, tokenId, plan, waitMs);
    } catch (err) {
      logger.error(`Trading: [live] order failed for ${market.slug}: ${err}`);
      this.storage.updateTradeExecution(trade.id, { status: 'failed' });
      return false;
    }

    if (fill.filled) {
      this.storage.updateTradeExecution(trade.id, {
        status: 'filled',
        orderId: fill.orderId,
        fillPrice: fill.fillPrice,
      });
      logger.info(
        `Trading: [live] filled ${market.slug} order=${fill.orderId} price=${fill.fillPrice ?? plan.entryPrice}`
      );
      return true;
    }

    // Not filled in time - pull the order rather than chase the price.
    this.storage.updateTradeExecution(trade.id, {
      status: 'cancelled',
      orderId: fill.orderId,
    });
    logger.warn(`Trading: [live] ${market.slug} not filled in time, order ${fill.orderId} cancelled`);
    return false;
  }

  private async placeAndAwaitFill(
    client: ClobClient,
    tokenId: string,
    plan: EntryPlan,
    waitMs: number
  ): Promise<LiveFill> {
    // GTC limit buy at the current best ask. Never a market order: an
    // unbounded taker price would blow straight through the edge.
    const signed = await client.createOrder({
      tokenID: tokenId,
      price: plan.entryPrice,
      size: plan.shares,
      side: Side.BUY,
    });
    const resp = await client.postOrder(signed, OrderType.GTC);

    const orderId: string | undefined = resp?.orderID ?? resp?.orderId;
    if (!resp?.success && !orderId) {
      throw new Error(`postOrder rejected: ${resp?.errorMsg ?? JSON.stringify(resp)}`);
    }
    if (!orderId) {
      throw new Error('postOrder returned no order id');
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(ORDER_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));

      let order;
      try {
        order = await client.getOrder(orderId);
      } catch (err) {
        logger.warn(`Trading: [live] poll failed for ${orderId}: ${err}`);
        continue;
      }

      const matched = parseFloat(order?.size_matched ?? '0') || 0;
      if (matched >= plan.shares) {
        const price = parseFloat(order?.price ?? '');
        return {
          orderId,
          fillPrice: Number.isFinite(price) ? price : plan.entryPrice,
          filled: true,
        };
      }
      if (order?.status && ['CANCELED', 'CANCELLED', 'EXPIRED'].includes(order.status.toUpperCase())) {
        return { orderId, fillPrice: null, filled: false };
      }
    }

    try {
      await client.cancelOrder({ orderID: orderId });
    } catch (err) {
      logger.error(`Trading: [live] cancel failed for ${orderId}: ${err}`);
    }
    return { orderId, fillPrice: null, filled: false };
  }

  /**
   * Taker fees above MAX_FEE_RATE_BPS erase the strategy's ~2.8% edge, so we
   * refuse to trade rather than bleed. Checked once per process before the
   * first live order.
   */
  private async checkFees(client: ClobClient, tokenId: string): Promise<boolean> {
    if (this.feeCheckPassed) return true;

    let feeRateBps: number | null = null;
    try {
      feeRateBps = await client.getFeeRateBps(tokenId);
    } catch (err) {
      logger.warn(`Trading: [live] fee lookup via client failed: ${err}`);
      feeRateBps = await this.polymarket.getFeeRateBps(tokenId);
    }

    if (feeRateBps === null || !Number.isFinite(feeRateBps)) {
      logger.error('Trading: [live] could not determine fee rate, refusing to trade');
      return false;
    }
    if (feeRateBps > MAX_FEE_RATE_BPS) {
      logger.error(
        `!!! Trading: [live] taker fee ${feeRateBps} bps exceeds limit ${MAX_FEE_RATE_BPS} bps - ` +
        `fees this size erase the edge. Refusing to trade. !!!`
      );
      return false;
    }

    logger.info(`Trading: [live] fee check passed (${feeRateBps} bps <= ${MAX_FEE_RATE_BPS})`);
    this.feeCheckPassed = true;
    return true;
  }

  private async getLiveClient(): Promise<ClobClient | null> {
    if (this.liveClient) return this.liveClient;

    if (!POLY_PRIVATE_KEY) {
      logger.error('Trading: [live] POLY_PRIVATE_KEY is not set, refusing to trade');
      return null;
    }

    try {
      const signer = new Wallet(POLY_PRIVATE_KEY);
      const creds = await new ClobClient(CLOB_API_URL, CHAIN_ID, signer).createOrDeriveApiKey();

      // A funder address means orders are signed by an EOA that owns a Polymarket
      // proxy wallet; without one we sign and fund from the EOA itself.
      this.liveClient = POLY_FUNDER_ADDRESS
        ? new ClobClient(
          CLOB_API_URL,
          CHAIN_ID,
          signer,
          creds,
          SignatureType.POLY_PROXY,
          POLY_FUNDER_ADDRESS
        )
        : new ClobClient(CLOB_API_URL, CHAIN_ID, signer, creds);

      logger.info(
        `Trading: [live] authenticated as ${signer.address}` +
        (POLY_FUNDER_ADDRESS ? ` (funder ${POLY_FUNDER_ADDRESS})` : '')
      );
      return this.liveClient;
    } catch (err) {
      logger.error(`Trading: [live] auth failed: ${err}`);
      return null;
    }
  }

  // === Settlement ===

  /**
   * Settle every held position for a resolved market. Called by the resolution
   * watcher; works for paper and live rows alike since both hold to resolution.
   */
  settleMarket(market: TrackedMarket, outcome: TradeSide): void {
    const trades = this.storage.getUnsettledTradesForMarket(market.id);
    if (trades.length === 0) return;

    const settledAt = new Date().toISOString();
    for (const trade of trades) {
      const entry = trade.fillPrice ?? trade.entryPrice;
      const won = trade.side === outcome;
      const pnl = settlePnl(trade.shares, entry, won);
      this.storage.settleTrade(trade.id, outcome, pnl, settledAt);
      logger.info(
        `Trading: settled ${trade.id} [${trade.mode}] ${market.slug} ${trade.side} vs ${outcome} ` +
        `-> ${won ? 'WIN' : 'LOSS'} pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`
      );
    }

    const day = utcDay(new Date());
    for (const mode of new Set(trades.map((t) => t.mode))) {
      const realized = this.storage.getRealizedPnlOnDay(mode, day);
      if (realized <= -DAILY_LOSS_LIMIT_USD) {
        logger.error(
          `!!! Trading: DAILY LOSS LIMIT BREACHED (${mode}) - realized ${realized.toFixed(2)} USD ` +
          `on ${day}. Trading halted until tomorrow (UTC). !!!`
        );
      }
    }
  }

  // === Helpers ===

  private buildTrade(
    market: TrackedMarket,
    plan: EntryPlan,
    mode: ActiveMode,
    status: Trade['status']
  ): Trade {
    return {
      id: uuidv4(),
      mode,
      marketId: market.id,
      side: plan.side,
      entryPrice: plan.entryPrice,
      spreadAtEntry: plan.spread,
      askSizeAtEntry: plan.askSize,
      shares: plan.shares,
      stakeUsd: plan.stakeUsd,
      enteredAt: new Date().toISOString(),
      orderId: null,
      fillPrice: null,
      outcome: null,
      pnl: null,
      settledAt: null,
      status,
    };
  }
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { BookTop };
