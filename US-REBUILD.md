# Phantom US Rebuild — Verification Summary
**Built:** 2026-10-13 ~02:35 UTC · **Venue:** Polymarket US (public gateway, no key)
**Standing decisions:** STAY PAPER (user, 2026-10-12). No live money, no accounts, no keys, no orders anywhere in this work. Cutover NOT performed — awaiting approval.

## 1. API survey (all verified live against https://gateway.polymarket.us)

| Need | Endpoint | Result |
|---|---|---|
| Market listing | `GET /v1/events?active=&closed=&limit=&offset=&endDateMin=&endDateMax=` | ✅ Event + nested markets; per-market `bestBidQuote`/`bestAskQuote`, `marketSides[]`, `status`. **No volume/liquidity fields** (all null). **Market `endDate` is the settlement date** (often weeks out) — the **event** `endDate` is the resolution time; intraday filter must use it. |
| Executable depth | `GET /v1/markets/{slug}/book` → `{marketData:{bids, offers}}` | ✅ Full L2 with per-level qty. **NB: the field is `offers`, not `asks`.** Sampled 40 intraday markets: median ~28k shares/side within 3¢ of touch; 37/40 have ≥500 shares both sides. A $100 stake at 50¢ = 200 shares — books absorb it easily. |
| Price momentum | `GET /v1/price-history?symbol={slug}&fixedInterval=INTERVAL_6H&fidelity=1` | ✅ 361 minute-points `{timestamp, longPrice, shortPrice}`; `longPrice` = Yes display. (Param is `fixedInterval`, not `interval`.) |
| Lightweight quotes | `GET /v1/markets/{slug}/bbo` | ✅ bestBid/bestAsk + `openInterest`, `sharesTraded`, depths. Used for live marks + approve-time re-pricing. |
| Resolution truth | `GET /v1/markets/{slug}/settlement` → `{settlement: 1\|0}` | ✅ `1` = YES won, `0` = YES lost; **unresolved markets error** ("Settlement not found") → clean resolved/unresolved split. Verified against known outcomes (Panthers win → 1, Falcons loss → 0). |
| Resolution fallback | `GET /v1/events?active=false&closed=true` | ✅ Resolved markets carry `marketSides[].long=true` (YES side) priced `"1"`/`"0"`. |
| **Trade tape / prints / wallets** | — | ❌ **Not on the public API.** The old whale-flow engine cannot port. |
| Per-market 24h volume | — | ❌ Absent; book depth is the replacement. |

Rate limit: 20 req/s/IP (public). Scans run at concurrency 8, well under it.

## 2. New signal model — price action (v1 heuristics, UNPROVEN on this venue)

The old engine's edge was whale flow; this venue has none publicly, so signals come from **sustained directional drift** in the Yes/No display price:

- **Universe:** active events ending in (0, 48h]; markets quoted, mid 40–60¢, spread ≤ 3¢.
- **Liquidity gate:** ≥500 shares bid AND offered within 3¢ of touch (book-measured, ~2.5× max stake).
- **Momentum:** 6h drift ≥ 4¢ in-signal-direction **and** 1h drift ≥ 1¢ same direction (move is ongoing, not exhausted); whipsaw guard (path never reverses >10¢ against the drift); ≥60 history points.
- **Size votes** (need 3/4; 4/4 = full $100, 3/4 = half $50): strong drift (≥6¢/6h), tight spread (≤2¢), deep book (≥5k shares/side), fresh move (≥2¢ last hour).
- **SELL** = buy NO at 1−bid (same honest fills as the old bot).

Everything else is identical to the proven config: $1,000 wallet, $100/$50 stakes, 40–60¢ entry band, +100% partial TP / −50% stop / <30min expiry take / >6h stale reaper, −$300 daily breaker (blocks opens), max 10 open, **one position per event** (eventSlug — spreads/totals/lines on one game are correlated), $100 savings sweeps above $1,000, shared `HALT` kill switch, approval queue (`pending-approvals-us.json`).

**What's unavailable vs the old engine:** wallets, prints, net USD flow (all null in signal JSON — the cron handoff should note `signal_basis: 'price-action'`). Also **no esports** on this venue (sports/politics/macro/culture only) — the old bot's proven edge does not transfer; this ledger starts proof from zero.

## 3. Files (all new; international stack untouched)

- `lib-us.js` — gateway client + scoring. `scan-us.js` — scanner, same `{as_of, new_signals}` contract, diffed vs `seen-us.json`. `paper-us.js` — paper trader (`live` / `approve`), ledger `paper-us.json`. `doctor-us.js` — 15 self-checks. `pending-approvals-us.json`, `resolutions-us.json` (overrides).
- **International `paper.json`/`seen.json` checksums verified identical before/after all US runs.** The US stack never writes them. `phantom.html` app injection is **disabled** (`APP_INJECT_ENABLED=false` in paper-us.js) until cutover.

## 4. Verification results

- `scan-us.js`: exit 0, valid JSON; ~1100–1200 events, ~700 band+spread candidates, 2–5 new momentum signals per run; runtime ~50–70s (fine for 30-min cadence).
- `paper-us.js live`: opened 5 half-size ($50) paper positions across 2 runs (NFL total, tennis spread/ML); bankroll $700, equity ~$1,032.51, realized $0, savings $0. Grading ran clean (no resolutions yet — positions are hours from expiry).
- **Halt:** `halt.js on` → live run opened 0, grading continued → `halt.js off`. PASS.
- **Resolution grading (synthetic, scratch state):** position on settled-YES slug closed won +$100 `note:'settlement'`; settled-NO closed lost −$100; bankroll math exact. PASS.
- **Approval gate:** `approvalMode=true` → 2 signals queued, 0 opened; `approve` re-prices at BBO and correctly **refused** a synthetic entry repriced to 71.8¢ (out of the 40–60¢ band, kept in queue with `skip_reason`). PASS. Ledger restored clean afterward ($850→$700 across real runs only).
- `doctor-us.js`: **15/15 green**, including settlement YES/NO/unresolved probes, no-credentials scan, and intl-untouched check.
- Security: no keys, secrets, or order code paths anywhere in the US stack (paper only).

## 5. Cutover steps (AWAITING APPROVAL — do not run yet)

1. User approves the cutover in chat.
2. Let the international cron finish its current 30-min cycle; then update the `phantom-signal-monitor` cron definition: replace `node scan.js` → `node scan-us.js` and `node paper.js live` → `node paper-us.js live`. Update the cron's handoff instructions: signal reports now carry momentum fields (`chg_6h_c`, `chg_1h_c`, `max_adverse_c`, depth) with `wallets`/`prints`/`net_usd` null and `signal_basis: 'price-action'`.
3. In `paper-us.js`, set `APP_INJECT_ENABLED = true` so the Trading Agent tab shows the US ledger (it will then display `venue: 'polymarket-us'`).
4. Run `node doctor-us.js` (must exit 0), then one `node paper-us.js live` to confirm the app injection lands.
5. Retire the international scanner: leave `paper.json`/`scan.js` in place (archived history) but remove them from the cron. Optional: one final `paper.js live` to grade any remaining international opens to resolution — or leave them grading; do NOT delete the ledger.
6. Note the venue reality in the cron instructions: no esports, momentum model is v1-unproven, first 25+ clean resolutions should be reviewed before any scoring adjustments (standing rule).

## 6. Known limitations / open questions

- The momentum thresholds (4¢/6h, 1¢/1h, vote cutoffs) are starting heuristics with **zero backtest** on this venue. The first edge review should happen at ~25 graded US trades.
- `getUSClosedMarket` fallback passes `slug: undefined` in params (harmless — URLSearchParams drops it — but the closed-listing scan is capped at 50 events; the settlement endpoint is the primary path and works per-slug).
- Polymarket US books are thinner than international; the 500-share depth floor should be re-checked if the bot starts getting skipped on size.
- `sharesTraded`/`openInterest` semantics (24h vs cumulative) are unconfirmed; used as informational only.
