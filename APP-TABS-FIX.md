# App tabs fix — Signals/Board live on Polymarket US (2026-10-13)

## Problem
The app booted from a hardcoded Oct 7 international `SEED`; the 30-min cron had
moved to Polymarket US but only the Trading Agent tab got fresh state. Board and
Signals showed the same stale snapshot, and the SCAN button hit the dead
international gamma API.

## What changed

**Server side — `scan-us.js`**
- After each scan it now calls `writeAppPack()`, which injects the latest US
  results into the live app file (`~/workspace/goals/phantom-signal-monitor/files/phantom.html`)
  as `<script id="us-pack" type="application/json">`:
  - `signals` — momentum signals (full/half) with `signal_basis:'price-action'`,
    `chg_6h_c`, `chg_1h_c`, `max_adverse_c`, `bid_depth_shares`, `ask_depth_shares`
  - `board` — all screened candidates; signal rows first, then `size:'skip'` rows
    the model passed over (cap 200). Signals tab filters `r.size!=='skip'`, so the
    two tabs are now distinct by construction.

**App — `phantom.html`**
- Boot paints the injected US pack instantly (SEED kept as offline fallback only).
- **Auto live-scan on page load** (added per user request): after first paint the
  app runs a real in-browser scan against `https://gateway.polymarket.us`
  (verified CORS-open): pages active events → screens candidates → reads L2
  books → scores 6h price-action momentum with the same model as `scan-us.js`
  (6h drift ≥4¢, 1h ≥1¢, whipsaw guard, depth ≥500 shares/side, 3-of-4 votes).
  Skeletons + progress in the meta line while it runs.
- SCAN button kept as manual refresh; a `scanRunning` guard prevents the
  auto-run and the button from double-firing.
- On scan failure: falls back to the cached pack with a small inline note.
- Cards: momentum evidence line (6h/1h change in cents, depth) on price-action
  rows; whale fields (prints, wallets, net USD flow) hidden when null instead of
  showing $0. No visual redesign — same cards, same styling.
- Stats row is venue-aware (Signals/Board/Full-size/Avg spread for US;
  whale/volume stats only for the old international packs).
- Whales tab: honest empty state — "No whale tape on Polymarket US public data".
  Tab kept (cleaner than hiding; the venue simply has no public trade tape).
- Trading Agent tab untouched: still renders from `script#paper-state` injected
  by `paper-us.js`.

## Verification
- `node --check` on extracted app JS: OK.
- In-browser model functions extracted and run against the live US gateway:
  200 events paged, 246 candidates passed screens, 10/10 books read, 361 history
  points per market (6h minute data), scoring pipeline produced signal-shaped
  rows. (0 signals in the 10-market sample — the bar is strict by design.)
- Rendering: 5/5 node extraction tests on card/stats/whale/tab-filter logic.
- Live pack in the app at time of fix: 11 US signals, 200-row board, 8 open
  paper positions ($973.84 equity) — Signals/Board/Trading Agent all distinct.
- Committed + pushed to `github.com/YoRichB/phantom`:
  `0d6bf36` (pack injection, momentum cards, whales empty state),
  `bfb52d2` (auto live-scan on load, double-fire guard).

## Notes
- A full in-browser scan is heavy (~11 event pages + ~2 requests per candidate);
  fine on WiFi, noticeable on cellular. The 30-min server scan remains the
  primary refresh; the in-browser pass is for on-demand freshness.
- Repo copy `phantom.html` is the clean template (state slots reset to
  `null`/`{"none":true}`); the live file under `goals/.../files/` carries the
  injected state.
