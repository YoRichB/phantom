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
