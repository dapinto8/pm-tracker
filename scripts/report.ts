import { StorageService } from '../src/services/storage.js';
import { DB_PATH } from '../src/config.js';
import type { Trade } from '../src/models/types.js';

interface Stats {
  total: number;
  settled: number;
  open: number;
  cancelled: number;
  failed: number;
  wins: number;
  winRate: number | null;
  avgEntry: number | null;
  totalStaked: number;
  totalPnl: number;
  roi: number | null;
  maxDrawdown: number;
}

function computeStats(trades: Trade[]): Stats {
  const settled = trades.filter((t) => t.status === 'settled' && t.pnl !== null);
  const withPosition = trades.filter((t) => t.status === 'settled' || t.status === 'filled');

  const wins = settled.filter((t) => (t.pnl ?? 0) > 0).length;
  const totalPnl = settled.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const totalStaked = settled.reduce((sum, t) => sum + t.shares * (t.fillPrice ?? t.entryPrice), 0);

  const avgEntry =
    withPosition.length > 0
      ? withPosition.reduce((sum, t) => sum + (t.fillPrice ?? t.entryPrice), 0) / withPosition.length
      : null;

  // Max drawdown over the realized equity curve, in dollars.
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of settled) {
    equity += t.pnl ?? 0;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  return {
    total: trades.length,
    settled: settled.length,
    open: trades.filter((t) => t.status === 'open' || t.status === 'filled').length,
    cancelled: trades.filter((t) => t.status === 'cancelled').length,
    failed: trades.filter((t) => t.status === 'failed').length,
    wins,
    winRate: settled.length > 0 ? wins / settled.length : null,
    avgEntry,
    totalStaked,
    totalPnl,
    roi: totalStaked > 0 ? totalPnl / totalStaked : null,
    maxDrawdown,
  };
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(2)}%`);
const usd = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
const price = (v: number | null) => (v === null ? 'n/a' : v.toFixed(4));

function printMode(mode: string, trades: Trade[]): void {
  const s = computeStats(trades);

  console.log(`\n=== ${mode.toUpperCase()} ===`);
  console.log(`  Trades          ${s.total}  (settled ${s.settled}, open ${s.open}, cancelled ${s.cancelled}, failed ${s.failed})`);
  console.log(`  Win rate        ${pct(s.winRate)}  (${s.wins}/${s.settled})`);
  console.log(`  Avg entry       ${price(s.avgEntry)}`);
  console.log(`  Staked          $${s.totalStaked.toFixed(2)}`);
  console.log(`  Total pnl       ${usd(s.totalPnl)}`);
  console.log(`  ROI             ${pct(s.roi)}`);
  console.log(`  Max drawdown    $${s.maxDrawdown.toFixed(2)}`);

  const last = trades.slice(-10).reverse();
  if (last.length === 0) return;

  console.log(`\n  Last ${last.length} trades:`);
  console.log(
    `    ${'entered (UTC)'.padEnd(20)} ${'side'.padEnd(5)} ${'entry'.padEnd(7)} ` +
    `${'shares'.padEnd(9)} ${'status'.padEnd(10)} ${'outcome'.padEnd(8)} pnl`
  );
  for (const t of last) {
    const entry = (t.fillPrice ?? t.entryPrice).toFixed(4);
    console.log(
      `    ${t.enteredAt.slice(0, 19).replace('T', ' ').padEnd(20)} ` +
      `${t.side.padEnd(5)} ${entry.padEnd(7)} ${String(t.shares).padEnd(9)} ` +
      `${t.status.padEnd(10)} ${(t.outcome ?? '-').padEnd(8)} ` +
      `${t.pnl === null ? '-' : usd(t.pnl)}`
    );
  }
}

function main(): void {
  const storage = new StorageService();
  try {
    console.log(`pm-tracker trading report`);
    console.log(`DB: ${DB_PATH}`);

    const modes = storage.getModesWithTrades();
    if (modes.length === 0) {
      console.log('\nNo trades recorded yet.');
      return;
    }

    for (const mode of modes) {
      printMode(mode, storage.getTradesByMode(mode));
    }
    console.log();
  } finally {
    storage.close();
  }
}

main();
