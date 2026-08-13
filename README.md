# pm-tracker

Tracks Polymarket's **5-minute** BTC/ETH/SOL/HYPE/DOGE/BNB up-or-down markets,
storing high-frequency snapshots and the per-market trade tape in SQLite.
Optionally trades them.

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

### Tracked assets

| Asset | Series | Event slug prefix | Binance spot |
| --- | --- | --- | --- |
| BTC | `btc-up-or-down-5m` | `btc-updown-5m` | `BTCUSDT` |
| ETH | `eth-up-or-down-5m` | `eth-updown-5m` | `ETHUSDT` |
| SOL | `sol-up-or-down-5m` | `sol-updown-5m` | `SOLUSDT` |
| HYPE | `hype-up-or-down-5m` | `hype-updown-5m` | — none, see below |
| DOGE | `doge-up-or-down-5m` | `doge-updown-5m` | `DOGEUSDT` |
| BNB | `bnb-up-or-down-5m` | `bnb-updown-5m` | `BNBUSDT` |

All six series were verified live against Gamma on 2026-08-12: all active, all
following the same `<coin>-updown-5m-<epoch>` format, no exceptions. HYPE is
titled "Hyperliquid Up or Down" upstream but slugged by ticker like the rest.
(XRP also exists upstream if you want to add it to `ASSETS`.)

Doubling the asset count does **not** change the request cadence — the batched
book and last-trade calls simply carry twice the tokens, so a tick is still
three upstream calls. It does double snapshot volume, to roughly 104k rows/day.

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
| `*/2 * * * *` | Resolution watcher (also settles trades, then pulls trade tapes) |
| `*/15 * * * * *` | Trading entry cycle, gated on time-to-close (only if enabled) |

A job never overlaps itself: if a tick is still running when the next fires, the
new one is skipped and logged.

### Snapshot cadence

`SNAPSHOT_INTERVAL_SECONDS` (default 5) drives the fetch cron. A 5-minute market
lives for 300s, so the default yields ~60 snapshots per market.

This is affordable because each tick makes exactly **three** upstream calls —
`getOrderBooks` and `getLastTradesPrices`, both batched over every tracked
token, plus one Binance spot request covering every listed asset — regardless
of how many markets are active. Adding an asset adds tokens to the existing
batches, not calls. Measured ~500ms per tick for 3 markets (6 tokens).

Snapshots deliberately do **not** hit Gamma. At this timescale Gamma lags badly:
it reported `0.505 / 0.50` for a market whose real CLOB book was `0.27 / 0.28`
33 seconds into its window. All prices come from the CLOB. The one casualty is
`volume_24h`, which is Gamma-only and is therefore `null` on 5m rows.

### Underlying spot

Every snapshot also records where the underlying was trading: the mid of
Binance's best bid/ask (`bookTicker`, public, no key), captured **concurrently**
with the order book so the two describe the same instant. It is a free stand-in
for the Chainlink feed these markets actually resolve against, which is gated
behind Data Streams — close enough for fair-value work, not identical, and the
difference is why resolution is never inferred from it.

`spot_fetched_at` is stamped when the spot response lands, not at tick start, so
the book-vs-spot skew is measurable per row rather than assumed to be zero. The
request is capped at 2s and never retried: on failure both columns go null and
the book snapshot proceeds untouched. Capturing spot must never cost a snapshot.

#### HYPE has no spot

**Hyperliquid is not listed on Binance spot, so every HYPE snapshot carries a
null `spot_price` and `spot_fetched_at`.** Its order book data is complete; only
the underlying reference is missing.

No second source is wired up for it, deliberately. `spot_price` is only useful
to the fair-value work if it means the same thing on every row, and a column
whose provenance varies by asset does not. `BINANCE_SYMBOLS` therefore maps HYPE
to an explicit `null` rather than omitting it — the record is exhaustive over
`Asset`, so adding a coin forces a symbol or a stated reason there is none.

The gap is announced **once at startup**, not per tick: it is permanent and
known, and repeating it every 5 seconds would bury the transient spot failures
that actually warrant attention.

```
[WARN] Spot: no Binance listing for HYPE - their snapshots will carry a null spot_price for every row
```

## Trade tape

Snapshots record what the book *looked* like. The tape records what actually
**traded** — needed because a maker simulation run off book movement is
inferring fills, and inferred fills are the part of a maker backtest most likely
to be wrong.

When a market resolves, the resolution watcher pulls its complete trade history
once from the public data API (`GET /trades` on `data-api.polymarket.com`) into
`trade_tape`. This applies to **every** tracked asset: BTC/ETH/SOL are the
control group the candidate coins get measured against.

`takerOnly=true`, so there is one row per print. The maker-inclusive view
repeats a print once per maker it matched against, which would inflate traded
volume by a large and uneven factor.

**Timing.** This runs on the resolution cron (`*/2 * * * *`), never on the
snapshot path, and the scheduler already guards each job against overlapping
itself — so however long a tape takes, book capture continues on its own
5-second cadence. Nothing here is time-critical: a settled market is immutable,
so a tape fetched an hour late is identical to one fetched immediately. A busy
BTC window (~4,700 prints, five pages) measured ~2s end to end.

**The tape is not clipped to the window.** Windows are published hours ahead and
stay tradeable briefly after they close, so prints land on both sides of it —
for one sampled BTC market, 89 before the open, 4,541 during, 112 after. Filter
on `traded_at` if you want only in-window activity.

### Retries and idempotency

`markets.tape_fetched_at` is the whole state machine. Null means "still owed":

- A market that just resolved has never been fetched → owed.
- A market whose fetch **failed** was never marked → still owed, retried next
  cycle. Failure marks nothing, so there is no second list to drift out of sync.

Fetching is **all-or-nothing** across pages. A tape that failed half way and was
recorded as complete is indistinguishable from a quiet market, which is exactly
the error a fill simulation would swallow and act on — so a failed page discards
the whole attempt and the next cycle starts from page zero.

That makes re-delivery the normal case, which is what `external_id` is for. The
API exposes no trade id, so one is synthesized from
`transactionHash:tokenId:size:price` and unique-indexed; re-offered prints hit
`INSERT OR IGNORE` and cost nothing. (The hash alone was unique across all 6,353
sampled prints. The other three fields are folded in because a single
transaction carrying two fills would otherwise lose one silently.)

Rows that cannot be an honest print — a price outside `[0, 1]`, a non-positive
size, a token belonging to no side of this market, a missing hash — are dropped
and **counted**, and the count is logged. A repaired print is not a print.

### Bounds

| Env | Default | Effect |
| --- | --- | --- |
| `TAPE_BACKLOG_LIMIT` | `25` | Markets attempted per resolution cycle |
| `TAPE_BACKLOG_LOOKBACK_HOURS` | `24` | How far back the backlog will reach for a market still owed a tape |

The lookback bounds a **retry queue, not a backfill**. Without it, the first run
against an existing database would treat every market ever resolved as owed —
5,373 of them at the time of writing, several million prints — and spend hours
crawling history nobody asked for. At 25 per 2 minutes the queue drains ~750/h
against ~72 resolutions/h, so the default has ample headroom for retries.

**To backfill deliberately**, raise `TAPE_BACKLOG_LOOKBACK_HOURS` for a run
(e.g. `8760` for a year) and let the watcher work through it.

The API rejects `offset` past 10,000 rather than clamping it, so a tape longer
than ~11,000 prints stops there, is logged as truncated, and is still marked
fetched — it is a hard ceiling, not a retryable failure. No 5m market observed
has come close.

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

The loss limit counts **open exposure**, not just realized pnl. All six assets
close on the same 5-minute boundaries, so several stakes can be in flight and
unsettled when the check runs; each is treated as a total loss, which is exactly
what it becomes if the market resolves against it. Checking realized pnl alone
would let the day's worst case overshoot the limit by the whole in-flight
amount.

Note that `MAX_TRADES_PER_DAY=10` is a much tighter constraint on this series
than it was hourly — 5-minute windows across 6 assets present 1,728
opportunities a day, so the cap binds almost immediately. That is deliberate.

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
| `snapshots.spot_price` | Binance mid for the underlying. `null` on pre-migration rows and whenever the spot request failed — the two are indistinguishable, and both mean "no spot for this row". |
| `snapshots.spot_fetched_at` | When that spot quote arrived, to millisecond precision. Differs from `fetched_at` by the book-vs-spot skew. |
| `markets.tape_fetched_at` | When this market's trade tape landed. `null` on pre-migration rows, on unresolved markets, and on any market whose fetch failed — all of which mean "tape still owed". |
| `trades.status` | `open`, `filled`, `cancelled`, `settled`, `failed`. |

### `trade_tape`

One row per executed print, captured once per market at resolution. Distinct
from `trades`, which records this bot's own (optional) positions.

| Column | Notes |
| --- | --- |
| `market_id` | FK to `markets.id`. |
| `token_side` | `UP` or `DOWN`, resolved from the print's **token id** — never from the response's `outcome` label. The two agreed on all 6,353 sampled rows, but the id is what the market is defined by and the label is prose. |
| `price` / `size` | As reported. `price` is a share price in `[0, 1]`; both carry the API's full precision. |
| `taker_side` | `BUY` or `SELL` from the **taker's** perspective. `null` when the API omits or garbles it — the print is still real. |
| `traded_at` | ISO instant, converted from the API's unix **seconds**. |
| `external_id` | Synthesized `transactionHash:tokenId:size:price`, **unique-indexed**. The API has no trade id of its own; this is what makes a re-fetch a no-op. |

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
