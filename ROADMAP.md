# Phantom Roadmap

Ordered by value. Checked items are done.

- [x] Tape-scored scanner (liquidity / spread / prints / wallets)
- [x] 30-minute background monitor with new-signal alerts
- [x] Paper-trading bot on a simulated $100 wallet (BUY=YES, SELL=NO math)
- [x] Auto-grading on market resolution + live dashboard
- [x] Background self-check (`doctor.js`)
- [x] **Fix the browser app's tracker math** — SELL signals now grade as
      buy-NO at (1 − yes); signal language is BUY YES / BUY NO
- [x] **Exits before resolution** — +100% partial take-profit, −50% stop,
      near-expiry take, stale reaper
- [x] **Sizing options** — flat stakes cut to $10/$5 so the $100 wallet stays
      deployed across ~10 positions instead of saturating at 5; Kelly still open
- [ ] **Longer backtest** — replay weeks of historical tape + resolutions
      instead of judging on one day
- [ ] **US-market mapping** — match .com signals to polymarket.us listings so
      alerts say what's actually tradable in the US
- [ ] **Alert channels** — push new FULL signals to Telegram/Discord, not just chat
- [ ] **Whale watch expansion** — track repeat wallets across signals, weight
      signals they touch
- [ ] **Ledger stats** — profit factor, win rate by sport/side/size, equity
      drawdown on the dashboard
- [ ] **Stale-position reaper** — auto-flag positions past expiry + N hours
      with no resolution so they don't sit open forever
- [ ] **Grade-count milestone** — monitor notes when closed trades cross ~40
      graded and pings, since that is when the user accepted the scoring
      review (feed win/loss back into signal weights) becomes due
  - CHECKPOINT 2026-10-09 ~12:50 PDT: ledger at 37 graded (19 W / 18 L,
    51.4% win rate, profit factor 0.91, realized -$8.92 paper, bankroll
    $36.08 with 7 open). Honest read: 36 of 37 grades are exit-mark
    approximations (14 stop-loss, 4 expiry-take, 18 delisted settled at
    last mark) — only 1 true resolution. Feeding this into scoring now
    would fit noise, not edge. Decision with user: hold scoring changes
    until N *clean* resolutions (suggested: 25), or proceed anyway.
    Ping-at-~40 is NOT implemented in paper.js/scan.js yet — wire it or
    retire this checkbox.
- [x] **39-trade scoring review** — DONE 2026-10-09 ~18:45 PDT, user
      authorized ("make any adjustments as needed"). Findings from 39
      graded paper trades (20W/19L, PF 0.97, realized -$2.66):
      * Entry price is the dominant factor. Prices paid 40-60c: 14 trades,
        9W/5L, +$33.93. Every other band loses: 0-20c went 0W/5L (-$27.37),
        20-40c -$6.90, 60-80c -$6.86, 70-100c only +$6.61 on 5 trades.
      * Holds for both stake sizes: full stakes win +$28.81 in 40-60c and
        lose -$12.83 outside; half stakes win +$5.12 inside, lose -$23.76
        outside. So the earlier half-stake drag was price, not sizing.
      * Stop-loss exits: 14 trades for -$96.94 total (avg -$6.92) — but
        stops are spread across all bands, so they're a symptom of bad
        entries, not a broken exit. Exit mechanics unchanged.
      * Caveat from the 12:50 checkpoint still stands: most grades are
        exit-mark approximations (stops, expiry-takes, delisted-at-mark),
        not clean resolutions. The 40-60c edge leans partly on
        delisted-settled wins (+$45.18 of the band's +$33.93) — still the
        best available proxy, but don't overclaim it.
      Adjustment made: `paper.js` `openPosition()` now skips any signal
      whose actual paid price is outside 40-60c (returns 'price-window',
      counted in `skipped`). This is an entry filter, not a scoring-weight
      change; scoring weights still untouched. If the window stops
      producing, widen to 35-65c or revisit after 25 clean resolutions.
---
- DONE 2026-10-07: one-position-per-event cap (was: $20/$30 on Spirit vs M80 via Map2+Series). Next after 30-50 graded: feed win/loss back into scoring weights.
