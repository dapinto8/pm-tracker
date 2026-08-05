# pm-tracker

Tracks Polymarket's **5-minute** BTC/ETH/SOL up-or-down markets, storing
high-frequency snapshots in SQLite. Optionally trades them.

## The markets

Each market covers a 5-minute window, e.g.
[`btc-updown-5m-1785774300`](https://polymarket.com/event/btc-updown-5m-1785774300)
→ 2026-08-03 16:25:00Z to 16:30:00Z. Slugs are fully deterministic:

```
btc-updown-5m-1785774300
              ^ unix seconds of the window start, aligned to a 300s boundary
```

So every window is addressable by computing its timestamp — no search endpoint
is needed (which matters, because Gamma's `series_slug` filter is ignored
server-side and returns unrelated markets). Windows are published several hours
ahead; outcomes settle a few minutes after the window closes.

Series: `btc-up-or-down-5m`, `eth-up-or-down-5m`, `sol-up-or-down-5m`. (XRP and
DOGE also exist upstream if you want to add them to `ASSETS`.)

## Setup

```bash
npm install
cp .env.example .env
npm run dev        # tsx watch
npm run build      # tsc -> dist/
npm start          # node dist/index.js
npm test           # unit tests
npm run report     # trading report
```

## Scheduled jobs

| Cron | Job |
| --- | --- |
| `*/5 * * * * *` | Snapshot every active market (seconds field — ~60 per window) |
| `*/5 * * * *` | Discover the next `DISCOVERY_WINDOWS_AHEAD` windows |
| `*/2 * * * *` | Resolution watcher (also settles trades) |
| `*/15 * * * * *` | Trading entry cycle, gated on time-to-close (only if enabled) |

A job never overlaps itself: if a tick is still running when the next fires, the
new one is skipped and logged.

### Snapshot cadence

`SNAPSHOT_INTERVAL_SECONDS` (default 5) drives the fetch cron. A 5-minute market
lives for 300s, so the default yields ~60 snapshots per market.

This is affordable because each tick makes exactly **two** upstream calls —
`getOrderBooks` and `getLastTradesPrices`, both batched over every tracked token
— regardless of how many markets are active. Measured ~500ms per tick for 3
markets (6 tokens).

Snapshots deliberately do **not** hit Gamma. At this timescale Gamma lags badly:
it reported `0.505 / 0.50` for a market whose real CLOB book was `0.27 / 0.28`
33 seconds into its window. All prices come from the CLOB. The one casualty is
`volume_24h`, which is Gamma-only and is therefore `null` on 5m rows.

## Trading bot

> **⚠️ `TRADING_MODE=live` places real orders on Polymarket and spends real
> funds from your wallet. There is no exit logic — positions are held to
> resolution and can go to zero. Start in `paper` mode and read the risk
> controls below before going anywhere near `live`.**

Off by default. With no env changes, deploying this changes nothing.

### Strategy: `favorite-late`

`TRADING_ENTRY_LEAD_SECONDS` (default 30) before a window closes, for each
market in that window:

1. Fetch both tokens' order books.
2. The **favorite** is the side whose midpoint is >= 0.5.
3. Buy the favorite only if **all** of:
   - its best ask is in `[0.90, 0.97)`
   - its book spread (`bestAsk - bestBid`) is <= `0.03`
   - the size resting at the best ask covers the order
4. Size: `STAKE_USD / bestAsk` shares (rounded down to 2 decimals).
5. Hold to resolution. No exit logic.

Entry is driven by time-to-close rather than a fixed clock minute, so it stays
correct for any window length.

> **⚠️ The thresholds are inherited, not validated for this series.** They come
> from a backtest of 7,766 resolved **hourly** markets entering at minute 55
> (96.7% win rate, ~+2.8% ROI/trade at midpoint, break-even at ~2.6c of one-way
> execution cost). That backtest has **not** been re-run on the 5-minute
> markets. A 300s window is not a 3600s window scaled down — less time for the
> favorite to hold, thinner books, and the same execution cost over a shorter
> horizon. The default lead of 30s is the same *fraction* of the window that
> minute 55 was of an hour (~8%), which is an analogy, not evidence. Collect
> data from the tracker and re-run the backtest before trusting any of it.

Thin books are a real constraint here: SOL windows have been observed with only
5–20 shares at the top of book, which the size guard will reject outright for a
$100 stake.

The entry decision is a pure function (`src/services/strategy.ts`,
`evaluateEntry`) with no network, clock, or database access, so it is directly
unit tested.

### Modes

`TRADING_MODE=off` (default) — the trading job is never scheduled.

`TRADING_MODE=paper` — no orders are placed. A simulated fill at the current
best ask is recorded in the `trades` table and settled like a real one.

`TRADING_MODE=live` — requires `POLY_PRIVATE_KEY` (and `POLY_FUNDER_ADDRESS` if
you fund through a Polymarket proxy wallet); API credentials are derived via
`createOrDeriveApiKey()`. Places a **GTC limit buy at the current best ask** —
never a market order. If the order is not filled within `ORDER_FILL_TIMEOUT_MS`
(60s) **or the window closes, whichever comes first**, the remainder is
cancelled; the bot does not chase the price. That clamp matters here: entering
30s before close means the full 60s timeout would otherwise outlive the market.
The taker fee is checked against `MAX_FEE_RATE_BPS` (default 100) once per UTC
day; above that it logs a warning and refuses to trade, because fees that size
erase the edge.

**Partial fills are positions.** If the order is only partly matched when the
timeout hits, the remainder is cancelled and the filled portion is recorded as
`filled` with `shares` and `stake_usd` set to what actually matched — then held
to resolution like any other position. The order is polled once more *after* the
cancel, because a match can land in the gap between the last poll and the cancel
taking effect. Treating a partial as a cancel would leave real shares on the
exchange that the `trades` table never knew about.

### Crash recovery

If the process dies between placing an order and recording its outcome, the row
stays `open` while an order — possibly filled — still exists on the exchange.
Settlement only touches `filled` rows, so that position would be invisible
forever: never settled, never counted.

On startup, before the scheduler runs, `reconcileOpenTrades()` resolves every
`open` live trade against the exchange:

| Exchange state | Recorded as |
| --- | --- |
| Matched in full | `filled` |
| Partially matched | `filled`, sized to what matched |
| Terminal with nothing matched, or order gone | `cancelled` |
| Still resting on the book | cancelled (it is stale), then judged on its final state |
| No order id — crashed before the order was placed | `failed` |

A lookup that fails for any reason *other* than "no such order" leaves the trade
`open` for the next startup to retry: guessing `cancelled` from a network blip
would silently discard a real position. Markets that resolved while the process
was down are settled immediately after reconciliation, since the resolution
watcher has already passed them by.

This is a no-op — no network, no authentication — unless the mode is `live`
*and* such trades exist.

### Risk controls

| Env | Default | Effect |
| --- | --- | --- |
| `KILL_SWITCH` | unset | Any non-empty value refuses all trading, whatever the mode |
| `STAKE_USD` | `100` | Dollars per trade |
| `MAX_TRADES_PER_DAY` | `10` | Entries per UTC day. Counts only `open`/`filled`/`settled` — an order that never filled took no risk and must not burn the cap |
| `DAILY_LOSS_LIMIT_USD` | `300` | Halts trading until tomorrow (UTC) when `realized − openExposure <= -limit`, logged loudly |
| `MAX_FEE_RATE_BPS` | `100` | Live mode refuses to trade above this taker fee, re-checked daily |

Plus: never more than one open trade per market.

The loss limit counts **open exposure**, not just realized pnl. All three assets
close on the same 5-minute boundaries, so several stakes can be in flight and
unsettled when the check runs; each is treated as a total loss, which is exactly
what it becomes if the market resolves against it. Checking realized pnl alone
would let the day's worst case overshoot the limit by the whole in-flight
amount.

Note that `MAX_TRADES_PER_DAY=10` is a much tighter constraint on this series
than it was hourly — 5-minute windows across 3 assets present 864 opportunities
a day, so the cap binds almost immediately. That is deliberate.

### Settlement

The existing resolution watcher settles open positions when a market's outcome
lands: `pnl = shares * (1 - entry)` on a win, `-shares * entry` on a loss. Paper
and live rows settle identically. Settlement is wrapped so a failure there can
never stop the resolution watcher.

### Reporting

```bash
npm run report
```

Prints per-mode trade count, win rate, average entry, total pnl, ROI, max
drawdown, and the last 10 trades.

## Schema notes

Migrations are additive only — existing rows are never rewritten, so the
historical hourly data stays intact and queryable alongside the 5m rows.

One exception, and it is not a migration: `snapshots.up_price` / `down_price`
are now **nullable**, because an empty side of the book has no price and a `0`
sentinel is indistinguishable from a real one. SQLite cannot drop a `NOT NULL`
in place, so there is no upgrade path — a database created before this change
is rejected at startup with an explicit message, and the fix is to delete the
file and let it be recreated. Nothing is deleted automatically.

| Column | Notes |
| --- | --- |
| `markets.hour_start` / `hour_end` | Window start/end. Legacy names kept — renaming would be a destructive migration. Mapped to `windowStart` / `windowEnd` in code. |
| `markets.duration_minutes` | `5` for the new series; `null` on pre-migration rows, which were all hourly. Use this to tell them apart. |
| `snapshots.second_of_window` | Seconds since the window opened — the useful resolution here. `null` on pre-migration rows. |
| `snapshots.minute_of_hour` | Whole minutes since the window opened (`0`–`4` for 5m markets). Kept for continuity. |
| `snapshots.up_bid_size` / `up_ask_size` | Size resting at the top of book. `null` on pre-migration rows, and `null` whenever that side of the book is empty. |
| `snapshots.up_price` / `down_price` | Best bid on each side. Nullable: `null` means that side had no bid. |
| `snapshots.up_bid` / `up_ask` / `spread` / `midpoint` | All nullable and all honest: `null` means no quote. `spread` and `midpoint` are only written when **both** sides are present (see below). |
| `snapshots.volume_24h` | Gamma-only, so `null` on 5m rows (see snapshot cadence above). |
| `trades.status` | `open`, `filled`, `cancelled`, `settled`, `failed`. |

### Order book ordering

Polymarket's CLOB returns bids sorted **ascending** by price and asks sorted
**descending**, so the best quotes are the **last** elements of each array.
Reading `bids[0]`/`asks[0]` yields the two extreme ends of the book — which is
why snapshots taken before this fix stored `bid=0.01 / ask=0.99` and a midpoint
of 0.50 for every row. Verified against `client.getMidpoint()` across live
tokens: `(bids[-1] + asks[-1]) / 2` matches the API midpoint exactly.

### Empty sides

One side of the book routinely **empties out** in the final seconds of a window,
once the outcome is near-certain and nobody is left quoting the loser. An empty
side is `null`, never `0`:

- `spread` and `midpoint` are computed **only when both sides are present**.
  Averaging a real 0.99 ask against a missing bid coerced to 0 reported `0.495`
  for a market that was actually at 0.99 — a plausible-looking number that was
  pure fiction, and the reason this rule exists.
- Persistence uses `??`, never `||`, so a legitimate `0` (a zero spread, a zero
  resting size) is stored as `0` rather than being rewritten to `null`.

The entry logic treats a one-sided book as a hard decline: no favorite can be
established without both sides.
