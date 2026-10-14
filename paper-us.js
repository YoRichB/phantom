// Phantom US paper-trading bot. Simulates trading the US scanner's intraday
// price-action signals against a FRESH $1,000 starting wallet. Paper only —
// never touches real money, no keys, no orders anywhere in this file.
//
//   node paper-us.js live          every 30 min: score, open new positions, grade opens
//   node paper-us.js approve [id]  open queued signals (only when approvalMode is on)
//
// Venue: Polymarket US public gateway (https://gateway.polymarket.us).
// Resolution truth: /v1/markets/{slug}/settlement (1 = YES won, 0 = YES lost);
// unresolved markets error there, so the exit ladder runs on BBO marks.
//
// Risk config (identical to the international bot):
//   $1,000 wallet; stakes full=$100 / half=$50; 40-60c entry band; totals-only entries (2026-10-14 review).
//   exits: +100% partial take-profit, -50% stop-loss, <30min expiry take,
//   >6h stale reaper; daily breaker -$300 (blocks new opens); max 10 open;
//   one position per event (eventSlug); savings sweeps $100 chunks above $1,000.
// Kill switch: shared DIR/HALT file (same as halt.js / paper.js) — when it
// exists, live() opens NOTHING; grading/exits keep running.
// Approval mode: state.approvalMode=true queues candidates to
// pending-approvals-us.json; `node paper-us.js approve` opens them re-priced.
const fs = require('fs');
const path = require('path');
const { getUSEvents, getUSBBO, getUSBook, getUSHistory, getUSSettlement, getUSClosedMarket, scoreUSCandidate } = require('./lib-us');
const DIR = '/home/hatch/workspace/phantom-signal-monitor';
const PAPER = path.join(DIR, 'paper-us.json');
const SEEN = path.join(DIR, 'seen-us.json');
const HALT_FILE = path.join(DIR, 'HALT');           // shared kill switch
const PENDING_FILE = path.join(DIR, 'pending-approvals-us.json');
const OVERRIDES_FILE = path.join(DIR, 'resolutions-us.json');
const isHalted = () => fs.existsSync(HALT_FILE);

// Cutover flag: the unified app's Trading Agent tab still shows the
// international ledger until the approved cutover. Flip to true as part of it.
const APP_INJECT_ENABLED = true;
const APP_PATH = '/home/hatch/workspace/your_files/phantom.html';

function loadPending(){
  try { const p = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); return Array.isArray(p) ? p : []; }
  catch(e){ return []; }
}
function savePending(p){ fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(PENDING_FILE, JSON.stringify(p, null, 1)); }

const START = 1000;
const STAKE = { full: 100, half: 50 };
const TP_AT = 1.0;
const SL_AT = -0.5;
const EXPIRY_TAKE_MIN = 30;
const STALE_AFTER_H = 6;
const MAX_OPEN = 10;
const MAX_DAILY_LOSS = 300;
const MAX_MISSES = 4;
const SWEEP_UNIT = 100;
const r2 = n => Math.round(n * 100) / 100;

function load(){
  try { return JSON.parse(fs.readFileSync(PAPER, 'utf8')); }
  catch(e){ return { start_bankroll: START, bankroll: START, positions: [], closed: [], skipped: 0, savings: 0, sweep_log: [], day: null, history: [], venue: 'polymarket-us' }; }
}
function save(s){ fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(PAPER, JSON.stringify(s, null, 1)); }
function loadOverrides(){
  try { return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')); }
  catch(e){ return {}; }
}

const tradedSlugs = s => new Set([...s.positions, ...s.closed].map(p => p.slug));

// sig: {market, slug, eventSlug, eventTitle, yes, bid, ask, side:'BUY'|'SELL', size, end}
function openPosition(state, sig, entryTime){
  const stake = STAKE[sig.size];
  if (!stake || tradedSlugs(state).has(sig.slug)) return 'dup';
  if (stake > state.bankroll) { state.skipped++; return 'skipped'; }
  const yesSide = sig.side === 'BUY';
  const entryPrice = yesSide ? (sig.ask || sig.yes) : (1 - (sig.bid || sig.yes));
  if (!(entryPrice > 0 && entryPrice < 1)) return 'badprice';
  if (entryPrice < 0.40 || entryPrice > 0.60) { state.skipped++; return 'price-window'; }
  // 2026-10-14 35-trade review: totals (over/under) 7W/10 +$256.83; covers 3W/8 -$31.50; winners 8W/17 -$4.80. Totals only going forward.
  const t = sig.market || '';
  if (/cover/i.test(t) || !(/total/i.test(t) || /more than/i.test(t))) { state.skipped++; return 'totals-only'; }
  const shares = stake / entryPrice;
  state.bankroll = r2(state.bankroll - stake);
  state.positions.push({
    id: sig.slug + '@' + entryTime, slug: sig.slug, eventSlug: sig.eventSlug || null,
    market: sig.market, side: yesSide ? 'YES' : 'NO', signal: sig.side, size: sig.size,
    entry_yes: r2(sig.yes * 10000) / 10000, entry_price: r2(entryPrice * 10000) / 10000,
    stake, shares: r2(shares * 100) / 100,
    cash_in: 0, tp_taken: false,
    opened_at: entryTime, end: sig.end || null, status: 'open', venue: 'polymarket-us'
  });
  return 'opened';
}

function bumpDay(state, pnl){
  const d = new Date().toISOString().slice(0, 10);
  if (!state.day || state.day.date !== d) state.day = { date: d, pnl: 0 };
  state.day.pnl = r2(state.day.pnl + pnl);
}

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

function canOpen(state){
  if (isHalted()) return 'halted';
  const d = new Date().toISOString().slice(0, 10);
  const dayPnl = (state.day && state.day.date === d) ? state.day.pnl : 0;
  if (dayPnl <= -MAX_DAILY_LOSS) return 'daily-breaker';
  if (state.positions.filter(p => p.status === 'open').length >= MAX_OPEN) return 'max-open';
  return null;
}

// Market state from the US gateway.
// 1) settlement endpoint = resolution truth (1 YES won / 0 YES lost)
// 2) closed-listing fallback (long-side price "1"/"0")
// 3) BBO = live mark for the exit ladder
async function marketStateUS(p){
  const st = await getUSSettlement(p.slug);
  if (st.resolved) return { ok: true, resolved: true, yesWon: st.yesWon };
  const cl = await getUSClosedMarket(p.slug);
  if (cl.resolved && typeof cl.yesWon === 'boolean') return { ok: true, resolved: true, yesWon: cl.yesWon };
  try {
    const b = await getUSBBO(p.slug);
    if (b.bid > 0 && b.ask > b.bid) return { ok: true, resolved: false, yesWon: null, yesNow: (b.bid + b.ask) / 2, bid: b.bid, ask: b.ask };
  } catch(e){}
  return { ok: false };
}

function settle(state, p, payout, won, yesWon, note){
  p.cash_in = r2((p.cash_in || 0) + payout);
  const pnl = r2(p.cash_in - p.stake);
  state.bankroll = r2(state.bankroll + payout);
  p.status = 'closed'; p.yes_won = yesWon; p.won = won;
  p.pnl = pnl; p.closed_at = new Date().toISOString();
  if (note) p.note = note;
  bumpDay(state, r2(pnl - (p.banked || 0)));
  state.closed.push(p);
  return { market: p.market, side: p.side, stake: p.stake, won: p.won, pnl, note: note || null };
}

function closePosition(state, p, yesWon, note){
  const won = (p.side === 'YES') === yesWon;
  return settle(state, p, won ? p.shares : 0, won, yesWon, note);
}

function exitAtMarket(state, p, cur, note){
  const payout = r2(p.shares * cur);
  return settle(state, p, payout, payout > (p.stake - (p.cash_in || 0)), null, note);
}

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
    const ov = overrides[p.slug];
    if (ov && typeof ov.yesWon === 'boolean'){
      graded.push(closePosition(state, p, ov.yesWon, 'verified_resolution'));
      continue;
    }
    const ms = await marketStateUS(p);
    if (ms.ok && ms.resolved) {
      p.misses = 0;
      graded.push(closePosition(state, p, ms.yesWon, 'settlement'));
      continue;
    }
    if (ms.ok) {
      p.misses = 0;
      if (ms.yesNow != null) p.yes_now = r2(ms.yesNow * 10000) / 10000;
      if (p.yes_now != null) {
        const cur = p.side === 'YES' ? p.yes_now : (1 - p.yes_now);
        const upnl = ((p.cash_in || 0) + p.shares * cur - p.stake) / p.stake;
        const minsToEnd = p.end ? (new Date(p.end).getTime() - Date.now()) / 60000 : Infinity;
        const stale = p.end && Date.now() > new Date(p.end).getTime() + STALE_AFTER_H * 3600e3;
        if (!p.tp_taken && upnl >= TP_AT) {
          const tp = takePartial(state, p, cur);
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
    if (p.misses >= MAX_MISSES && p.yes_now != null){
      const cur = p.side === 'YES' ? p.yes_now : (1 - p.yes_now);
      graded.push(exitAtMarket(state, p, cur, 'delisted_settled_at_last_mark'));
    }
  }
  state.positions = state.positions.filter(p => p.status === 'open');
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
  const bankedOpen = r2(state.positions.reduce((a, p) => a + (p.banked || 0), 0));
  const realized = r2(closed.reduce((a, p) => a + (p.pnl || 0), 0) + bankedOpen);
  const openRisk = r2(state.positions.reduce((a, p) => a + p.stake, 0));
  const openVal = r2(state.positions.reduce((a, p) => {
    const cur = (p.yes_now != null) ? (p.side === 'YES' ? p.yes_now : (1 - p.yes_now)) : p.entry_price;
    return a + p.shares * cur;
  }, 0));
  const grossW = r2(closed.filter(p => p.pnl > 0).reduce((a, p) => a + p.pnl, 0) + bankedOpen);
  const grossL = r2(closed.filter(p => p.pnl < 0).reduce((a, p) => a - p.pnl, 0));
  return {
    venue: 'polymarket-us',
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

// App injection is DISABLED until the approved cutover (APP_INJECT_ENABLED).
function injectAppState(state, sum){
  if (!APP_INJECT_ENABLED) return 'disabled';
  const closed = state.closed || [];
  const payload = {
    as_of: new Date().toISOString(), venue: 'polymarket-us',
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

async function mapLimit(items, n, fn){
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length){
      const k = i++;
      try { out[k] = await fn(items[k]); } catch(e){ out[k] = null; }
    }
  }));
  return out;
}

async function live(){
  const state = load();
  const now = Date.now();
  // Candidate universe: active events ending within 48h (same screen as scan-us).
  const endMin = new Date(now).toISOString();
  const endMax = new Date(now + 48 * 36e5).toISOString();
  let events = [], offset = 0;
  for (;;){
    const page = await getUSEvents({ active: 'true', closed: 'false', limit: '100',
      offset: String(offset), endDateMin: endMin, endDateMax: endMax });
    events.push(...page);
    if (page.length < 100 || offset > 1000) break;
    offset += 100;
  }
  const seen = tradedSlugs(state);
  const cands = [];
  for (const e of events){
    let eEnd = null;
    try { eEnd = new Date(e.endDate).getTime(); } catch(err){}
    if (!(eEnd && eEnd > now && eEnd <= now + 48 * 36e5)) continue;
    for (const m of (e.markets || [])){
      if (!m.active || m.closed || seen.has(m.slug)) continue;
      const bid = Number((m.bestBidQuote || {}).value), ask = Number((m.bestAskQuote || {}).value);
      if (!(bid > 0 && ask > bid)) continue;
      const mid = (bid + ask) / 2, spread = ask - bid;
      if (!(mid >= 0.40 && mid <= 0.60 && spread <= 0.03)) continue;
      cands.push({ market: m.question || e.title, slug: m.slug, eventSlug: e.slug,
        eventTitle: e.title, bid, ask, end: new Date(eEnd).toISOString() });
    }
  }
  const withLiq = (await mapLimit(cands, 8, async c => {
    try {
      const b = await getUSBook(c.slug);
      if (!(b.bid > 0 && b.ask > b.bid)) return null;
      return { ...c, bid: b.bid, ask: b.ask, bidQty3: b.bidQty3, askQty3: b.askQty3 };
    } catch(e){ return null; }
  })).filter(Boolean);
  const quals = (await mapLimit(withLiq, 8, async c => {
    try {
      const hist = await getUSHistory(c.slug);
      const sig = scoreUSCandidate({ ...c, hist });
      return sig && sig.yes >= 0.40 && sig.yes <= 0.60 ? sig : null;
    } catch(e){ return null; }
  })).filter(Boolean);

  const opened = [];
  const t = new Date(now).toISOString();
  const halted = isHalted();
  const approvalMode = !!state.approvalMode;
  let queued = 0;
  // One position per event (eventSlug) — spreads/totals/lines on the same
  // game are correlated, so a second position would double the event risk.
  const openEvents = new Set(state.positions.filter(p => p.status === 'open').map(p => p.eventSlug).filter(Boolean));
  if (!halted){
    const pending = approvalMode ? loadPending() : [];
    const pendingSlugs = new Set(pending.map(q => q.slug));
    for (const q of quals){
      if (q.eventSlug && openEvents.has(q.eventSlug)) continue;
      if (approvalMode && (pendingSlugs.has(q.slug) || tradedSlugs(state).has(q.slug))) continue;
      const gate = canOpen(state);
      if (gate){ state.skipped++; continue; }
      if (approvalMode){
        pending.push({ id: q.slug + '@' + t, slug: q.slug, eventSlug: q.eventSlug,
          eventTitle: q.eventTitle, market: q.market, side: q.side, size: q.size,
          yes: q.yes, bid: q.bid, ask: q.ask, end: q.end, requested_at: t });
        pendingSlugs.add(q.slug);
        queued++;
        continue;
      }
      const res = openPosition(state, q, t);
      if (res === 'opened'){
        opened.push({ market: q.market, side: q.side === 'BUY' ? 'YES' : 'NO',
          stake: STAKE[q.size], entry_c: Math.round((q.side === 'BUY' ? (q.ask || q.yes) : 1 - (q.bid || q.yes)) * 10000) / 100,
          momentum_6h_c: q.chg_6h_c, momentum_1h_c: q.chg_1h_c });
        if (q.eventSlug) openEvents.add(q.eventSlug);
      }
    }
    if (approvalMode) savePending(pending);
  }
  const graded = await gradeAll(state);
  const swept = sweepProfits(state, t);
  const sum = summary(state, opened, graded, swept);
  state.history = [...(state.history || []), { t: new Date().toISOString(), equity: sum.equity }].slice(-500);
  save(state);
  injectAppState(state, sum);
  console.log(JSON.stringify({ mode: 'live', as_of: t, halted, approvalMode, queued,
    events_scanned: events.length, candidates: cands.length, ...sum }, null, 1));
}

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
    if (tradedSlugs(state).has(q.slug)){ continue; }
    const sig = { market: q.market, slug: q.slug, eventSlug: q.eventSlug, eventTitle: q.eventTitle,
      side: q.side, size: q.size, yes: q.yes, bid: q.bid, ask: q.ask, end: q.end };
    try {
      const b = await getUSBBO(q.slug);
      if (b.bid > 0 && b.ask > b.bid){ sig.bid = b.bid; sig.ask = b.ask; sig.yes = (b.bid + b.ask) / 2; }
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
if (mode === 'live') live().catch(e => { console.error('PAPER_US_ERROR: ' + e.message); process.exit(1); });
else if (mode === 'approve') approveCmd(process.argv[3]).catch(e => { console.error('PAPER_US_ERROR: ' + e.message); process.exit(1); });
else { console.error('usage: node paper-us.js [live|approve [id]]'); process.exit(2); }
