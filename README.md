# Phantom — Polymarket Intraday Tape Scanner

Phantom watches Polymarket's intraday markets, scores them against live tape
(prints, unique wallets, buy/sell flow), and paper-trades the best signals
against a simulated **$100 wallet**. Paper only — it never touches real money.

## What's here

| File | What it does |
|---|---|
| `lib.js` | Shared fetch + Phantom scoring logic |
| `scan.js` | 30-min monitor: finds **new full-size** intraday signals, dedupes via `seen.json` |
| `paper.js` | Paper-trading bot: opens/grades positions, keeps the ledger in `paper.json`, injects live state into the app's Bot tab |
| `doctor.js` | Background self-check: validates scripts, state files, dashboard freshness, API reachability |
| `phantom.html` | The single Phantom app (signals, board, whales, tracker, bot tabs) — template copy of the user-facing app |

Runtime state (`paper.json`, `seen.json`, `resolutions.json`) is git-ignored.

## How signals are scored

Each market gets up to 3 votes: deep liquidity (≥$32k), tight spread (≤3¢),
and real tape (≥3 prints or ≥3 wallets). A signal needs ≥2 votes plus
confirmation, then:

- **FULL** (3 votes, ≥3 wallets): stake $10
- **HALF** (2 votes + confirmed): stake $5

Only markets resolving within 48 hours are traded. Scan alerts fire on new
FULL signals; the bot trades both sizes.

## Paper-trading semantics

- A **BUY** signal = buy **YES** at the ask (honest fill).
- A **SELL** signal = buy **NO** at `1 − bid` (the executable equivalent for a
  cash wallet — not a short sale).
- Stake = wallet cash risked. Shares = stake ÷ entry price. Each share pays $1.
- A new position opens only if the stake fits in free cash, fewer than 10
  positions are open, and today's realized P&L is above −$30 (daily breaker).

## Exit policy (research-backed)

Holding every position to resolution leaves money on the table and lets
losers bleed. Each run re-marks open positions and:

- **+100% partial take-profit** — sell half, let the rest ride to resolution
- **−50% stop-loss** — exit the full position
- **Near-expiry take** — under 30 minutes to resolution and green: exit all
- **Stale reaper** — 6+ hours past expiry with no resolution: settle at mark
- Verified resolutions for delisted markets live in `resolutions.json`

## Running it

```bash
node scan.js          # one monitor sweep (JSON of new full signals)
node paper.js live    # score, open, grade, inject state into app
node paper.js backfill # one-time: enter the seed scan as positions
node doctor.js        # self-check; exits 0 clean, 1 with findings
```

In production this runs on a 30-minute schedule. Each run rebuilds the
unified app at `~/workspace/your_files/phantom.html` (paper.js injects the bot state into its Bot tab each run; this file is the user-facing copy, this repo holds the template).

## Honest limitations

- **Paper only.** No real orders, no wallet, no keys — by design.
- Signals come from the **polymarket.com** feed. US users trade on the separate
  polymarket.us product, which lists different markets; not every signal is
  executable there.
- One day of data proves nothing. The bot needs 30–50 graded signals before
  its win rate means anything.
- Not financial advice. This is an experiment in tape-reading, not a strategy.
