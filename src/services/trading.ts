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
import {
  evaluateEntry,
  isLossLimitBreached,
  resolveFill,
  settlePnl,
  type EntryPlan,
} from './strategy.js';
import { logger } from '../utils/logger.js';

type ActiveMode = Exclude<TradingMode, 'off'>;

interface LiveFill {
  orderId: string;
  fillPrice: number | null;
  /** Shares matched on the exchange. Anything above 0 is a real position. */
  matchedShares: number;
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
  /** UTC day the fee check last passed on; null until it has ever passed. */
  private feeCheckDay: string | null = null;

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

    // Realized pnl alone is not the exposure: several stakes can be in flight
    // and unsettled, since all three assets close on the same 5-minute
    // boundaries. Count every open position as a total loss.
    const realized = this.storage.getRealizedPnlOnDay(mode, day);
    const openExposure = this.storage.getOpenExposure(mode);
    if (isLossLimitBreached(realized, openExposure, DAILY_LOSS_LIMIT_USD)) {
      logger.error(
        `!!! Trading: DAILY LOSS LIMIT HIT (${mode}) - realized ${realized.toFixed(2)} USD ` +
        `on ${day} plus ${openExposure.toFixed(2)} USD at risk in open positions ` +
        `<= -${DAILY_LOSS_LIMIT_USD}. No further trades until tomorrow (UTC). !!!`
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

    const outcome = resolveFill(plan, fill.matchedShares, fill.fillPrice);

    if (outcome.status === 'cancelled') {
      // Nothing matched - pull the order rather than chase the price.
      this.storage.updateTradeExecution(trade.id, {
        status: 'cancelled',
        orderId: fill.orderId,
      });
      logger.warn(
        `Trading: [live] ${market.slug} not filled in time, order ${fill.orderId} cancelled`
      );
      return false;
    }

    this.storage.updateTradeExecution(trade.id, {
      status: 'filled',
      orderId: fill.orderId,
      fillPrice: fill.fillPrice,
      shares: outcome.shares,
      stakeUsd: outcome.stakeUsd,
    });

    if (outcome.partial) {
      logger.warn(
        `Trading: [live] PARTIAL FILL ${market.slug} order=${fill.orderId} - ` +
        `${outcome.shares} of ${plan.shares} shares @ ${fill.fillPrice ?? plan.entryPrice} ` +
        `(stake $${outcome.stakeUsd.toFixed(2)} of $${plan.stakeUsd.toFixed(2)}). ` +
        `Holding the filled portion to resolution.`
      );
    } else {
      logger.info(
        `Trading: [live] filled ${market.slug} order=${fill.orderId} price=${fill.fillPrice ?? plan.entryPrice}`
      );
    }
    return true;
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

    let matched = 0;
    let fillPrice: number | null = null;

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

      const seen = matchedSharesOf(order);
      if (seen > matched) {
        matched = seen;
        fillPrice = priceOf(order) ?? fillPrice;
      }

      if (matched >= plan.shares) {
        return { orderId, fillPrice: fillPrice ?? plan.entryPrice, matchedShares: matched };
      }
      if (isTerminalStatus(order?.status)) {
        // Terminal with a partial match is still a real position.
        return { orderId, fillPrice, matchedShares: matched };
      }
    }

    try {
      await client.cancelOrder({ orderID: orderId });
    } catch (err) {
      logger.error(`Trading: [live] cancel failed for ${orderId}: ${err}`);
    }

    // Poll once more AFTER the cancel. A match can land between the last poll
    // and the cancel taking effect; without this the shares would be held on
    // the exchange while the trade row said `cancelled`.
    try {
      const final = await client.getOrder(orderId);
      const seen = matchedSharesOf(final);
      if (seen > matched) {
        matched = seen;
        fillPrice = priceOf(final) ?? fillPrice;
        logger.warn(
          `Trading: [live] ${orderId} matched ${seen} shares during cancellation`
        );
      }
    } catch (err) {
      // The order may be gone entirely once cancelled; that is not an error,
      // but it does mean `matched` is only as fresh as the last good poll.
      logger.warn(`Trading: [live] post-cancel poll failed for ${orderId}: ${err}`);
    }

    return { orderId, fillPrice, matchedShares: matched };
  }

  /**
   * Taker fees above MAX_FEE_RATE_BPS erase the strategy's ~2.8% edge, so we
   * refuse to trade rather than bleed.
   *
   * Cached per UTC day, not per process: this runs for weeks at a time, and a
   * fee schedule that changes mid-run would otherwise never be noticed. The
   * check is also per-token, so re-running it picks up differences between
   * markets rather than trusting whichever one happened to be checked first.
   */
  private async checkFees(client: ClobClient, tokenId: string): Promise<boolean> {
    const today = utcDay(new Date());
    if (this.feeCheckDay === today) return true;

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

    logger.info(
      `Trading: [live] fee check passed for ${today} (${feeRateBps} bps <= ${MAX_FEE_RATE_BPS})`
    );
    this.feeCheckDay = today;
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

  // === Reconciliation ===

  /**
   * Resolve live trades left `open` by a crashed run.
   *
   * If the process dies between postOrder and the status update, the row stays
   * `open` forever while an order - possibly filled - exists on the exchange.
   * `settleMarket` only settles `filled` rows, so that position is invisible:
   * never settled, never counted, silently diverging from the wallet.
   *
   * Run once at startup, before the scheduler. Deliberately cheap when there is
   * nothing to do: it reads the database first and returns without touching the
   * network or authenticating unless open live trades actually exist.
   */
  async reconcileOpenTrades(): Promise<void> {
    if (this.mode !== 'live') {
      logger.debug('Reconcile: mode is not live, nothing to reconcile');
      return;
    }

    const open = this.storage.getOpenLiveTrades();
    if (open.length === 0) {
      logger.info('Reconcile: no open live trades');
      return;
    }

    logger.warn(
      `Reconcile: ${open.length} live trade(s) left open by a previous run, resolving...`
    );

    const counts = { filled: 0, partial: 0, cancelled: 0, failed: 0, unresolved: 0 };
    const touchedMarkets = new Set<string>();

    // Rows with no order id crashed before postOrder returned, so nothing was
    // ever confirmed on the exchange. Settle them first - they need no lookup,
    // and doing them here means a missing key cannot block them.
    const orphans = open.filter((t) => !t.orderId);
    for (const trade of orphans) {
      this.storage.updateTradeExecution(trade.id, { status: 'failed' });
      logger.warn(`Reconcile: ${trade.id} has no order id, marking failed`);
      counts.failed += 1;
    }

    const withOrder = open.filter((t) => t.orderId);
    if (withOrder.length === 0) {
      logger.warn(`Reconcile: ${counts.failed} failed (no order was ever placed)`);
      return;
    }

    const client = await this.getLiveClient();
    if (!client) {
      logger.error('Reconcile: cannot authenticate, leaving open trades untouched');
      return;
    }

    for (const trade of withOrder) {
      try {
        const result = await this.reconcileTrade(client, trade);
        counts[result] += 1;
        if (result === 'filled' || result === 'partial') touchedMarkets.add(trade.marketId);
      } catch (err) {
        counts.unresolved += 1;
        logger.error(`Reconcile: ${trade.id} error: ${err}`);
      }
    }

    logger.warn(
      `Reconcile: ${counts.filled} filled, ${counts.partial} partial, ` +
      `${counts.cancelled} cancelled, ${counts.failed} failed, ${counts.unresolved} unresolved`
    );

    // A market may have resolved while the process was down, in which case the
    // resolution watcher already recorded its outcome and will never revisit
    // it. Settle anything we just promoted to `filled`.
    for (const marketId of touchedMarkets) {
      const market = this.storage.getMarketById(marketId);
      if (!market?.outcome) continue;
      logger.warn(
        `Reconcile: ${market.slug} already resolved to ${market.outcome}, settling recovered position`
      );
      try {
        this.settleMarket(market, market.outcome);
      } catch (err) {
        logger.error(`Reconcile: ${market.slug} settlement error: ${err}`);
      }
    }
  }

  /** Resolve one orphaned trade against the exchange. */
  private async reconcileTrade(
    client: ClobClient,
    trade: Trade
  ): Promise<'filled' | 'partial' | 'cancelled' | 'failed' | 'unresolved'> {
    // Callers filter these out beforehand; this keeps the type narrowed.
    if (!trade.orderId) {
      this.storage.updateTradeExecution(trade.id, { status: 'failed' });
      return 'failed';
    }

    let order = await this.fetchOrder(client, trade.orderId);

    // Still resting on the book - it is stale, from a run that is long gone.
    // Pull it, then judge by whatever it managed to match.
    if (order && isWorkingStatus(order.status)) {
      logger.warn(`Reconcile: ${trade.id} order ${trade.orderId} still live, cancelling`);
      try {
        await client.cancelOrder({ orderID: trade.orderId });
      } catch (err) {
        logger.error(`Reconcile: cancel failed for ${trade.orderId}: ${err}`);
      }
      order = await this.fetchOrder(client, trade.orderId);
    }

    const matched = matchedSharesOf(order);
    const fillPrice = priceOf(order);

    if (matched <= 0) {
      // Either gone from the exchange or terminal with nothing matched. Both
      // mean no position was ever taken.
      this.storage.updateTradeExecution(trade.id, { status: 'cancelled' });
      logger.info(`Reconcile: ${trade.id} order ${trade.orderId} took no position, cancelled`);
      return 'cancelled';
    }

    const plan: EntryPlan = {
      side: trade.side,
      entryPrice: trade.entryPrice,
      spread: trade.spreadAtEntry,
      askSize: trade.askSizeAtEntry,
      shares: trade.shares,
      stakeUsd: trade.stakeUsd,
    };
    const outcome = resolveFill(plan, matched, fillPrice);

    this.storage.updateTradeExecution(trade.id, {
      status: 'filled',
      fillPrice: fillPrice ?? trade.entryPrice,
      shares: outcome.shares,
      stakeUsd: outcome.stakeUsd,
    });
    logger.warn(
      `Reconcile: ${trade.id} recovered ${outcome.partial ? 'PARTIAL ' : ''}position - ` +
      `${outcome.shares} of ${trade.shares} shares @ ${fillPrice ?? trade.entryPrice}`
    );
    return outcome.partial ? 'partial' : 'filled';
  }

  /**
   * Look up an order, treating "not found" as null.
   *
   * A lookup that fails for any other reason rethrows: guessing `cancelled`
   * from a network blip would discard a real position, so an unresolved trade
   * is left `open` for the next startup to retry.
   */
  private async fetchOrder(
    client: ClobClient,
    orderId: string
  ): Promise<{ status?: string; size_matched?: string; price?: string } | null> {
    try {
      const order = await client.getOrder(orderId);
      return order ?? null;
    } catch (err) {
      if (isNotFound(err)) {
        logger.info(`Reconcile: order ${orderId} no longer exists on the exchange`);
        return null;
      }
      throw err;
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

/** Shares matched on an order, 0 if absent or unparseable. */
function matchedSharesOf(order: { size_matched?: string } | null | undefined): number {
  const n = parseFloat(order?.size_matched ?? '');
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Price on an order, or null if absent or unparseable. */
function priceOf(order: { price?: string } | null | undefined): number | null {
  const n = parseFloat(order?.price ?? '');
  return Number.isFinite(n) ? n : null;
}

/** An order in one of these states will never match anything further. */
function isTerminalStatus(status: string | undefined): boolean {
  if (!status) return false;
  return ['CANCELED', 'CANCELLED', 'EXPIRED', 'MATCHED', 'FILLED'].includes(
    status.toUpperCase()
  );
}

/**
 * Whether an error means "this order does not exist" rather than "the lookup
 * failed". Only the former is safe to treat as a definitive answer.
 */
function isNotFound(err: unknown): boolean {
  const status = (err as { status?: number; response?: { status?: number } })?.status
    ?? (err as { response?: { status?: number } })?.response?.status;
  if (status === 404) return true;
  return /not found|does not exist/i.test(String(err));
}

/** An order still resting on the book, i.e. able to match. */
function isWorkingStatus(status: string | undefined): boolean {
  if (!status) return false;
  return ['LIVE', 'OPEN', 'DELAYED', 'UNMATCHED'].includes(status.toUpperCase());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { BookTop };
