// Phantom paper-trading bot. Simulates trading the scanner's intraday signals
// against a $100 starting wallet. Paper only — never touches real money.
//
//   node paper.js backfill   one-time: enter this morning's seed signals
//   node paper.js live       every 30 min: score, open new positions, grade opens
//
// Semantics (corrected): a BUY signal = buy YES at the yes price;
// a SELL signal = buy NO at (1 - yes). Stake = wallet cash risked.
// Sizing: full = $20, half = $10. Never open if stake > available cash.
const fs = require('fs');
const path = require('path');
const { getJSON, scoreMarkets } = require('./lib');
const DIR = '/home/hatch/workspace/phantom-signal-monitor';
const PAPER = path.join(DIR, 'paper.json');

const START = 100;
const STAKE = { full: 20, half: 10 };
const r2 = n => Math.round(n * 100) / 100;

function load(){
  try { return JSON.parse(fs.readFileSync(PAPER, 'utf8')); }
  catch(e){ return { start_bankroll: START, bankroll: START, positions: [], closed: [], skipped: 0 }; }
}
function save(s){ fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(PAPER, JSON.stringify(s, null, 1)); }

const tradedSlugs = s => new Set([...s.positions, ...s.closed].map(p => p.slug));

// sig: {market, slug, yes, side:'BUY'|'SELL', size, end}
function openPosition(state, sig, entryTime){
  const stake = STAKE[sig.size];
  if (!stake || tradedSlugs(state).has(sig.slug)) return 'dup';
  if (stake > state.bankroll) { state.skipped++; return 'skipped'; }
  const yesSide = sig.side === 'BUY';
  const entryPrice = yesSide ? sig.yes : (1 - sig.yes);
  if (!(entryPrice > 0 && entryPrice < 1)) return 'badprice';
  const shares = stake / entryPrice;
  state.bankroll = r2(state.bankroll - stake);
  state.positions.push({
    id: sig.slug + '@' + entryTime, slug: sig.slug, market: sig.market,
    side: yesSide ? 'YES' : 'NO', signal: sig.side, size: sig.size,
    entry_yes: r2(sig.yes * 10000) / 10000, entry_price: r2(entryPrice * 10000) / 10000,
    stake, shares: r2(shares * 100) / 100,
    opened_at: entryTime, end: sig.end || null, status: 'open'
  });
  return 'opened';
}

async function marketState(slug){
  try {
    const ms = await getJSON('https://gamma-api.polymarket.com/markets?slug=' + encodeURIComponent(slug));
    let m = ms && ms[0];
    if (!m) {
      // Gamma's slug index drops delisted/resolved markets; fall back to
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

function closePosition(state, p, yesWon, note){
  const won = (p.side === 'YES') === yesWon;
  const payout = won ? p.shares : 0;         // each share pays $1
  const pnl = r2(payout - p.stake);
  state.bankroll = r2(state.bankroll + payout);
  p.status = 'closed'; p.yes_won = yesWon; p.won = won;
  p.pnl = pnl; p.closed_at = new Date().toISOString();
  if (note) p.note = note;
  state.closed.push(p);
  return { market: p.market, side: p.side, stake: p.stake, won, pnl, note: note || null };
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
    // 3) Unresolvable right now: refresh mark if we have one, count the miss.
    //    Only a fully failed lookup counts as a miss; a live market that
    //    simply lacks a price never settles early.
    if (ms.ok) {
      p.misses = 0;
      if (ms.yesNow != null) p.yes_now = r2(ms.yesNow * 10000) / 10000;
      continue;
    }
    p.misses = (p.misses || 0) + 1;
    // 4) Persistently absent + we hold a last mark: settle there, clearly noted.
    if (p.misses >= MAX_MISSES && p.yes_now != null){
      const cur = p.side === 'YES' ? p.yes_now : (1 - p.yes_now);
      const payout = r2(p.shares * cur);
      const pnl = r2(payout - p.stake);
      state.bankroll = r2(state.bankroll + payout);
      p.status = 'closed'; p.yes_won = null; p.won = pnl > 0;
      p.pnl = pnl; p.closed_at = new Date().toISOString();
      p.note = 'delisted_settled_at_last_mark';
      state.closed.push(p);
      graded.push({ market: p.market, side: p.side, stake: p.stake, won: p.won, pnl, note: p.note });
    }
  }
  state.positions = state.positions.filter(p => p.status === 'open');
  // refresh mark-to-market on remaining opens
  for (const p of state.positions){
    if (p.yes_now != null){
      const cur = p.side === 'YES' ? p.yes_now : (1 - p.yes_now);
      p.unrealized = r2(p.shares * cur - p.stake);
    }
  }
  return graded;
}

function summary(state, opened, graded){
  const realized = r2(state.closed.reduce((a, p) => a + (p.pnl || 0), 0));
  const openRisk = r2(state.positions.reduce((a, p) => a + p.stake, 0));
  const openVal = r2(state.positions.reduce((a, p) => {
    const cur = (p.yes_now != null) ? (p.side === 'YES' ? p.yes_now : (1 - p.yes_now)) : p.entry_price;
    return a + p.shares * cur;
  }, 0));
  return {
    bankroll: state.bankroll, equity: r2(state.bankroll + openVal),
    realized_pnl: realized, open_count: state.positions.length,
    open_risk: openRisk, skipped: state.skipped,
    opened, graded,
    positions: state.positions.map(p => ({
      market: p.market, side: p.side, stake: p.stake,
      entry_c: r2(p.entry_price * 100), unrealized: p.unrealized ?? null
    }))
  };
}

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function writeReport(state, sum){
  const closed = state.closed || [];
  const wins = closed.filter(p => p.won).length;
  const winRate = closed.length ? Math.round(wins / closed.length * 100) : null;
  const hist = state.history || [];
  let spark = '<div style="color:#5b6478;font-size:13px;padding:28px 0">not enough data yet — check back after a few runs</div>';
  if (hist.length > 1){
    const W = 560, H = 120, P = 10;
    const vals = hist.map(h => h.equity);
    const lo = Math.min(...vals, 100), hi = Math.max(...vals, 100);
    const rng = (hi - lo) || 1;
    const y0 = (H - P - (100 - lo) / rng * (H - 2 * P)).toFixed(1);
    const pts = vals.map((v, i) =>
      (P + i * (W - 2 * P) / (vals.length - 1)).toFixed(1) + ',' +
      (H - P - (v - lo) / rng * (H - 2 * P)).toFixed(1)).join(' ');
    const up = vals[vals.length - 1] >= 100;
    spark = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:120px;display:block">
      <line x1="${P}" y1="${y0}" x2="${W - P}" y2="${y0}" stroke="#3a4356" stroke-dasharray="4 4"/>
      <polyline points="${pts}" fill="none" stroke="${up ? '#26a69a' : '#ef5350'}" stroke-width="2"/></svg>
      <div style="display:flex;justify-content:space-between;color:#5b6478;font-size:11px"><span>$${lo.toFixed(0)}</span><span>started $100</span><span>$${hi.toFixed(0)}</span></div>`;
  }
  const g = n => n >= 0 ? '#26a69a' : '#ef5350';
  const openRows = state.positions.map(p => {
    const nowC = p.yes_now != null ? Math.round((p.side === 'YES' ? p.yes_now : 1 - p.yes_now) * 10000) / 100 : null;
    const u = p.unrealized ?? null;
    return `<tr><td>${esc(p.market)}</td><td>${p.side}</td><td>$${p.stake}</td>` +
      `<td>${(p.entry_price * 100).toFixed(1)}¢</td><td>${nowC != null ? nowC.toFixed(1) + '¢' : '—'}</td>` +
      `<td style="color:${u != null ? g(u) : '#8a93a6'}">${u != null ? (u >= 0 ? '+' : '') + '$' + u.toFixed(2) : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="6" style="color:#5b6478">no open positions</td></tr>';
  const closedRows = [...closed].reverse().map(p =>
    `<tr><td>${esc(p.market)}</td><td>${p.side}</td><td>$${p.stake}</td>` +
    `<td style="color:${p.won ? '#26a69a' : '#ef5350'}">${p.won ? 'WON' : 'LOST'}</td>` +
    `<td style="color:${g(p.pnl)}">${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)}</td></tr>`
  ).join('') || '<tr><td colspan="5" style="color:#5b6478">nothing graded yet</td></tr>';
  const asof = hist.length ? new Date(hist[hist.length - 1].t) : new Date();
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>Phantom Paper Trader</title>
<style>body{background:#0d1420;color:#d1d4dc;font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;padding:16px}
.wrap{max-width:720px;margin:0 auto}h1{font-size:20px;margin:4px 0}.sub{color:#5b6478;font-size:12px;margin-bottom:14px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
.card{background:#131722;border:1px solid #1e2532;border-radius:10px;padding:12px}
.card .l{font-size:11px;color:#5b6478;text-transform:uppercase;letter-spacing:.5px}
.card .v{font-size:22px;font-weight:700;margin-top:4px}
.panel{background:#131722;border:1px solid #1e2532;border-radius:10px;padding:14px;margin-bottom:14px}
.panel h2{font-size:14px;margin:0 0 10px;color:#8a93a6;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:8px 6px;border-bottom:1px solid #1e2532;text-align:left;vertical-align:top}
th{color:#5b6478;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
footer{color:#5b6478;font-size:11px;text-align:center;margin-top:18px}</style></head>
<body><div class="wrap">
<h1>🤖 Phantom Paper Trader</h1>
<div class="sub">Updated ${asof.toLocaleString()} · rebuilds every ~30 min when the bot runs · re-open for the latest</div>
<div class="cards">
<div class="card"><div class="l">Cash</div><div class="v">$${sum.bankroll.toFixed(2)}</div></div>
<div class="card"><div class="l">Equity</div><div class="v" style="color:${g(sum.equity - 100)}">$${sum.equity.toFixed(2)}</div></div>
<div class="card"><div class="l">Realized P&amp;L</div><div class="v" style="color:${g(sum.realized_pnl)}">${sum.realized_pnl >= 0 ? '+' : ''}$${sum.realized_pnl.toFixed(2)}</div></div>
<div class="card"><div class="l">Open</div><div class="v">${sum.open_count}</div></div>
<div class="card"><div class="l">Win rate</div><div class="v">${winRate != null ? winRate + '%' : '—'}</div></div>
<div class="card"><div class="l">Graded</div><div class="v">${closed.length}</div></div>
</div>
<div class="panel"><h2>Equity curve</h2>${spark}</div>
<div class="panel"><h2>Open positions</h2><table><tr><th>Market</th><th>Side</th><th>Stake</th><th>Entry</th><th>Now</th><th>Unreal.</th></tr>${openRows}</table></div>
<div class="panel"><h2>Graded</h2><table><tr><th>Market</th><th>Side</th><th>Stake</th><th>Result</th><th>P&amp;L</th></tr>${closedRows}</table></div>
<footer>Paper trading simulation on a $100 starting wallet · full signals $20, half signals $10 · not real money</footer>
</div></body></html>`;
  fs.writeFileSync('/home/hatch/workspace/your_files/phantom-paper-trader.html', html);
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
  writeReport(state, sum);
  console.log(JSON.stringify({ mode: 'backfill', ...sum }, null, 1));
}

async function live(){
  const state = load();
  const now = Date.now();
  const [markets, trades] = await Promise.all([
    getJSON('https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=80&order=volume24hr&ascending=false'),
    getJSON('https://data-api.polymarket.com/trades?limit=500')
  ]);
  const seen = tradedSlugs(state);
  const quals = scoreMarkets(markets, trades).filter(r => {
    if ((r.size !== 'full' && r.size !== 'half') || seen.has(r.slug) || !r.end) return false;
    const h = (new Date(r.end).getTime() - now) / 36e5;
    return h > 0 && h <= 48;
  });
  const opened = [];
  const t = new Date(now).toISOString();
  for (const q of quals){
    const res = openPosition(state, q, t);
    if (res === 'opened') opened.push({ market: q.market, side: q.side === 'BUY' ? 'YES' : 'NO', stake: STAKE[q.size], entry_c: Math.round((q.side === 'BUY' ? q.yes : 1 - q.yes) * 10000) / 100 });
  }
  const graded = await gradeAll(state);
  const sum = summary(state, opened, graded);
  state.history = [...(state.history || []), { t: new Date().toISOString(), equity: sum.equity }].slice(-500);
  save(state);
  writeReport(state, sum);
  console.log(JSON.stringify({ mode: 'live', as_of: t, ...sum }, null, 1));
}

const mode = process.argv[2];
if (mode === 'backfill') backfill().catch(e => { console.error('PAPER_ERROR: ' + e.message); process.exit(1); });
else if (mode === 'live') live().catch(e => { console.error('PAPER_ERROR: ' + e.message); process.exit(1); });
else { console.error('usage: node paper.js [backfill|live]'); process.exit(2); }
