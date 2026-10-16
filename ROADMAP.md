# Phantom Roadmap

Ordered by value. Checked items are done.

- [x] **Polymarket Protocol V2 readiness review** — DONE 2026-10-10, user
      accepted the "ready Phantom for the V2 switch" idea. Reviewed every
      Polymarket data read in the scanner, Trading Agent, and app against the
      published V2 migration (Protocol V2: new markets from 2026-11-02;
      Data API v1 retires 2026-10-24). Findings + fixes below. Trading logic,
      risk rules, and paper-only operation untouched — data-read layer only.
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
- [ ] **PWA hosting (native path)** — user chose PWA-first on 2026-10-12
      (then Android wrapper; iOS out). Prep landed 2026-10-15: iOS meta tags
      + `manifest.webmanifest` + `pwa/` icons in the repo, and the hourly
      GitHub sync now versions the live injected `phantom.html`. Next steps
      when he gives the go: enable GitHub Pages on the repo (serves
      `phantom.html` + manifest + icons over HTTPS), then add a minimal
      service worker so the installed app opens offline with the cached pack.
      Do not add the service worker before hosting — a SW on a file/chat
      attachment can't register and would be dead weight.
- [ ] **Clean-resolution counter** — supersedes the ping-at-~40 item: track
      `clean_resolutions` in paper.json, incremented only when a trade is
      graded by actual market resolution (closed-trade `note` null /
      true-resolution grade — stops, expiry-takes, and delisted-at-last-mark
      don't count). Monitor pings when it hits 25, the threshold the user
      set on 2026-10-09 before scoring weights get touched. Add a "Clean
      res." stat on the Trading Agent tab so the count is visible.
      (Idea logged 2026-10-10.)
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

---

## V2 readiness review (2026-10-10)

**Context.** Polymarket announced Protocol V2 (Oct 5, 2026): all new markets
move to V2 on 2026-11-02 (single ERC-1155 positions contract, pUSD collateral,
canary markets Oct 5–30). Separately, **Data API v1 retires 2026-10-24** —
that is the deadline that actually threatened Phantom, 9 days before the
protocol cutover. Verified against the published migration details and live
endpoint probes (not guessed).

**Data-read inventory and V2 status:**

| # | Read | Used by | V1 status | V2 status | Action |
|---|------|---------|-----------|-----------|--------|
| 1 | `data-api /trades?market=<id>` (per-market tape) | scan.js, paper.js, app SCAN | retires Oct 24 | **was broken** — v1 `market` param rejected on v2 | Migrated to `/v2/trades?condition=<id>` |
| 2 | `data-api /trades?limit=500` (global tape, fallback) | lib.js fetchTape | retires Oct 24 | **was broken** | Migrated to `/v2/trades?limit=500` |
| 3 | v2 trade object shape | scoreMarkets, app score(), whale board | — | **was broken** — `proxyWallet` renamed to `proxy_wallet`; `{data,pagination}` envelope | Unwrap `.data`; accept both field names |
| 4 | `gamma-api /markets` (list, top-80 by volume24hr) | scan.js, paper.js, app SCAN | not retired | OK — live 200; already exposes `version`/`positionIds` for V2 markets | None; watch item below |
| 5 | `gamma-api /markets?slug=` (position grading lookup) | paper.js marketState | not retired | OK — live 200 | None |
| 6 | `gamma-api /public-search` (delisted-market fallback) | paper.js marketState | not retired | OK — live 200 | None |

**Fixes applied (data-read layer only):**
- `lib.js`: `fetchTape()` now hits `/v2/trades?condition=<id>&limit=100`
  (one request per market — a batched `condition=a,b,…` call applies `limit`
  per-request and starves per-market coverage, verified live), unwraps the
  `{data,pagination}` envelope, falls back to the v2 global feed. `scoreMarkets`
  accepts `proxy_wallet` or legacy `proxyWallet`.
- `scan.js`, `paper.js`: use `fetchTape()` (v2). No trading-logic changes.
- App (`phantom.html`, both copies): SCAN uses the v2 endpoint + envelope
  unwrap; scoring and the live whale board accept both wallet field names.
- `doctor.js`: 3 new V2 checks run every cycle — gamma `version`
  distribution across the top-80, scoring-field shape of any non-v1 market
  that appears, and the v2 trades endpoint/envelope shape.

**Verified working after the fix (live, 2026-10-10):** scan.js via v2 tape
found signals (e.g. LoL Cupid vs Disguised, 100 prints / 51 wallets);
paper.js live ran clean (bankroll/equity/realized consistent, day-PnL
accounting verified); doctor.js 17/17 green.

**Watch items (not broken today):**
- No V2-versioned markets in gamma's top-80 yet (all `version:"v1"` as of
  2026-10-10; canary markets run through Oct 30). When V2 markets appear,
  the doctor's `v2:gamma-v2-shape` check will flag any missing scoring
  fields (`outcomePrices`, `bestBid`/`bestAsk`, `spread`, `liquidity`,
  `endDate`) before the bot can mis-score them.
- Data API v1 goes dark 2026-10-24 — all reads are already on v2, so no
  action remains, but the doctor's `v2:data-api-trades` check guards it.
- Protocol V2 cutover 2026-11-02 affects on-chain positions, not these
  read APIs; the paper bot never touches contracts, so no impact expected.
