// Phantom paper-trading bot. Simulates trading the scanner's intraday signals
// against a $1,000 starting wallet. Paper only — never touches real money.
//
//   node paper.js backfill   one-time: enter this morning's seed signals
//   node paper.js live       every 30 min: score, open new positions, grade opens
//   node paper.js approve [id]  open queued signals (only used when approvalMode is on)
//
// Kill switch: if DIR/HALT exists, live() opens NOTHING (grading and exits
// keep running so positions can still close). Toggle with `node halt.js on|off`.
// Approval mode: when state.approvalMode is true, candidate opens are queued
// to pending-approvals.json instead of opening; a human opens them with
// `node paper.js approve`. Paper default is automatic (approvalMode false);
// live trading must run with approvalMode true (enforced in live.js).
//
// Semantics: a BUY signal = buy YES at the ASK (honest fill);
// a SELL signal = buy NO at (1 - BID). Stake = wallet cash risked.
// Sizing: full = $100, half = $50. Never open if stake > available cash.
// Exits: +100% partial take-profit (sell half, ride the rest),
// -50% stop-loss, near-expiry (<30 min) profit take, stale reaper (>6h past
// end). Daily breaker: no new opens once day P&L <= -$300. Max 10 open.
const fs = require('fs');
const path = require('path');
const { getJSON, getMarkets, fetchTape, scoreMarkets } = require('./lib');
const DIR = '/home/hatch/workspace/phantom-signal-monitor';
const PAPER = path.join(DIR, 'paper.json');
const HALT_FILE = path.join(DIR, 'HALT');
const PENDING_FILE = path.join(DIR, 'pending-approvals.json');
const isHalted = () => fs.existsSync(HALT_FILE);

function loadPending(){
  try { const p = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); return Array.isArray(p) ? p : []; }
  catch(e){ return []; }
}
function savePending(p){ fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(PENDING_FILE, JSON.stringify(p, null, 1)); }

const START = 1000;
const STAKE = { full: 100, half: 50 };
const TP_AT = 1.0;          // +100% unrealized -> sell half
const SL_AT = -0.5;         // -50% unrealized -> exit all
const EXPIRY_TAKE_MIN = 30; // <30 min to end + green -> exit all
const STALE_AFTER_H = 6;    // >6h past end, unresolved -> settle at mark
const MAX_OPEN = 10;
const MAX_DAILY_LOSS = 300;
const r2 = n => Math.round(n * 100) / 100;

function load(){
  try { return JSON.parse(fs.readFileSync(PAPER, 'utf8')); }
  catch(e){ return { start_bankroll: START, bankroll: START, positions: [], closed: [], skipped: 0, savings: 0, sweep_log: [], day: null, history: [] }; }
}
function save(s){ fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(PAPER, JSON.stringify(s, null, 1)); }

const tradedSlugs = s => new Set([...s.positions, ...s.closed].map(p => p.slug));

// sig: {market, slug, yes, bid, ask, side:'BUY'|'SELL', size, end}
function openPosition(state, sig, entryTime){
  const stake = STAKE[sig.size];
  if (!stake || tradedSlugs(state).has(sig.slug)) return 'dup';
  if (stake > state.bankroll) { state.skipped++; return 'skipped'; }
  const yesSide = sig.side === 'BUY';
  // Honest fills: pay the ask on YES, i.e. 1 - bid on NO.
  const entryPrice = yesSide ? (sig.ask || sig.yes) : (1 - (sig.bid || sig.yes));
  if (!(entryPrice > 0 && entryPrice < 1)) return 'badprice';
  // Price-window filter (added 2026-10-09 after 39-trade review):
  // entries priced 40-60c are 9W/5L for +$33.93; every other band is negative
  // (0-20c alone went 0W/5L for -$27.37). Skip anything outside the window.
  if (entryPrice < 0.40 || entryPrice > 0.60) { state.skipped++; return 'price-window'; }
  const shares = stake / entryPrice;
  state.bankroll = r2(state.bankroll - stake);
  state.positions.push({
    id: sig.slug + '@' + entryTime, slug: sig.slug, market: sig.market,
    side: yesSide ? 'YES' : 'NO', signal: sig.side, size: sig.size,
    entry_yes: r2(sig.yes * 10000) / 10000, entry_price: r2(entryPrice * 10000) / 10000,
    stake, shares: r2(shares * 100) / 100,
    cash_in: 0, tp_taken: false,
    opened_at: entryTime, end: sig.end || null, status: 'open'
  });
  return 'opened';
}

function bumpDay(state, pnl){
  const d = new Date().toISOString().slice(0, 10);
  if (!state.day || state.day.date !== d) state.day = { date: d, pnl: 0 };
  state.day.pnl = r2(state.day.pnl + pnl);
}

// Profit savings (user rule, 2026-10-09): whenever free bankroll sits $100+
// above the $1,000 base, sweep the excess in $100 chunks into savings.
// Never takes bankroll below $1,000. Runs after grading so only realized,
// risk-free cash moves; sweeps are not trading P&L, so day.pnl is untouched.
const SWEEP_UNIT = 100;
function sweepProfits(state, t){
  const excess = r2(state.bankroll - START);
  const units = Math.floor(excess / SWEEP_UNIT);
  if (units < 1) return 0;
  const amount = units * SWEEP_UNIT;
  state.bankroll = r2(state.bankroll - amount);
  state.savings = r2((state.savings || 0) + amount);
  (state.sweep_log = state.sweep_log || []).push({ t, amount });
  return amount;
}

// Gate for new opens: kill switch, daily loss breaker, max open positions.
// SHOULD-HAVE (review 2026-10-12): upgrade the breaker so that when it trips
// it also freezes ALL activity and exits open positions instead of only
// blocking new entries. Not done: would change the -$300 semantics the user
// approved; parked until he asks.
function canOpen(state){
  if (isHalted()) return 'halted';
  const d = new Date().toISOString().slice(0, 10);
  const dayPnl = (state.day && state.day.date === d) ? state.day.pnl : 0;
  if (dayPnl <= -MAX_DAILY_LOSS) return 'daily-breaker';
  if (state.positions.filter(p => p.status === 'open').length >= MAX_OPEN) return 'max-open';
  return null;
}

async function marketState(slug){
  try {
    // 1) Active listing via gamma /markets/keyset (migrated 2026-10-13).
    let m = (await getMarkets({ slug }))[0];
    if (!m) {
      // 2) Closed/resolved markets leave the active listing — they are still
      // queryable with closed=true, and carry the true resolution in
      // outcomePrices (["1","0"] = YES won). This is the source of truth for
      // resolution-based grading (2026-10-13).
      m = (await getMarkets({ slug, closed: 'true' }))[0];
    }
    if (!m) {
      // 3) Gamma's slug index can drop markets entirely; fall back to
      // public-search and exact-match the slug (verified 2026-10-07).
      try {
        const sr = await getJSON('https://gamma-api.polymarket.com/public-search?q=' + encodeURIComponent(slug));
        outer:
        for (const e of ((sr && sr.events) || [])) {
          for (const mk of (e.markets || [])) {
            if (mk && mk.slug === slug) { m = mk; break outer; }
          }
        }
      } catch(e){}
    }
    if (!m) return { ok: false };
    let prices = [];
    try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch(e){}
    const yesNow = (typeof prices[0] === 'number') ? prices[0] : null;
    if (m.closed === true) {
      if (prices[0] >= 0.999) return { ok: true, resolved: true, yesWon: true, yesNow };
      if (prices[1] >= 0.999) return { ok: true, resolved: true, yesWon: false, yesNow };
      return { ok: true, resolved: false, yesWon: null, yesNow, note: 'closed_ambiguous' };
    }
    return { ok: true, resolved: false, yesWon: null, yesNow };
  } catch(e){ return { ok: false, note: 'fetch_error' }; }
}

// Verified true resolutions for markets that vanished from the gamma API
// (delisted after resolving). File: DIR/resolutions.json
// { "<slug>": { "yesWon": true|false, "verified_at": "<iso>", "source": "<note>" } }
function loadOverrides(){
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'resolutions.json'), 'utf8')); }
  catch(e){ return {}; }
}

// After this many consecutive unresolvable lookups (~2h at 30-min cadence),
// a market is treated as delisted and settled at its last known mark.
const MAX_MISSES = 4;

// Settle a position: cash_in tracks every dollar received (partial sales +
// final payout); pnl is always cash_in - stake, so partials can't double-count.
function settle(state, p, payout, won, yesWon, note){
  p.cash_in = r2((p.cash_in || 0) + payout);
  const pnl = r2(p.cash_in - p.stake);
  state.bankroll = r2(state.bankroll + payout);
  p.status = 'closed'; p.yes_won = yesWon; p.won = won;
  p.pnl = pnl; p.closed_at = new Date().toISOString();
  if (note) p.note = note;
  // Only bump the incremental P&L: any partial take-profit was already
  // recorded in day.pnl when it was banked (takePartial). Bumping the full
  // pnl here double-counted it and inflated the daily-breaker figure.
  bumpDay(state, r2(pnl - (p.banked || 0)));
  state.closed.push(p);
  return { market: p.market, side: p.side, stake: p.stake, won: p.won, pnl, note: note || null };
}

function closePosition(state, p, yesWon, note){
  const won = (p.side === 'YES') === yesWon;
  return settle(state, p, won ? p.shares : 0, won, yesWon, note); // each share pays $1
}

// Full exit at the current mark (stop-loss, expiry take, stale).
function exitAtMarket(state, p, cur, note){
  const payout = r2(p.shares * cur);
  return settle(state, p, payout, payout > (p.stake - (p.cash_in || 0)), null, note);
}

// Partial take-profit: sell half the remaining shares at +100%, ride the rest.
// The banked profit is real the moment it sells: record it so realized P&L,
// profit factor and the daily breaker see it (it is NOT in closed[] yet).
function takePartial(state, p, cur){
  const q = r2(p.shares / 2);
  const proceeds = r2(q * cur);
  const banked = r2(proceeds - q * p.entry_price);
  state.bankroll = r2(state.bankroll + proceeds);
  p.cash_in = r2((p.cash_in || 0) + proceeds);
  p.banked = r2((p.banked || 0) + banked);
  p.shares = r2(p.shares - q);
  p.tp_taken = true;
  bumpDay(state, banked);
  return { market: p.market, sold: q, proceeds, banked };
}

async function gradeAll(state){
  const graded = [];
  const overrides = loadOverrides();
  for (const p of state.positions.filter(p => p.status === 'open')){
    // 1) Verified true resolution (market delisted from the API).
    const ov = overrides[p.slug];
    if (ov && typeof ov.yesWon === 'boolean'){
      graded.push(closePosition(state, p, ov.yesWon, 'verified_resolution'));
      continue;
    }
    // 2) Live API lookup (direct slug index, then public-search fallback).
    const ms = await marketState(p.slug);
    if (ms.ok && ms.resolved) {
      p.misses = 0;
      graded.push(closePosition(state, p, ms.yesWon, null));
      continue;
    }
    // 3) Live market: refresh the mark, then run the exit ladder.
    if (ms.ok) {
      p.misses = 0;
      if (ms.yesNow != null) p.yes_now = r2(ms.yesNow * 10000) / 10000;
      if (p.yes_now != null) {
        const cur = p.side === 'YES' ? p.yes_now : (1 - p.yes_now);
        const upnl = ((p.cash_in || 0) + p.shares * cur - p.stake) / p.stake;
        const minsToEnd = p.end ? (new Date(p.end).getTime() - Date.now()) / 60000 : Infinity;
        const stale = p.end && Date.now() > new Date(p.end).getTime() + STALE_AFTER_H * 3600e3;
        if (!p.tp_taken && upnl >= TP_AT) {
          const tp = takePartial(state, p, cur);   // sell half, ride the rest
          p.note = 'partial-tp';
          graded.push({ market: p.market, side: p.side, stake: p.stake, won: true,
                        pnl: r2(tp.proceeds - (tp.sold * p.entry_price)), note: 'take-profit (half)' });
        } else if (upnl <= SL_AT) {
          graded.push(exitAtMarket(state, p, cur, 'stop-loss'));
          continue;
        } else if (minsToEnd <= EXPIRY_TAKE_MIN && upnl > 0) {
          graded.push(exitAtMarket(state, p, cur, 'expiry-take'));
          continue;
        } else if (stale) {
          graded.push(exitAtMarket(state, p, cur, 'stale-expired'));
          continue;
        }
      }
      continue;
    }
    p.misses = (p.misses || 0) + 1;
    // 4) Persistently absent + we hold a last mark: settle there, clearly noted.
    if (p.misses >= MAX_MISSES && p.yes_now != null){
      const cur = p.side === 'YES' ? p.yes_now : (1 - p.yes_now);
      graded.push(exitAtMarket(state, p, cur, 'delisted_settled_at_last_mark'));
    }
  }
  state.positions = state.positions.filter(p => p.status === 'open');
  // refresh mark-to-market on remaining opens (banked partials count)
  for (const p of state.positions){
    if (p.yes_now != null){
      const cur = p.side === 'YES' ? p.yes_now : (1 - p.yes_now);
      p.unrealized = r2((p.cash_in || 0) + p.shares * cur - p.stake);
    }
  }
  return graded;
}

function summary(state, opened, graded, swept){
  const closed = state.closed || [];
  // Banked partial profits live on still-open positions; count them exactly once.
  // (When such a position finally closes, its closed pnl = cash_in - stake already
  // includes the banked part, and it leaves the open list — no double count.)
  const bankedOpen = r2(state.positions.reduce((a, p) => a + (p.banked || 0), 0));
  const realized = r2(closed.reduce((a, p) => a + (p.pnl || 0), 0) + bankedOpen);
  const openRisk = r2(state.positions.reduce((a, p) => a + p.stake, 0));
  // Equity = cash + market value of remaining shares. Banked cash already sits in
  // bankroll, so openVal must NOT include cash_in (that was the double count).
  const openVal = r2(state.positions.reduce((a, p) => {
    const cur = (p.yes_now != null) ? (p.side === 'YES' ? p.yes_now : (1 - p.yes_now)) : p.entry_price;
    return a + p.shares * cur;
  }, 0));
  const grossW = r2(closed.filter(p => p.pnl > 0).reduce((a, p) => a + p.pnl, 0) + bankedOpen);
  const grossL = r2(closed.filter(p => p.pnl < 0).reduce((a, p) => a - p.pnl, 0));
  return {
    bankroll: state.bankroll, equity: r2(state.bankroll + openVal),
    realized_pnl: realized, open_count: state.positions.length,
    open_risk: openRisk, skipped: state.skipped,
    savings: r2(state.savings || 0), swept: swept || 0,
    profit_factor: grossL > 0 ? r2(grossW / grossL) : (grossW > 0 ? Infinity : null),
    best: closed.length ? r2(Math.max(...closed.map(p => p.pnl))) : null,
    worst: closed.length ? r2(Math.min(...closed.map(p => p.pnl))) : null,
    opened, graded,
    positions: state.positions.map(p => ({
      market: p.market, side: p.side, stake: p.stake,
      entry_c: r2(p.entry_price * 100), unrealized: p.unrealized ?? null
    }))
  };
}

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Inject the bot's live state into the unified Phantom app (Bot tab).
// The app file lives outside git; the repo keeps a template with {"none":true}.
const APP_PATH = '/home/hatch/workspace/your_files/phantom.html';
function injectAppState(state, sum){
  const closed = state.closed || [];
  const payload = {
    as_of: new Date().toISOString(),
    bankroll: sum.bankroll, equity: sum.equity, realized_pnl: sum.realized_pnl,
    open_count: sum.open_count, open_risk: sum.open_risk,
    savings: sum.savings || 0,
    sweep_log: (state.sweep_log || []).map(e => ({ t: e.t, amount: e.amount })),
    profit_factor: sum.profit_factor, best: sum.best, worst: sum.worst,
    positions: state.positions.map(p => ({
      market: p.market, side: p.side, stake: p.stake,
      entry_c: r2(p.entry_price * 100), unrealized: p.unrealized ?? null
    })),
    closed: closed.map(p => ({
      market: p.market, side: p.side, stake: p.stake,
      won: !!p.won, pnl: p.pnl, note: p.note || 'resolved'
    })),
    history: (state.history || []).slice(-120)
  };
  try {
    let html = fs.readFileSync(APP_PATH, 'utf8');
    const a = html.indexOf('<script id="paper-state" type="application/json">');
    if (a < 0) return false;
    const b = html.indexOf('</scr' + 'ipt>', a);
    if (b < 0) return false;
    const openEnd = html.indexOf('>', a) + 1;
    html = html.slice(0, openEnd) + JSON.stringify(payload) + html.slice(b);
    fs.writeFileSync(APP_PATH, html);
    return true;
  } catch (e) { return false; }
}

// ---- this morning's seed scan (2026-10-07 14:07:02 UTC), intraday only ----
const SEED = [
  { market: 'Counter-Strike: PARIVISION vs Natus Vincere (BO3)', slug: 'cs2-prv-navi-2026-10-07', yes: 0.335, side: 'BUY', size: 'full', end: '2026-10-07T23:59:00Z' },
  { market: 'Counter-Strike: K27 vs Metizport (BO3)', slug: 'cs2-k271-mzp-2026-10-07', yes: 0.675, side: 'BUY', size: 'half', end: '2026-10-07T23:59:00Z' },
  { market: 'China Open: Ann Li vs Elina Svitolina', slug: 'wta-annli-svitoli-2026-10-06', yes: 0.125, side: 'BUY', size: 'half', end: '2026-10-07T23:59:00Z' },
  { market: 'Bitcoin above $82,000 on Oct 7', slug: 'bitcoin-above-82k-on-october-7-2026', yes: 0.9305, side: 'SELL', size: 'half', end: '2026-10-07T16:00:00Z' },
];

async function backfill(){
  const state = load();
  const t0 = '2026-10-07T14:07:02Z';
  const opened = [];
  for (const sig of SEED){
    const res = openPosition(state, sig, t0);
    if (res === 'opened') opened.push({ market: sig.market, side: sig.side === 'BUY' ? 'YES' : 'NO', stake: STAKE[sig.size], entry_c: Math.round((sig.side === 'BUY' ? sig.yes : 1 - sig.yes) * 10000) / 100 });
  }
  const graded = await gradeAll(state);
  const sum = summary(state, opened, graded);
  state.history = [...(state.history || []), { t: new Date().toISOString(), equity: sum.equity }].slice(-500);
  save(state);
  injectAppState(state, sum);
  console.log(JSON.stringify({ mode: 'backfill', ...sum }, null, 1));
}

async function live(){
  const state = load();
  const now = Date.now();
  // Market listing via gamma /markets/keyset (migrated 2026-10-13).
  const markets = await getMarkets({ closed: 'false', active: 'true', limit: '80', order: 'volume24hr', ascending: 'false' });
  const trades = await fetchTape(markets);
  const seen = tradedSlugs(state);
  const quals = scoreMarkets(markets, trades).filter(r => {
    if ((r.size !== 'full' && r.size !== 'half') || seen.has(r.slug) || !r.end) return false;
    const h = (new Date(r.end).getTime() - now) / 36e5;
    return h > 0 && h <= 48;
  });
  const opened = [];
  const t = new Date(now).toISOString();
  const halted = isHalted();
  const approvalMode = !!state.approvalMode;
  let queued = 0;
  // One position per event: "Spirit vs M80 - Map 2" and "Spirit vs M80 (BO3)"
  // share the same match, so a second position would double the event risk.
  const evKey = s => (((s && s.market) || s) || '').split(' - ')[0].replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
  const openEvents = new Set(state.positions.filter(p => p.status === 'open').map(evKey));
  if (!halted){
    const pending = approvalMode ? loadPending() : [];
    const pendingSlugs = new Set(pending.map(q => q.slug));
    for (const q of quals){
      if (openEvents.has(evKey(q.market))) continue; // already exposed to this event
      if (approvalMode && (pendingSlugs.has(q.slug) || tradedSlugs(state).has(q.slug))) continue;
      const gate = canOpen(state);
      if (gate){ state.skipped++; continue; }
      if (approvalMode){
        // Human-in-the-loop: queue the candidate; nothing opens until
        // `node paper.js approve` runs. The 40-60c price filter is re-applied
        // at approve time against the then-current price.
        pending.push({ id: q.slug + '@' + t, slug: q.slug, market: q.market,
          side: q.side, size: q.size, yes: q.yes, bid: q.bid, ask: q.ask,
          end: q.end, requested_at: t });
        pendingSlugs.add(q.slug);
        queued++;
        continue;
      }
      const res = openPosition(state, q, t);
      if (res === 'opened'){ opened.push({ market: q.market, side: q.side === 'BUY' ? 'YES' : 'NO', stake: STAKE[q.size], entry_c: Math.round((q.side === 'BUY' ? (q.ask || q.yes) : 1 - (q.bid || q.yes)) * 10000) / 100 }); openEvents.add(evKey(q.market)); }
    }
    if (approvalMode) savePending(pending);
  }
  const graded = await gradeAll(state);
  const swept = sweepProfits(state, t);
  const sum = summary(state, opened, graded, swept);
  state.history = [...(state.history || []), { t: new Date().toISOString(), equity: sum.equity }].slice(-500);
  save(state);
  injectAppState(state, sum);
  console.log(JSON.stringify({ mode: 'live', as_of: t, halted, approvalMode, queued, ...sum }, null, 1));
}

// Human approval: open queued signals (approvalMode only).
// Re-prices each signal at approve time — the 40-60c entry filter in
// openPosition runs against the CURRENT book, so a stale queue entry that
// drifted out of band is skipped, not opened.
async function approveCmd(id){
  const state = load();
  if (isHalted()){ console.log(JSON.stringify({ mode: 'approve', halted: true, approved: [] })); return; }
  const pending = loadPending();
  const t = new Date().toISOString();
  const approved = [], remaining = [];
  for (const q of pending){
    if (id && q.id !== id && q.slug !== id){ remaining.push(q); continue; }
    const gate = canOpen(state);
    if (gate){ q.skip_reason = gate; remaining.push(q); continue; }
    if (tradedSlugs(state).has(q.slug)){ continue; } // already traded, drop
    const sig = { market: q.market, slug: q.slug, side: q.side, size: q.size,
      yes: q.yes, bid: q.bid, ask: q.ask, end: q.end };
    try {
      const m = (await getMarkets({ slug: q.slug }))[0];
      if (m){
        let prices = [];
        try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch(e){}
        if (typeof prices[0] === 'number') sig.yes = prices[0];
        if (m.bestBid != null) sig.bid = Number(m.bestBid);
        if (m.bestAsk != null) sig.ask = Number(m.bestAsk);
      }
    } catch(e){}
    const res = openPosition(state, sig, t);
    if (res === 'opened'){
      approved.push({ market: q.market, side: q.side === 'BUY' ? 'YES' : 'NO',
        stake: STAKE[q.size], entry_c: Math.round(((q.side === 'BUY' ? (sig.ask || sig.yes) : 1 - (sig.bid || sig.yes))) * 10000) / 100 });
    } else { q.skip_reason = res; remaining.push(q); }
  }
  savePending(remaining);
  const sum = summary(state, approved, [], 0);
  state.history = [...(state.history || []), { t: new Date().toISOString(), equity: sum.equity }].slice(-500);
  save(state);
  injectAppState(state, sum);
  console.log(JSON.stringify({ mode: 'approve', approved, still_pending: remaining.length }, null, 1));
}

const mode = process.argv[2];
if (mode === 'backfill') backfill().catch(e => { console.error('PAPER_ERROR: ' + e.message); process.exit(1); });
else if (mode === 'live') live().catch(e => { console.error('PAPER_ERROR: ' + e.message); process.exit(1); });
else if (mode === 'approve') approveCmd(process.argv[3]).catch(e => { console.error('PAPER_ERROR: ' + e.message); process.exit(1); });
else { console.error('usage: node paper.js [backfill|live|approve [id]]'); process.exit(2); }
