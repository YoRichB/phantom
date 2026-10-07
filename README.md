# Phantom — Polymarket Intraday Tape Scanner

Phantom watches Polymarket's intraday markets, scores them against live tape
(prints, unique wallets, buy/sell flow), and paper-trades the best signals
against a simulated **$100 wallet**. Paper only — it never touches real money.

## What's here

| File | What it does |
|---|---|
| `lib.js` | Shared fetch + Phantom scoring logic |
| `scan.js` | 30-min monitor: finds **new full-size** intraday signals, dedupes via `seen.json` |
| `paper.js` | Paper-trading bot: opens/grades positions, keeps the ledger in `paper.json`, rebuilds the dashboard |
| `doctor.js` | Background self-check: validates scripts, state files, dashboard freshness, API reachability |
| `scanner.html` | Standalone browser UI (cards, whales, manual paper tracker) — copy of the user-facing app |

Runtime state (`paper.json`, `seen.json`, `resolutions.json`) is git-ignored.

## How signals are scored

Each market gets up to 3 votes: deep liquidity (≥$32k), tight spread (≤3¢),
and real tape (≥3 prints or ≥3 wallets). A signal needs ≥2 votes plus
confirmation, then:

- **FULL** (3 votes, ≥3 wallets): stake $20
- **HALF** (2 votes + confirmed): stake $10

Only markets resolving within 48 hours are traded. Scan alerts fire on new
FULL signals; the bot trades both sizes.

## Paper-trading semantics

- A **BUY** signal = buy **YES** at the yes price.
- A **SELL** signal = buy **NO** at `1 − yes` (the executable equivalent for a
  cash wallet — not a short sale).
- Stake = wallet cash risked. Shares = stake ÷ entry price. Each share pays $1.
- A new position opens only if the stake fits in free cash.
- Grading: the market is fetched by slug from the Gamma API; when
  `closed=true` and `outcomePrices` show a winner, the position settles.

## Running it

```bash
node scan.js          # one monitor sweep (JSON of new full signals)
node paper.js live    # score, open, grade, rebuild dashboard
node paper.js backfill # one-time: enter the seed scan as positions
node doctor.js        # self-check; exits 0 clean, 1 with findings
```

In production this runs on a 30-minute schedule. Each run rebuilds the
dashboard at `phantom-paper-trader.html` (user-facing copy).

## Honest limitations

- **Paper only.** No real orders, no wallet, no keys — by design.
- Signals come from the **polymarket.com** feed. US users trade on the separate
  polymarket.us product, which lists different markets; not every signal is
  executable there.
- One day of data proves nothing. The bot needs 30–50 graded signals before
  its win rate means anything.
- Not financial advice. This is an experiment in tape-reading, not a strategy.
