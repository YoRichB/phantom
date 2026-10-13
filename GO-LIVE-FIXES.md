# Phantom Go-Live Must-Fixes — Verification Summary
**Done:** 2026-10-13 ~02:25 UTC · **Commit:** `82e580c` · **Pushed to:** github.com/YoRichB/phantom (private, main)
**Standing decision:** STAY PAPER (user, 2026-10-12). No live money, no accounts, no real orders anywhere in this work.

Untouched, as instructed: $1,000 wallet, $100/$50 stakes, 40–60¢ entry band, −$300 breaker level, max 10 open, one-position-per-event, savings-sweep rule, scoring weights.

---

## Fix 1 — Scanner migrated off the deprecated gamma endpoint ✅
**Problem:** `scan.js` and `paper.js` read markets from gamma `/markets` (offset pagination), which returns `deprecation: true` + `warning: 299 "use /markets/keyset"`.

**What changed:**
- `lib.js`: new `getMarkets(params)` — calls `https://gamma-api.polymarket.com/markets/keyset`, unwraps the `{markets, next_cursor}` envelope (tolerates a bare array).
- `scan.js`, `paper.js` `live()`, `paper.js` `marketState()`: all market reads now go through `getMarkets()`.
- Verified the replacement returns the same market object shape and ordering (80 markets, volume24hr descending, all fields the scorer needs).

**Verified:** `scan.js` exits 0 with valid JSON; the scoring pipeline produces 18 full/half intraday signals from keyset data (same contract, `seen.json` diffing untouched); `doctor.js` exit 0 with the gamma checks now hitting the keyset endpoint.

## Fix 2 — Grading on verified Polymarket resolutions ✅
**Problem:** 36–37 closed trades were settled at last-known marks after markets vanished from the API; only 1 grade was a true resolution.

**What changed:**
- `paper.js` `marketState()`: after the active listing, queries `keyset?closed=true&slug=` — closed/resolved markets are still queryable there and carry the true outcome in `outcomePrices` (`["1","0"]` = YES won). Public-search exact-match remains as fallback.
- `regrade.js` (new, one-shot): backed up `paper.json` → `backups/paper-2026-10-13-pre-resolution-grading.json`, then re-graded every mark-settled trade against its true resolution. Bankroll/day-P&L/savings were recomputed by a chronological replay of the ledger's cash flows, which was **validated first**: the replay reproduced the old ledger's savings ($400 / 4 sweeps) exactly before anything was written.

**Before → after (the honest numbers):**

| Metric | Mark-based (before) | Verified resolutions (after) |
|---|---|---|
| Realized P&L | +$827.60 | **+$576.12** |
| Wins / Losses | 37W / 32L (69 closed) | **42W / 27L** |
| Verified-resolution grades | 1 of 69 | **34 of 69** |
| Still approximations | 36 | **3** (recent markets, unresolved/unfindable) |
| Bankroll | $927.60 | $776.12 |
| Savings | $400 (4 sweeps) | $300 (3 sweeps) |

The mark-based ledger was **overstating profit by ~$251**. The edge is still positive on true outcomes, but smaller than reported — exactly why this fix was must-fix. (After the fix, one routine run graded 3 more positions on the new resolution path: NRG −$100, Gatto $0 stale, San Luis −$100 → current realized +$376.12, 72 closed, bankroll $876.12, 2 open.)

## Fix 3 — Live order-execution module (built, dark by default) ✅
**What changed:** `live.js` (new, ~560 lines), built by a dedicated subagent:
- Credentials from **environment only** (`POLY_CLOB_API_KEY/SECRET/PASSPHRASE`, `POLY_WALLET_PRIVATE_KEY`) — never hardcoded, never written to files, never logged; placeholders rejected.
- **Master switch default OFF**: enabled only with `LIVE_TRADING_ENABLED=1` + explicit `enableLive({ iUnderstand: true })` + no `HALT` file.
- **Per-trade human approval**: `requestApproval()` queues to `pending-approvals.json`; `approveTrade(id, { by })` is human-operator-only; `placeOrder()` consumes one fresh (<24h) approval or throws.
- Injectable transport (real Polymarket CLOB client via `@polymarket/clob-client` v5.8.1, installed to `node_modules/`, gitignored); slippage + partial-fill model (`simulateFill`) and a realistic re-paper-trade path (`repaperTrade`).
- `node live.js selftest`: **26/26 pass, exit 0, zero real network calls** (fetch guard fails on any real request to trading endpoints).

**Caveat:** the real transport has never been exercised against real credentials — doing so would violate the stay-paper mandate. Nothing in the cron, `paper.js`, or scanner imports `live.js`.

## Fix 4 — Kill switch + human approval gate ✅
**What changed:**
- `halt.js` (new): `node halt.js on [reason] | off | status`. Creates/removes `DIR/HALT`.
- `paper.js` `live()`: when `HALT` exists, **zero new opens** (verified live: halted run opened 0 while grading 3 exits normally). `canOpen()` also returns `'halted'`.
- `paper.js` approval mode: `state.approvalMode = true` queues candidate opens to `pending-approvals.json` instead of opening; `node paper.js approve [id]` opens them **re-priced at approve time** (the 40–60¢ filter re-runs on the current book). Paper default stays automatic (`approvalMode: false`, restored after testing).
- `live.js` refuses to enable or place while `HALT` exists.
- `doctor.js`: new informational `ops:halt` and `ops:pending-approvals` checks; syntax checks cover all new files; gamma checks use the keyset endpoint.

**Verified:** halt on → 0 opens / grading continues → halt off → normal. `doctor.js` exit 0 (23 checks green).

## Out of scope (not done)
- **US-account decision** — the user's call, explicitly excluded. Nothing opened, funded, or touched.
- **Should-haves** (breaker that freezes all activity + exits opens, depth-aware sizing, cron-failure alerting, tax export) — parked; the breaker-upgrade is noted in a `paper.js` code comment.
- **Scoring weights** — untouched per the standing 25-clean-resolutions rule (now at 34 verified — the review's nice-to-have #10 is unblocked whenever the user wants it).
