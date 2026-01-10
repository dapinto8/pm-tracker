import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';
import type { HourlyMarket, Snapshot, Asset } from '../models/types.js';

// v2 schema - Up/Down markets without target_price

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
  up_price: number;
  down_price: number;
  up_bid: number | null;
  up_ask: number | null;
  spread: number | null;
  midpoint: number | null;
  last_trade_price: number | null;
  volume_24h: number | null;
}

export class StorageService {
  private db: Database.Database;
  private stmtCache: Map<string, Database.Statement> = new Map();

  constructor(dbPath: string = DB_PATH) {
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
        outcome TEXT,
        slug TEXT NOT NULL,
        series_slug TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_id TEXT NOT NULL REFERENCES markets(id),
        fetched_at TEXT NOT NULL,
        minute_of_hour INTEGER NOT NULL,
        up_price REAL NOT NULL,
        down_price REAL NOT NULL,
        up_bid REAL,
        up_ask REAL,
        spread REAL,
        midpoint REAL,
        last_trade_price REAL,
        volume_24h REAL
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_market_id ON snapshots(market_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_minute ON snapshots(minute_of_hour);
      CREATE INDEX IF NOT EXISTS idx_snapshots_fetched ON snapshots(fetched_at);
      CREATE INDEX IF NOT EXISTS idx_markets_asset ON markets(asset);
      CREATE INDEX IF NOT EXISTS idx_markets_event_start ON markets(event_start_time);
    `);
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private rowToMarket(row: MarketRow): HourlyMarket {
    return {
      id: row.id,
      conditionId: row.condition_id,
      tokenIdUp: row.token_id_up,
      tokenIdDown: row.token_id_down,
      asset: row.asset as Asset,
      question: row.question,
      eventStartTime: row.event_start_time,
      hourStart: row.hour_start,
      hourEnd: row.hour_end,
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
      upPrice: row.up_price,
      downPrice: row.down_price,
      upBid: row.up_bid,
      upAsk: row.up_ask,
      spread: row.spread,
      midpoint: row.midpoint,
      lastTradePrice: row.last_trade_price,
      volume24h: row.volume_24h,
    };
  }

  upsertMarket(market: HourlyMarket): void {
    const sql = `
      INSERT OR REPLACE INTO markets (
        id, condition_id, token_id_up, token_id_down, asset, question,
        event_start_time, hour_start, hour_end, outcome, slug, series_slug, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    this.stmt(sql).run(
      market.id,
      market.conditionId,
      market.tokenIdUp,
      market.tokenIdDown,
      market.asset,
      market.question,
      market.eventStartTime,
      market.hourStart,
      market.hourEnd,
      market.outcome,
      market.slug,
      market.seriesSlug,
      market.createdAt,
      market.updatedAt
    );
  }

  getMarketByConditionId(conditionId: string): HourlyMarket | null {
    const sql = `SELECT * FROM markets WHERE condition_id = ?`;
    const row = this.stmt(sql).get(conditionId) as MarketRow | undefined;
    return row ? this.rowToMarket(row) : null;
  }

  getMarketBySlug(slug: string): HourlyMarket | null {
    const sql = `SELECT * FROM markets WHERE slug = ?`;
    const row = this.stmt(sql).get(slug) as MarketRow | undefined;
    return row ? this.rowToMarket(row) : null;
  }

  getActiveMarkets(): HourlyMarket[] {
    // Active = currently in hour window (started but not ended)
    const sql = `
      SELECT * FROM markets
      WHERE outcome IS NULL
        AND datetime(event_start_time) <= datetime('now')
        AND datetime(event_start_time, '+1 hour') > datetime('now')
    `;
    const rows = this.stmt(sql).all() as MarketRow[];
    return rows.map((r) => this.rowToMarket(r));
  }

  updateMarketOutcome(id: string, outcome: 'UP' | 'DOWN'): void {
    const sql = `UPDATE markets SET outcome = ?, updated_at = ? WHERE id = ?`;
    this.stmt(sql).run(outcome, new Date().toISOString(), id);
  }

  insertSnapshot(snapshot: Omit<Snapshot, 'id'>): void {
    const sql = `
      INSERT INTO snapshots (
        market_id, fetched_at, minute_of_hour, up_price, down_price,
        up_bid, up_ask, spread, midpoint, last_trade_price, volume_24h
      ) VALUES (
        @marketId, @fetchedAt, @minuteOfHour, @upPrice, @downPrice,
        @upBid, @upAsk, @spread, @midpoint, @lastTradePrice, @volume24h
      )
    `;

    this.stmt(sql).run({
      marketId: snapshot.marketId,
      fetchedAt: snapshot.fetchedAt,
      minuteOfHour: snapshot.minuteOfHour,
      upPrice: snapshot.upPrice || 0,
      downPrice: snapshot.downPrice || 0,
      upBid: snapshot.upBid || null,
      upAsk: snapshot.upAsk || null,
      spread: snapshot.spread || null,
      midpoint: snapshot.midpoint || null,
      lastTradePrice: snapshot.lastTradePrice || null,
      volume24h: snapshot.volume24h || null,
    });
  }

  getSnapshotsByMarket(marketId: string): Snapshot[] {
    const sql = `SELECT * FROM snapshots WHERE market_id = ? ORDER BY fetched_at`;
    const rows = this.stmt(sql).all(marketId) as SnapshotRow[];
    return rows.map((r) => this.rowToSnapshot(r));
  }

  close(): void {
    this.db.close();
  }
}
