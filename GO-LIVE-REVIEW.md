# Phantom Trading Agent — Go-Live Readiness Review
**Written:** 2026-10-12 ~20:45 CDT · **Ledger read at time of review:** 68 closed trades, 6 open positions
**Read-only analysis.** No changes made to paper.json, seen.json, phantom.html, or trading rules.

---

## 1. Current state snapshot

| Metric | Value |
|---|---|
| Bankroll (free cash) | $832.23 |
| Equity | ~$1,390.84 |
| Realized P&L | +$832.23 (on $1,000 paper base) |
| Savings swept | $400 (4 × $100 sweeps, all on 2026-10-11) |
| Open positions | 6 ($600 at risk): NRG vs LOUD YES @42¢, Melissa Gatto vs Ernesta Kareckaite NO @50¢, Atlético San Luis YES @45¢, Rams (-3.5) spread YES @49¢, Timberwolves vs Knicks YES @54¢, HANJIN BRION vs LGD Gaming YES @48¢ |
| Signals skipped (out-of-band / filters) | 490 |
| Stakes used | 64 full ($100), 4 half ($50) |
| Today's day P&L (UTC) | −$181.28 (two stop-outs: LOS vs KaBuM G3 −$99.91, Golden Knights vs Wild −$81.37) — within the −$300 breaker |

## 2. Trade-record analysis (68 closed trades)

- **Record:** 37 wins / 31 losses — **54.4% win rate**
- **Net P&L:** +$832.23 · **Avg win:** $46.18 · **Avg loss:** −$28.27
- **Profit factor:** 1.95 (makes ~$2 for every $1 lost)
- **Best win:** +$143.78 (Dota 2: PARIVISION vs Aurora Game 2) · **Worst loss:** −$99.91 (LOS vs KaBuM Game 3)
- **Best win streak:** 6 · **Worst loss streak:** 4
- **Day-by-day closed P&L:** 10-10: 15 trades, +$374.67 · 10-11: 34, +$317.97 · 10-12: 17, +$320.87 · 10-13 (UTC): 2, −$181.28
- **Entry-price band:** all 68 entries were 40–60¢ (the 2026-10-09 price-window filter is in place for the whole ledger)
- **By exit reason:**
  - delisted_settled_at_last_mark: 36 trades, +$1,014.29
  - expiry-take: 19 trades, +$507.97
  - stop-loss: 12 trades, −$828.13
  - verified resolution: 1 trade, +$138.10 (UFC: Niko Price vs Leon Shahbazyan)
- **By category (market name):**
  - Esports (Dota 2, LoL, CS, Valorant, game/map handicaps): **18 trades, 12W/6L, +$783.09**
  - Everything else (NFL/NBA/MLB/soccer/UFC): **50 trades, 25W/25L, +$49.14** — essentially flat

## 3. What the numbers do and don't prove

**They do show:** a positive expectancy over 68 trades at 54.4% win rate, driven almost entirely by esports signals (+$783 of the +$832 net). The 40–60¢ entry filter is doing its job — this whole ledger was traded under it.

**They don't prove a live-ready edge, because:**
- **Only 1 of 68 grades is a verified market resolution.** The other 67 are exit-mark approximations: 36 settled at the last known mark after the market vanished from the API, 19 near-expiry mark exits, 12 stop-loss mark exits. The standing bar was 30–50 graded trades before reconsidering live — we've passed the count, but on approximated marks, not true resolutions.
- **The profit is concentrated.** 26% of trades (esports) carry 94% of the profit. The non-esports book is breakeven across 50 trades. That looks like edge in one niche, not a general strategy.
- **Stop-losses can blow past −50%.** Grading runs on a 30-min cadence, so a market that crashes between checks exits at the worse price — two losses of −$100 and −$99.91 on $100 stakes (near-total losses) confirm this. The "−50% stop" is really "stop at the next check," sometimes at zero.
- **Today is −$181.28.** Two more full stop-outs would land at −$281+, one hair from the −$300 breaker — and the breaker only blocks *new* opens; the 6 open positions keep bleeding if markets turn.

## 4. Gap analysis — what stands between paper and real money

**Resolution grading.** paper.js grades at marks (see §3). A live bot must grade against Polymarket's actual resolutions (outcome data) before any P&L number means anything. Currently it also trusts a manual overrides file (`resolutions.json`); that file has been near-empty.

**Live execution — doesn't exist.** No API keys, no wallet, no order routing, no fill confirmation, no slippage model. Paper assumes fills at the ask on 3¢-spread, $32k+ liquidity markets; real $100 orders on thin intraday books will move the price, especially near expiry. Entry prices in the ledger are aspirational.

**US account constraint — this is the big structural one.** US accounts are close-only on Polymarket's international product, where all of this liquidity lives. The scanner's signals are BUY opens (490 skips, and nearly every taken signal is a new position). From a US account, effectively **0% of the current strategy's trades would be executable** — there is no long-only BUY strategy on a close-only account. Options: fund and operate a non-US entity account, or the strategy doesn't go live at all.

**Risk controls, reviewed for real money:**
- −$300/day breaker: reasonable size (30% of bank) but toothless — it blocks new opens only; existing positions keep running.
- Max 10 open ($1,000 risk on a $1,000 bank): too much for live. Position cap should be sized to the *bank*, not the count.
- One-position-per-event: working, keep.
- 40–60¢ entry band: proven by the data, keep.
- Savings sweeps: fine for live too.
- **Missing:** a kill switch (no manual halt path in code), human-in-the-loop approval on opens, per-market size limits relative to book depth, and a realized-loss breaker that also *exits* open positions.

**Operational gaps.** No alerting when the 30-min cron fails (silent = stale positions). No trade/fill log that would satisfy tax reporting (every Polymarket trade is a taxable event). No fee accounting — Polymarket itself charges no trading fees on most markets, but USDC on/off-ramps and spread costs aren't modeled.

**Code audit (doctor.js / scan.js / paper.js).**
- scan.js pulls the top-80 markets from gamma API **v1**, which retires **2026-10-24** (~2 weeks out). The scan dies then regardless of live plans. `/v2/trades` was already migrated; market reads were not. Must-fix on a hard deadline.
- gradeAll's exit ladder is reasonable but mark-based; the verified-resolution path exists and is barely used (1/68).
- No auth, no keys, no kill switch, no approval gate — all by design for paper, all absent for live.

## 5. Prioritized change list

**Must-fix before any live dollar:**
1. Migrate scan.js off gamma API v1 before **2026-10-24** (scanner stops otherwise).
2. Grade on verified Polymarket resolutions, not marks — rewrite the grading path and backfill; don't trust the +$832 figure until re-graded.
3. Decide the US-account question (§6) — without a tradeable account there is no live strategy.
4. Build live order execution: keys, order placement, fill confirmation, slippage/partial-fill modeling; re-paper-trade with realistic fills before going live.
5. Kill switch + human approval on new opens (at minimum a manual halt that stops opens and exits).

**Should-have:**
6. Breaker that freezes *all* activity and optionally exits opens, not just blocks new entries.
7. Position sizing relative to book depth (stake vs. top-of-book size), not flat $100.
8. Cron-failure alerting (if a run fails, someone hears about it within the hour).
9. Trade ledger exportable for taxes (timestamps, fills, fees, resolutions).

**Nice-to-have:**
10. Re-run the scoring review on *clean resolutions only* (25+ true resolutions per the standing ROADMAP plan) before touching scoring weights.
11. Esports-only mode toggle — the data says the edge lives there.

## 6. The one decision needed from the user

**How do you want to solve the US-account problem?** The strategy as built cannot run on a US Polymarket account (close-only). The realistic options are: (a) set up and fund a non-US entity account — legal/compliance work you should own, not me; (b) accept the constraint and stay paper; or (c) redesign for a US-regulated venue (different markets, different liquidity, the edge doesn't transfer). Everything else on the must-fix list is engineering I can do; this one is yours.
