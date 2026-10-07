# Phantom Roadmap

Ordered by value. Checked items are done.

- [x] Tape-scored scanner (liquidity / spread / prints / wallets)
- [x] 30-minute background monitor with new-signal alerts
- [x] Paper-trading bot on a simulated $100 wallet (BUY=YES, SELL=NO math)
- [x] Auto-grading on market resolution + live dashboard
- [x] Background self-check (`doctor.js`)
- [ ] **Fix the browser app's tracker math** — the HTML tracker's SELL
      handling still uses premium-received semantics; convert it to
      BUY YES / BUY NO like the bot
- [ ] **Exits before resolution** — take-profit / stop-loss and time-based
      exits instead of always holding to settlement
- [ ] **Sizing options** — flat stakes work, but add fractional-Kelly as an
      alternative and compare both on the ledger
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
