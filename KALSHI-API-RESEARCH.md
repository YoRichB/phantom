# Kalshi API Research — Phantom Rebuild Feasibility

Researched 2026-10-12/13. All public endpoints below were called live (no auth) and verified.
Official docs: https://docs.kalshi.com (Trade API v2). Paper trading only — no account, no orders needed.

## Verdict: FEASIBLE WITH GAPS

Everything the scanner and paper engine need exists publicly **except** trader/wallet identities
(whale tape is permanently impossible) and browser-side CORS access (the in-app auto-scan cannot
call Kalshi directly). Fees are real and must be modeled — they bite hardest exactly in the
40–60¢ entry band.

---

## 1. Base URLs

| Use | URL |
|---|---|
| Production (public reads, verified live) | `https://api.elections.kalshi.com/trade-api/v2` |
| Production alt (official docs examples use this) | `https://external-api.kalshi.com/trade-api/v2` |
| Production alt (seen in the wild) | `https://api.kalshi.com/trade-api/v2`, `https://trading-api.kalshi.com/trade-api/v2` |
| Demo (from secondary source, unverified) | `https://external-api.demo.kalshi.co/trade-api/v2` |
| WebSocket | `wss://api.elections.kalshi.com/trade-api/ws/v2` (requires API key — not needed) |

No auth headers required for any market-data GET. Authenticated endpoints (portfolio/orders)
use RSA-PSS signing — irrelevant for paper trading.

## 2. Verified public endpoints

### GET /markets — market listing/search
```
GET /markets?status=open&limit=1000&min_close_ts={now}&max_close_ts={now+48h}
```
Query params (verified against docs + live): `limit` (1–1000), `cursor`,
`status` ∈ `unopened|open|paused|closed|settled`,
`tickers` (comma-separated), `event_ticker` (comma-separated), `series_ticker`,
`mve_filter` ∈ `only|exclude`,
`min_created_ts/max_created_ts`, `min_updated_ts/max_updated_ts`,
`min_close_ts/max_close_ts`, `min_settled_ts/max_settled_ts` (unix seconds).

Notes:
- **No keyword search endpoint** — fetch and filter client-side by `title`.
- **No volume sort** — default sort is newest-first (often illiquid). Filter by
  `series_ticker` (e.g. `KXNFLGAME`) and sort client-side by `volume_24h_fp`.
- Pagination: cursor-based; response includes `cursor` (empty when done).
- ⚠️ Query `status` values ≠ response `status` values:
  query `open` → response `"status": "active"`;
  query `settled` → response `"status": "finalized"`.

Response market object (key fields, verified live):
```json
{
  "ticker": "KXNFLGAME-26OCT12BUFLAR-BUF",
  "event_ticker": "KXNFLGAME-26OCT12BUFLAR",
  "title": "Buffalo wins",
  "status": "active",
  "yes_bid_dollars": "0.4700",
  "yes_ask_dollars": "0.4800",
  "yes_bid_size_fp": "249201.93",
  "yes_ask_size_fp": "3695127.14",
  "no_bid_dollars": "0.5200",
  "no_ask_dollars": "0.5300",
  "last_price_dollars": "0.4800",
  "previous_price_dollars": "0.3900",
  "volume_fp": "35594209.16",
  "volume_24h_fp": "34304177.55",
  "open_interest_fp": "18908324.52",
  "close_time": "2026-10-15T00:15:00Z",
  "expiration_time": "2026-10-15T00:15:00Z",
  "expiration_value": "winner",
  "result": "",
  "strike_type": "structured",
  "market_type": "binary",
  "price_level_structure": "linear_cent",
  "tick_size": null,
  "can_close_early": true,
  "settlement_timer_seconds": 60
}
```
- Prices are **dollar strings** (`"0.4700"` = 47¢). Sizes with `_fp` suffix are
  fractional fixed-point strings. `volume_fp`/`volume_24h_fp` are **dollar notional**.
- `result`: `""` while live; `"yes"`/`"no"` after settlement.

### GET /markets/{ticker} — single market
Same object as above wrapped in `{"market": {...}}`. Verified live.

### GET /markets/{ticker}/orderbook — L2 depth
```
GET /markets/{ticker}/orderbook?depth=10
```
```json
{"orderbook_fp": {
  "yes_dollars": [["0.3800","2263.00"], ..., ["0.4700","..."]],
  "no_dollars":  [["0.4800","4048.00"], ..., ["0.5300","..."]]
}}
```
- **Bids only, per side.** Arrays sorted ascending by price; best bid = last element.
- Ask for a side is derived: `YES ask = 1 − best NO bid` (verified: 1 − 0.52 = 0.48 = `yes_ask_dollars`).
- Sizes are **contract counts** (fractional allowed).
- `depth` param = price levels per side.

### GET /series/{series_ticker}/markets/{ticker}/candlesticks — price history ⚠️ path matters
```
GET /series/KXNFLGAME/markets/KXNFLGAME-26OCT12BUFLAR-BUF/candlesticks?start_ts={6h ago}&end_ts={now}&period_interval=1
```
- `GET /markets/{ticker}/candlesticks` → **404** (does not exist on the live tier).
- Series-scoped path works for live markets. `period_interval` ∈ `1|60|1440` (minutes).
  `start_ts`/`end_ts` are unix seconds.
- Candle shape (verified live):
```json
{"candlesticks": [{
  "end_period_ts": 1791840180,
  "price":    {"open_dollars":"0.3900","high_dollars":"0.3900","low_dollars":"0.3800","close_dollars":"0.3900","mean_dollars":"0.3900","previous_dollars":"0.3900"},
  "yes_bid":  {"open_dollars":"0.3800","high_dollars":"0.3800","low_dollars":"0.3800","close_dollars":"0.3800"},
  "yes_ask":  {"open_dollars":"0.3900","high_dollars":"0.3900","low_dollars":"0.3900","close_dollars":"0.3900"},
  "volume_fp": "27918.84",
  "open_interest_fp": "5619439.74"
}]}
```
- This is the momentum feed: 6h = 360 one-minute candles with bid/ask OHLC. Better than
  Polymarket US (which needed per-market history stitching).

### GET /markets/trades — public trade prints
```
GET /markets/trades?ticker={ticker}&limit=1000        # per-market tape
GET /markets/trades?limit=1000                        # global tape
```
Optional `min_ts`/`max_ts`. Verified public, no auth:
```json
{"trades": [{
  "trade_id": "0725fe67-...",
  "ticker": "KXNFLGAME-26OCT12BUFLAR-BUF",
  "count_fp": "50.25",
  "yes_price_dollars": "0.4800",
  "no_price_dollars": "0.5200",
  "taker_side": "yes",
  "taker_book_side": "bid",
  "taker_outcome_side": "yes",
  "is_block_trade": false,
  "created_time": "2026-10-13T03:22:01.796006Z"
}]}
```
- **No trader/wallet identities anywhere.** See §5.

### GET /events and GET /series — discovery
- `GET /events?limit=&cursor=&status=&series_ticker=` → `{event_ticker, title, series_ticker, ...}` (verified).
- `GET /series?limit=1000` → full catalogue in one page; `include_product_metadata=true`
  adds `fee_type`, `fee_multiplier`, `settlement_sources`, `contract_url`, `tags`.
- One position per **event**: key on `event_ticker`.

### GET /exchange/status — venue health
Verified: `{exchange_active, trading_active, intra_exchange_transfers_active, exchange_index_statuses[]}`.
Use as the doctor check / kill-switch input.

### Historical tier (for old settlements)
- `GET /historical/cutoff` → `{market_settled_ts, trades_created_ts}` — data older than the
  cutoff moves from live endpoints to `/historical/*`.
- `GET /historical/markets`, `/historical/markets/{ticker}/candlesticks`,
  `/historical/trades` — same shapes, public. Only needed for backfill; live grading uses
  `/markets?status=settled`.

## 3. Rate limits

Token-bucket, per docs (checked Oct 2026 by third parties against official reference):
- **Basic tier: 200 read tokens/s, 100 write tokens/s.** Most requests cost 10 tokens →
  **~20 sustained reads/s**, with a 3-second burst bucket (up to ~60 reads in a burst).
- 429 = `{"error": "too many requests"}`, no `Retry-After` header → exponential backoff.
- Higher tiers (Advanced 300/300, Expert 600/600, …) require account/volume — irrelevant;
  public reads are keyless and the scanner needs ~100–200 requests per 30-min cycle,
  far under the sustained budget.

## 4. Fee schedule (paper engine must model this)

Corroborated by multiple Oct-2026 sources citing Kalshi's official schedule (effective Jul 7, 2026);
re-verify on kalshi.com fee page before wiring into the ledger:
- **Taker fee** (market/aggressive orders — what the paper engine simulates):
  `fee = ceil(0.07 × C × P × (1 − P))` where C = contracts, P = price in dollars.
- **Maker fee**: `0.0175 × C × P × (1 − P)` on a listed set of series (incl. major sports);
  free on most other markets. (Paper engine uses taker — ignore maker.)
- **Combos** (multi-leg) charge **double**.
- **No settlement fee.** No fee on ACH deposit/withdrawal.
- Fee peaks at 50¢: 100 contracts @ 50¢ = **$1.75**; @ 10¢/90¢ = $0.63.

Worked example for the paper wallet ($100 full / $50 half stakes, taker):
- $100 stake @ 50¢ → 200 contracts → entry fee $3.50, exit fee up to $3.50 → **~$7 round trip,
  7% drag** on the stake. The 40–60¢ entry band is exactly where fees bite hardest.
- Fees must be deducted on entry AND exit in `paper-kalshi.js`, and the daily −$300 breaker
  should count fees in realized P&L.

## 5. What does NOT exist publicly

- **No wallet/trader identities, no leaderboard API.** `/markets/trades` carries only
  `taker_side`/`taker_book_side` (yes/no, bid/ask). WSJ (Sep 2026): "Kalshi's public data
  doesn't disclose the identity of traders." The old whale-tape engine **cannot port** —
  confirmed, not just assumed. (Kalshi's app has a social leaderboard, but there is no
  public API for it.)
- **No keyword search** — client-side title filtering only.
- **No volume-sorted listing** — client-side sort on `volume_24h_fp`.
- **No historical order-book depth** (only live snapshots + candle bid/ask OHLC).
- **No CORS**: public endpoints return **no `Access-Control-Allow-Origin`** headers;
  OPTIONS preflight → 403. **The in-app auto-scan cannot call Kalshi from the browser.**
  Server-side (cron) scanning + pack injection becomes the only refresh path.

## 6. Market structure specifics

- **Tickers**: `{SERIES}-{YYMMMDD...}-{OUTCOME}`, e.g. `KXNFLGAME-26OCT12BUFLAR-BUF`.
  Event ticker groups a market's outcomes (`...-BUF` / `...-LAR`).
- **Prices**: 1¢–99¢ typical; `price_level_structure` observed values: `linear_cent`
  (1¢ ticks), `center_deci_edge_centi_cent`. `tick_size` field is null on sampled markets
  (standard tick applies).
- **Binary contracts** (`market_type: "binary"`) settle $1 (yes) / $0 (no).
- **Settlement**: `close_time` → `settlement_timer_seconds` (60s observed on NFL) →
  `status: "finalized"`, `result: "yes"|"no"`, `expiration_value` describes what settled
  (e.g. `"winner"`). Grading: poll `/markets?status=settled` or `tickers=` for open
  positions; grade on `result`.
- **Early close**: `can_close_early: true` on sports — positions can end before
  `close_time`; the near-expiry take logic should key off `close_time` but re-check status.
- **Expiries**: everything from 15-minute crypto to multi-day sports — the 48h screen
  (`min_close_ts`/`max_close_ts`) works server-side.
- **Trading hours**: near-24/7 (~166h/week per third-party analysis); gate the cron on
  `/exchange/status` → `trading_active`.
- **Combos** (MVE multi-leg markets): illiquid, weird tickers, `fee_multiplier` may double
  fees — exclude via `mve_filter=exclude`.

## 7. Recommended model adjustments (Kalshi)

Keep the skeleton (momentum → 40–60¢ → spread/depth screens → 48h expiry → $100/$50
stakes → exits/breaker/sweeps). Change the data plumbing:

1. **Momentum via series-scoped 1-min candlesticks**: 6h drift ≥ 4¢ and 1h drift ≥ 1¢
   computed from `price.close_dollars` (or mid of `yes_bid`/`yes_ask` closes); whipsaw guard
   from candle highs/lows. Same thresholds, strictly better data than Polymarket US.
2. **Spread**: `yes_ask_dollars − yes_bid_dollars ≤ 0.03`, straight from the market object.
3. **Depth**: from `/orderbook` — sum contract sizes within 3¢ of best bid (yes side) and
   best ask (derived from no side); require ≥ 500 contracts/side.
4. **Universe**: `/markets?status=open&min_close_ts=&max_close_ts=` (48h window, paginate
   by cursor — expect >1000 hits, exclude `mve_filter=exclude`); client-side filter to
   0.40–0.60 and liquid series; enrich candidates with orderbook + candles.
5. **Entry/exit pricing**: BUY = buy YES at ask; SELL = buy NO at ask-equivalent
   (Kalshi lets you buy NO directly — cleaner than Polymarket's 1−bid math).
   **Deduct taker fees on both legs**: `ceil(0.07 × contracts × P × (1−P))`.
6. **Grading**: `GET /markets?tickers={open tickers}&status=settled` → `result` yes/no.
   Settlement-based grading from day one (same as US build).
7. **One position per `event_ticker`** (not per market ticker — BUF and LAR are separate
   markets of one event).
8. **Whales tab**: remove or repurpose (no tape exists). Signals/Board/Tracker/Trading Agent
   carry over; Board = candidate universe, Signals = momentum picks.
9. **App refresh**: kill the in-browser auto-scan for Kalshi (CORS-blocked). Server cron
   injects the pack every 30 min — that becomes the only data path. (Polymarket US auto-scan
   code stays for reference but must be venue-gated off.)
10. **Fee-aware review gate**: at the 25-trade review, add fee drag as an explicit metric —
    if the 40–60¢ band underperforms net of fees, consider a fee-adjusted entry band or
    wider momentum thresholds to reduce churn.

## 8. Build checklist (for the cutover agent)

- [ ] `lib-kalshi.js`: base URL, no-auth GET, cursor pagination, 429 backoff, `/exchange/status` gate
- [ ] `scan-kalshi.js`: 48h universe → series filter → 40–60¢/spread screens → orderbook depth → candle momentum → signals JSON
- [ ] `paper-kalshi.js`: entries/exits/breaker/sweeps with fee deduction on both legs, grading via `status=settled` + `result`
- [ ] `doctor-kalshi.js`: port the 15 checks (exchange status, universe non-empty, candle path, orderbook, grading probe)
- [ ] App: venue `kalshi`, Signals/Board from injected pack, Whales tab removed/repurposed, in-browser scan disabled for this venue
- [ ] Cron: swap `scan-us.js`/`paper-us.js` for kalshi pair; keep 30-min cadence
- [ ] Fresh $1,000 Kalshi paper wallet; archive (don't delete) the US Polymarket ledger
