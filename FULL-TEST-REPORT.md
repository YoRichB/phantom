# Phantom — Full End-to-End Test Report
**Date:** 2026-10-13 03:10 UTC (Mon 2026-10-12 22:10 CDT)
**Scope:** backend (scan-us.js, paper-us.js, doctor-us.js, lib-us.js, cron) + frontend (phantom.html)
**Standing rules honored:** paper trading only, US venue only, no visual redesign.

## Summary
All areas green. No fixes were required. No code was changed during this test — the sibling agent's tab rewiring (uncommitted scan-us.js changes) was verified working and left untouched.

## Backend — GREEN

### Cron `phantom-signal-monitor`
- Exists, enabled, `interval@30m`. Last 6 runs reviewed.
- 21:48 CDT run (first US run) **failed** from Polymarket US gateway connection resets — a known issue; retry-with-backoff was already pushed in commit `62bc5ac`. Gateway is healthy now (doctor probes green).

### doctor-us.js — 15/15 PASS
Fresh run: gw:events ✓, gw:bbo ✓, gw:price-history (361 pts) ✓, gw:settlement ✓, gw:settlement-unresolved ✓, ledger:paper-us (bankroll=700, open=5 at check time) ✓, ledger:seen-us ✓, syntax on all 4 scripts ✓, ops:halt clear ✓, ops:pending-approvals 0 ✓, security:no-credentials ✓, intl:untouched ✓.

### scan-us.js (manual run) — PASS
- 1,100 events scanned, 664 candidates, 3 momentum signals, board 200 rows.
- App-pack write to phantom.html returned `ok`; us-pack JSON valid (signals 3, board 200, all distinct from signals).
- No gateway errors this run — retry/backoff path exercised earlier by the 21:48 failure, gateway now stable.

### paper-us.js live cycle — PASS
- Ran a full live cycle: opened 3 new positions (5 → 8 open), bankroll 700 → 500.
- Verified: entries only 40–60¢ (0 violations), stakes only $50/$100, max 10 open not exceeded, no duplicate slugs, **no duplicate events** (one position per event ✓).
- New positions: Bills vs Rams YES $100 @60¢, Cvetkovic vs Giza NO $50 @44¢, Haiyi Qin vs Bairo NO $50 @52¢.
- Exit ladder code-reviewed: partial TP at +100%, stop-loss −50%, near-expiry take (≤30 min, profitable), 6h stale reaper, settlement-first grading, delisted-at-last-mark fallback. (No closes yet — 0 graded US trades, so exits are untested live; expected with a 3-hour-old book.)
- Daily breaker: `MAX_DAILY_LOSS=300`, `canOpen()` blocks opens when day P&L ≤ −$300; day state initializes on first grade (currently null = correct pre-first-grade).
- Sweeps: $100 units, sweeps free cash above $1,000 base (0 sweeps so far — correct, nothing above base).

### Ledger integrity (paper-us.json) — PASS
- bankroll 500 + open risk 500 = 1000 ✓ (conservation, no leaks)
- equity 973.84 = 1000 + unrealized (−26.16) ✓
- venue: polymarket-us ✓, venue clean, no real-money paths touched.

### paper-state injection into phantom.html — PASS
- Fresh (0.5 min old at check), valid JSON, matches ledger: venue polymarket-us, bankroll 500, 8 open, equity 973.84.

### GitHub sync — PASS
- `phantom-github-sync` hourly, last 3 runs succeeded (latest 21:39 CDT). Sibling's uncommitted scan-us.js changes will ride the next auto-push (~22:39 CDT).

## Frontend — GREEN

### Syntax & packs
- Inline JS: 1 script, parses clean (`node --check` equivalent via vm.Script).
- us-pack and paper-state JSON both valid.

### Render test (DOM shim, real injected packs) — ALL OK
- Boot path prefers us-pack over SEED ✓ ("Polymarket US scan · 2m ago").
- Signals: 3 shown; Board: 200 shown; Whales: 0 → honest US empty state; Tracker: renders; Trading Agent: renders 8-open ledger.
- Badge counts match data on every tab; no exceptions anywhere.
- Filters (sort=price, q=tennis) and sort modes run clean on the US field set.
- Cards show momentum evidence (6h/1h ¢ change, depth) via `usMeta()`; whale fields hidden when null.

### SCAN button — PASS
- Retired with a clear note ("Scans run automatically every 30 min on Polymarket US"). No calls to the deprecated international gamma/data APIs remain in the app (grep confirmed).

### Sibling agent's tab work — verified, not redone
- Signals (3) vs Board (200) are distinct; skip-marked rows stay off Signals. Boot logic, us-pack slot, and card rendering all verified working end-to-end.

## Fixes made
None — nothing was broken. Deliberately did not commit: the only working-tree changes are the sibling's in-progress scan-us.js edit plus routine state files (paper-us.json, seen-us.json), which the hourly auto-sync will push.

## Open / needs no user decision (informational)
1. Next scheduled cron run (~22:18 CDT) will be the first clean end-to-end US cycle after the gateway recovery — worth a glance at its result summary, no action needed.
2. Zero graded US trades yet: exits, settlement grading, breaker, and sweeps are code-verified but live-untested until the first resolutions land. First scoring review stays at ~25 clean resolutions per the standing rule.
3. Sibling agent's final `APP-TABS-FIX.md` note is still pending; its code work is done and verified.
