import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';
import type {
  TrackedMarket,
  Snapshot,
  Asset,
  Trade,
  TradeSide,
  TradeStatus,
  TradingMode,
} from '../models/types.js';
import { logger } from '../utils/logger.js';

// v2 schema - Up/Down markets without target_price

/**
 * Column list for `snapshots`, shared by the fresh-create path and the rebuild
 * migration so the two can never drift apart.
 *
 * up_price/down_price are NULLABLE: a side of the book can be genuinely empty,
 * and there is no in-band value that means "no quote". An earlier revision had
 * them NOT NULL, which forced a 0 sentinel that was indistinguishable from a
 * real price.
 */
const SNAPSHOT_COLUMNS_DDL = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES markets(id),
  fetched_at TEXT NOT NULL,
  minute_of_hour INTEGER NOT NULL,
  second_of_window INTEGER,
  up_price REAL,
  down_price REAL,
  up_bid REAL,
  up_ask REAL,
  up_bid_size REAL,
  up_ask_size REAL,
  spread REAL,
  midpoint REAL,
  last_trade_price REAL,
  volume_24h REAL,
  spot_price REAL,
  spot_fetched_at TEXT
`;

const SNAPSHOT_INDEXES_DDL = `
  CREATE INDEX IF NOT EXISTS idx_snapshots_market_id ON snapshots(market_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_minute ON snapshots(minute_of_hour);
  CREATE INDEX IF NOT EXISTS idx_snapshots_fetched ON snapshots(fetched_at);
`;

interface MarketRow {
  id: string;
  condition_id: string;
  token_id_up: string;
  token_id_down: string;
  asset: string;
  question: string;
  event_start_time: string;
  hour_start: string;
  hour_end: string;
  duration_minutes: number | null;
  outcome: string | null;
  slug: string;
  series_slug: string;
  created_at: string;
  updated_at: string;
}

interface SnapshotRow {
  id: number;
  market_id: string;
  fetched_at: string;
  minute_of_hour: number;
  second_of_window: number | null;
  up_price: number | null;
  down_price: number | null;
  up_bid: number | null;
  up_ask: number | null;
  up_bid_size: number | null;
  up_ask_size: number | null;
  spread: number | null;
  midpoint: number | null;
  last_trade_price: number | null;
  volume_24h: number | null;
  spot_price: number | null;
  spot_fetched_at: string | null;
}

interface TradeRow {
  id: string;
  mode: string;
  market_id: string;
  side: string;
  entry_price: number;
  spread_at_entry: number;
  ask_size_at_entry: number;
  shares: number;
  stake_usd: number;
  entered_at: string;
  order_id: string | null;
  fill_price: number | null;
  outcome: string | null;
  pnl: number | null;
  settled_at: string | null;
  status: string;
}

export class StorageService {
  private db: Database.Database;
  private dbPath: string;
  private stmtCache: Map<string, Database.Statement> = new Map();

  constructor(dbPath: string = DB_PATH) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
    // v2 schema for Up/Down hourly markets
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS markets (
        id TEXT PRIMARY KEY,
        condition_id TEXT UNIQUE NOT NULL,
        token_id_up TEXT NOT NULL,
        token_id_down TEXT NOT NULL,
        asset TEXT NOT NULL,
        question TEXT NOT NULL,
        event_start_time TEXT NOT NULL,
        hour_start TEXT NOT NULL,
        hour_end TEXT NOT NULL,
        duration_minutes INTEGER,
        outcome TEXT,
        slug TEXT NOT NULL,
        series_slug TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (${SNAPSHOT_COLUMNS_DDL});

      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        market_id TEXT NOT NULL REFERENCES markets(id),
        side TEXT NOT NULL,
        entry_price REAL NOT NULL,
        spread_at_entry REAL NOT NULL,
        ask_size_at_entry REAL NOT NULL,
        shares REAL NOT NULL,
        stake_usd REAL NOT NULL,
        entered_at TEXT NOT NULL,
        order_id TEXT,
        fill_price REAL,
        outcome TEXT,
        pnl REAL,
        settled_at TEXT,
        status TEXT NOT NULL
      );

      ${SNAPSHOT_INDEXES_DDL}
      CREATE INDEX IF NOT EXISTS idx_markets_asset ON markets(asset);
      CREATE INDEX IF NOT EXISTS idx_markets_event_start ON markets(event_start_time);
      CREATE INDEX IF NOT EXISTS idx_trades_market_id ON trades(market_id);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_entered ON trades(entered_at);
    `);

    this.runMigrations();
  }

  /**
   * Additive-only migrations. Existing rows keep their data; new columns are
   * nullable so historical snapshots stay valid.
   */
  private runMigrations(): void {
    this.addColumnIfMissing('snapshots', 'up_bid_size', 'REAL');
    this.addColumnIfMissing('snapshots', 'up_ask_size', 'REAL');
    // Sub-minute precision: a 5-minute market needs seconds, not minutes.
    this.addColumnIfMissing('snapshots', 'second_of_window', 'INTEGER');
    // Distinguishes the 5m series from the legacy hourly rows (which are null).
    this.addColumnIfMissing('markets', 'duration_minutes', 'INTEGER');
    // Underlying spot at snapshot time. Null on every row written before this
    // existed, and on any row whose spot request failed - the two are
    // indistinguishable, which is fine: both mean "no spot for this row".
    this.addColumnIfMissing('snapshots', 'spot_price', 'REAL');
    this.addColumnIfMissing('snapshots', 'spot_fetched_at', 'TEXT');
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_markets_hour_end ON markets(hour_end)`
    );
    this.assertNullablePrices();
  }

  /**
   * Fail fast on a database created before up_price/down_price were nullable.
   *
   * There is no migration for this: SQLite cannot relax a NOT NULL in place,
   * and the decision was to start fresh rather than rebuild the table. Without
   * this check the mismatch would surface as a SQLITE_CONSTRAINT_NOTNULL only
   * once a book happened to go one-sided - intermittent, mid-run, and hours
   * after startup.
   */
  private assertNullablePrices(): void {
    const cols = this.db.prepare(`PRAGMA table_info(snapshots)`).all() as {
      name: string;
      notnull: number;
    }[];
    const legacy = cols.filter(
      (c) => (c.name === 'up_price' || c.name === 'down_price') && c.notnull === 1
    );
    if (legacy.length === 0) return;

    // Release the handle before bailing out - this throws from the constructor,
    // so nobody is left with an object to call close() on.
    this.db.close();
    throw new Error(
      `Database at ${this.dbPath} predates nullable prices ` +
      `(${legacy.map((c) => c.name).join(', ')} still NOT NULL). ` +
      `An empty side of the book cannot be recorded against this schema. ` +
      `Delete or move the file and let it be recreated.`
    );
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    logger.info(`Migration: added ${table}.${column}`);
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private rowToMarket(row: MarketRow): TrackedMarket {
    return {
      id: row.id,
      conditionId: row.condition_id,
      tokenIdUp: row.token_id_up,
      tokenIdDown: row.token_id_down,
      asset: row.asset as Asset,
      question: row.question,
      eventStartTime: row.event_start_time,
      windowStart: row.hour_start,
      windowEnd: row.hour_end,
      durationMinutes: row.duration_minutes,
      outcome: row.outcome as 'UP' | 'DOWN' | null,
      slug: row.slug,
      seriesSlug: row.series_slug,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToSnapshot(row: SnapshotRow): Snapshot {
    return {
      id: String(row.id),
      marketId: row.market_id,
      fetchedAt: row.fetched_at,
      minuteOfHour: row.minute_of_hour,
      secondOfWindow: row.second_of_window,
      upPrice: row.up_price,
      downPrice: row.down_price,
      upBid: row.up_bid,
      upAsk: row.up_ask,
      upBidSize: row.up_bid_size,
      upAskSize: row.up_ask_size,
      spread: row.spread,
      midpoint: row.midpoint,
      lastTradePrice: row.last_trade_price,
      volume24h: row.volume_24h,
      spotPrice: row.spot_price,
      spotFetchedAt: row.spot_fetched_at,
    };
  }

  upsertMarket(market: TrackedMarket): void {
    const sql = `
      INSERT OR REPLACE INTO markets (
        id, condition_id, token_id_up, token_id_down, asset, question,
        event_start_time, hour_start, hour_end, duration_minutes, outcome, slug, series_slug,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    this.stmt(sql).run(
      market.id,
      market.conditionId,
      market.tokenIdUp,
      market.tokenIdDown,
      market.asset,
      market.question,
      market.eventStartTime,
      market.windowStart,
      market.windowEnd,
      market.durationMinutes,
      market.outcome,
      market.slug,
      market.seriesSlug,
      market.createdAt,
      market.updatedAt
    );
  }

  getMarketByConditionId(conditionId: string): TrackedMarket | null {
    const sql = `SELECT * FROM markets WHERE condition_id = ?`;
    const row = this.stmt(sql).get(conditionId) as MarketRow | undefined;
    return row ? this.rowToMarket(row) : null;
  }

  getMarketById(id: string): TrackedMarket | null {
    const sql = `SELECT * FROM markets WHERE id = ?`;
    const row = this.stmt(sql).get(id) as MarketRow | undefined;
    return row ? this.rowToMarket(row) : null;
  }

  getMarketBySlug(slug: string): TrackedMarket | null {
    const sql = `SELECT * FROM markets WHERE slug = ?`;
    const row = this.stmt(sql).get(slug) as MarketRow | undefined;
    return row ? this.rowToMarket(row) : null;
  }

  /**
   * Active = the window has opened and not yet closed.
   *
   * Bounded by the stored end time rather than a hardcoded +1 hour, so this
   * works for any window length.
   */
  getActiveMarkets(): TrackedMarket[] {
    const sql = `
      SELECT * FROM markets
      WHERE outcome IS NULL
        AND datetime(event_start_time) <= datetime('now')
        AND datetime(hour_end) > datetime('now')
      ORDER BY hour_end
    `;
    const rows = this.stmt(sql).all() as MarketRow[];
    return rows.map((r) => this.rowToMarket(r));
  }

  getClosingMarkets(withinMinutes: number = 5): TrackedMarket[] {
    return this.getMarketsClosingWithinSeconds(withinMinutes * 60);
  }

  /** Markets whose window closes within the next `seconds`. */
  getMarketsClosingWithinSeconds(seconds: number): TrackedMarket[] {
    const sql = `
      SELECT * FROM markets
      WHERE outcome IS NULL
        AND datetime(hour_end) > datetime('now')
        AND datetime(hour_end) <= datetime('now', '+' || ? || ' seconds')
      ORDER BY hour_end
    `;
    const rows = this.stmt(sql).all(seconds) as MarketRow[];
    return rows.map((r) => this.rowToMarket(r));
  }

  /**
   * Closed windows still awaiting an outcome, oldest first.
   *
   * Capped: with 5-minute windows across 3 assets these arrive 36x/hour, and a
   * market that never resolves would otherwise grow this list without bound.
   */
  getPendingResolutionMarkets(limit: number = 50): TrackedMarket[] {
    const sql = `
      SELECT * FROM markets
      WHERE outcome IS NULL
        AND datetime(hour_end) <= datetime('now')
      ORDER BY hour_end
      LIMIT ?
    `;
    const rows = this.stmt(sql).all(limit) as MarketRow[];
    return rows.map((r) => this.rowToMarket(r));
  }

  updateMarketOutcome(id: string, outcome: 'UP' | 'DOWN'): void {
    const sql = `UPDATE markets SET outcome = ?, updated_at = ? WHERE id = ?`;
    this.stmt(sql).run(outcome, new Date().toISOString(), id);
  }

  insertSnapshot(snapshot: Omit<Snapshot, 'id'>): void {
    const sql = `
      INSERT INTO snapshots (
        market_id, fetched_at, minute_of_hour, second_of_window, up_price, down_price,
        up_bid, up_ask, up_bid_size, up_ask_size, spread, midpoint, last_trade_price, volume_24h,
        spot_price, spot_fetched_at
      ) VALUES (
        @marketId, @fetchedAt, @minuteOfHour, @secondOfWindow, @upPrice, @downPrice,
        @upBid, @upAsk, @upBidSize, @upAskSize, @spread, @midpoint, @lastTradePrice, @volume24h,
        @spotPrice, @spotFetchedAt
      )
    `;

    // `??`, never `||`: a legitimate 0 (a zero spread, a genuinely empty size)
    // must survive. `||` used to rewrite every one of those to null while
    // leaving derived values like midpoint intact, which is how corrupt rows
    // ended up looking self-consistent.
    this.stmt(sql).run({
      marketId: snapshot.marketId,
      fetchedAt: snapshot.fetchedAt,
      minuteOfHour: snapshot.minuteOfHour,
      secondOfWindow: snapshot.secondOfWindow ?? null,
      upPrice: snapshot.upPrice ?? null,
      downPrice: snapshot.downPrice ?? null,
      upBid: snapshot.upBid ?? null,
      upAsk: snapshot.upAsk ?? null,
      upBidSize: snapshot.upBidSize ?? null,
      upAskSize: snapshot.upAskSize ?? null,
      spread: snapshot.spread ?? null,
      midpoint: snapshot.midpoint ?? null,
      lastTradePrice: snapshot.lastTradePrice ?? null,
      volume24h: snapshot.volume24h ?? null,
      spotPrice: snapshot.spotPrice ?? null,
      spotFetchedAt: snapshot.spotFetchedAt ?? null,
    });
  }

  /** Insert many snapshots in one transaction - one fsync per tick, not per row. */
  insertSnapshots(snapshots: Omit<Snapshot, 'id'>[]): void {
    if (snapshots.length === 0) return;
    const insertAll = this.db.transaction((batch: Omit<Snapshot, 'id'>[]) => {
      for (const s of batch) this.insertSnapshot(s);
    });
    insertAll(snapshots);
  }

  getSnapshotsByMarket(marketId: string): Snapshot[] {
    const sql = `SELECT * FROM snapshots WHERE market_id = ? ORDER BY fetched_at`;
    const rows = this.stmt(sql).all(marketId) as SnapshotRow[];
    return rows.map((r) => this.rowToSnapshot(r));
  }

  // === Trades ===

  private rowToTrade(row: TradeRow): Trade {
    return {
      id: row.id,
      mode: row.mode as Exclude<TradingMode, 'off'>,
      marketId: row.market_id,
      side: row.side as TradeSide,
      entryPrice: row.entry_price,
      spreadAtEntry: row.spread_at_entry,
      askSizeAtEntry: row.ask_size_at_entry,
      shares: row.shares,
      stakeUsd: row.stake_usd,
      enteredAt: row.entered_at,
      orderId: row.order_id,
      fillPrice: row.fill_price,
      outcome: row.outcome as TradeSide | null,
      pnl: row.pnl,
      settledAt: row.settled_at,
      status: row.status as TradeStatus,
    };
  }

  insertTrade(trade: Trade): void {
    const sql = `
      INSERT INTO trades (
        id, mode, market_id, side, entry_price, spread_at_entry, ask_size_at_entry,
        shares, stake_usd, entered_at, order_id, fill_price, outcome, pnl, settled_at, status
      ) VALUES (
        @id, @mode, @marketId, @side, @entryPrice, @spreadAtEntry, @askSizeAtEntry,
        @shares, @stakeUsd, @enteredAt, @orderId, @fillPrice, @outcome, @pnl, @settledAt, @status
      )
    `;
    this.stmt(sql).run(trade);
  }

  /**
   * Record what an order actually did.
   *
   * `shares`/`stakeUsd` are updatable because a partial fill acquires less than
   * was planned, and settlement pays out on the stored share count - leave it
   * at the intended size and the pnl is wrong by the unfilled remainder.
   * Every field is COALESCE'd, so omitting one leaves it as-is.
   */
  updateTradeExecution(
    id: string,
    fields: {
      status: TradeStatus;
      orderId?: string | null;
      fillPrice?: number | null;
      shares?: number | null;
      stakeUsd?: number | null;
    }
  ): void {
    const sql = `
      UPDATE trades
      SET status = @status,
          order_id = COALESCE(@orderId, order_id),
          fill_price = COALESCE(@fillPrice, fill_price),
          shares = COALESCE(@shares, shares),
          stake_usd = COALESCE(@stakeUsd, stake_usd)
      WHERE id = @id
    `;
    this.stmt(sql).run({
      id,
      status: fields.status,
      orderId: fields.orderId ?? null,
      fillPrice: fields.fillPrice ?? null,
      shares: fields.shares ?? null,
      stakeUsd: fields.stakeUsd ?? null,
    });
  }

  settleTrade(id: string, outcome: TradeSide, pnl: number, settledAt: string): void {
    const sql = `
      UPDATE trades
      SET outcome = ?, pnl = ?, settled_at = ?, status = 'settled'
      WHERE id = ?
    `;
    this.stmt(sql).run(outcome, pnl, settledAt, id);
  }

  /** Trades still carrying risk (order live or position held) for a market. */
  getOpenTradesForMarket(marketId: string): Trade[] {
    const sql = `SELECT * FROM trades WHERE market_id = ? AND status IN ('open', 'filled')`;
    const rows = this.stmt(sql).all(marketId) as TradeRow[];
    return rows.map((r) => this.rowToTrade(r));
  }

  /** Positions held awaiting resolution for a market (paper and live alike). */
  getUnsettledTradesForMarket(marketId: string): Trade[] {
    const sql = `SELECT * FROM trades WHERE market_id = ? AND status = 'filled'`;
    const rows = this.stmt(sql).all(marketId) as TradeRow[];
    return rows.map((r) => this.rowToTrade(r));
  }

  /**
   * Count of entries that took (or are taking) risk on the given UTC day.
   *
   * Only `open`, `filled` and `settled` count. A `cancelled` order never
   * acquired a position, and on a 15-second entry cadence a run of unfilled
   * orders would otherwise burn the whole daily cap without risking a cent.
   * `failed` never reached the exchange at all.
   */
  countTradesOnDay(mode: string, utcDay: string): number {
    const sql = `
      SELECT COUNT(*) AS n FROM trades
      WHERE mode = ? AND date(entered_at) = ?
        AND status IN ('open', 'filled', 'settled')
    `;
    const row = this.stmt(sql).get(mode, utcDay) as { n: number };
    return row.n;
  }

  /**
   * Money currently at risk: cost of every position not yet settled.
   *
   * Uses the actual fill price where known, falling back to the intended entry
   * price for orders still working. This is the amount that goes to zero if
   * every open position resolves against us.
   */
  getOpenExposure(mode: string): number {
    const sql = `
      SELECT COALESCE(SUM(shares * COALESCE(fill_price, entry_price)), 0) AS total
      FROM trades
      WHERE mode = ? AND status IN ('open', 'filled')
    `;
    const row = this.stmt(sql).get(mode) as { total: number };
    return row.total;
  }

  /**
   * Live trades left `open` - an order was posted but its outcome was never
   * recorded, so the process died mid-flight. See TradingService.reconcileOpenTrades.
   */
  getOpenLiveTrades(): Trade[] {
    const sql = `SELECT * FROM trades WHERE mode = 'live' AND status = 'open' ORDER BY entered_at`;
    const rows = this.stmt(sql).all() as TradeRow[];
    return rows.map((r) => this.rowToTrade(r));
  }

  /** Realized pnl for trades settled on the given UTC day. */
  getRealizedPnlOnDay(mode: string, utcDay: string): number {
    const sql = `
      SELECT COALESCE(SUM(pnl), 0) AS total FROM trades
      WHERE mode = ? AND settled_at IS NOT NULL AND date(settled_at) = ?
    `;
    const row = this.stmt(sql).get(mode, utcDay) as { total: number };
    return row.total;
  }

  getTradesByMode(mode: string): Trade[] {
    const sql = `SELECT * FROM trades WHERE mode = ? ORDER BY entered_at`;
    const rows = this.stmt(sql).all(mode) as TradeRow[];
    return rows.map((r) => this.rowToTrade(r));
  }

  getModesWithTrades(): string[] {
    const sql = `SELECT DISTINCT mode FROM trades ORDER BY mode`;
    const rows = this.stmt(sql).all() as { mode: string }[];
    return rows.map((r) => r.mode);
  }

  close(): void {
    this.db.close();
  }
}
