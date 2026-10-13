// Phantom ledger re-grade — one-shot migration to verified resolutions.
//
// Backs up paper.json, then re-grades every closed trade that was settled at
// a mark (delisted_settled_at_last_mark / stale-expired) against the market's
// TRUE Polymarket resolution, fetched from gamma /markets/keyset with
// closed=true. Trades already exited at marks during live grading (stop-loss,
// expiry-take) are left alone: the bot really did exit those at those marks.
//
// After re-grading, bankroll / day P&L / savings are recomputed by a
// chronological replay of the ledger's cash flows, using the same sweep rule
// as paper.js (sweep $100 chunks whenever free bankroll >= $1,100 after a
// close). The replay is first validated against the OLD marks: it must
// reproduce the ledger's current savings ($400 / 4 sweeps) before anything
// is written.
//
// Usage: node regrade.js
// Prints before/after realized P&L, win/loss counts, and how many trades
// moved to verified resolutions vs. remain approximations.
const fs = require('fs');
const path = require('path');
const { getJSON, getMarkets, num } = require('./lib');

const DIR = '/home/hatch/workspace/phantom-signal-monitor';
const PAPER = path.join(DIR, 'paper.json');
const START = 1000;
const SWEEP_UNIT = 100;
const r2 = n => Math.round(n * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// True resolution for a slug, or null if unresolvable.
// Sources, in order: gamma keyset active listing, gamma keyset closed=true,
// gamma public-search exact slug match.
async function resolveOutcome(slug){
  const readYesWon = m => {
    let prices = [];
    try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch(e){}
    if (m.closed === true) {
      if (prices[0] >= 0.999) return { yesWon: true, source: 'gamma-keyset-resolved' };
      if (prices[1] >= 0.999) return { yesWon: false, source: 'gamma-keyset-resolved' };
    }
    return null;
  };
  try {
    let m = (await getMarkets({ slug }))[0];
    let hit = m && readYesWon(m);
    if (hit) return hit;
    m = (await getMarkets({ slug, closed: 'true' }))[0];
    hit = m && readYesWon(m);
    if (hit) return hit;
    const sr = await getJSON('https://gamma-api.polymarket.com/public-search?q=' + encodeURIComponent(slug));
    outer:
    for (const e of ((sr && sr.events) || [])) {
      for (const mk of (e.markets || [])) {
        if (mk && mk.slug === slug) { hit = readYesWon(mk); if (hit) { hit.source = 'gamma-search-resolved'; break outer; } }
      }
    }
    return hit;
  } catch(e){ return null; }
}

// Chronological replay of ledger cash flows -> { bankroll, savings, sweep_log }.
// closeCash(t) returns the cash_in credited at that trade's close event.
function replay(closed, openPositions, closeCash){
  const events = [];
  for (const t of closed){
    events.push({ t: t.opened_at, kind: 'open', delta: -t.stake });
    events.push({ t: t.closed_at, kind: 'close', delta: closeCash(t), trade: t });
  }
  for (const p of openPositions) events.push({ t: p.opened_at, kind: 'open', delta: -p.stake });
  events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : (a.kind === 'open' ? -1 : 1)));
  let bankroll = START, savings = 0;
  const sweep_log = [];
  for (const e of events){
    bankroll = r2(bankroll + e.delta);
    if (e.kind === 'close'){
      while (bankroll >= START + SWEEP_UNIT){
        bankroll = r2(bankroll - SWEEP_UNIT);
        savings = r2(savings + SWEEP_UNIT);
        sweep_log.push({ t: e.t, amount: SWEEP_UNIT });
      }
    }
  }
  return { bankroll, savings, sweep_log };
}

(async () => {
  // 1) Back up before touching anything.
  const stamp = new Date().toISOString().slice(0, 10);
  const backupPath = path.join(DIR, 'backups', `paper-${stamp}-pre-resolution-grading.json`);
  fs.mkdirSync(path.join(DIR, 'backups'), { recursive: true });
  fs.copyFileSync(PAPER, backupPath);
  console.log('backup:', backupPath);

  const state = JSON.parse(fs.readFileSync(PAPER, 'utf8'));
  const closed = state.closed || [];

  const oldRealized = r2(closed.reduce((a, t) => a + (t.pnl || 0), 0));
  const oldW = closed.filter(t => t.pnl > 0).length;
  const oldL = closed.filter(t => t.pnl <= 0).length;

  // 2) Validate the replay against OLD marks before re-grading.
  const oldCheck = replay(closed, state.positions || [], t => t.cash_in || 0);
  const oldSavings = r2(state.savings || 0);
  const oldSweeps = (state.sweep_log || []).length;
  if (oldCheck.savings !== oldSavings || oldCheck.sweep_log.length !== oldSweeps){
    console.error(`REPLAY VALIDATION FAILED: replay gives savings=$${oldCheck.savings} / ${oldCheck.sweep_log.length} sweeps, ledger has $${oldSavings} / ${oldSweeps}. Aborting without changes.`);
    process.exit(1);
  }
  console.log(`replay validated on old marks: savings=$${oldCheck.savings}, ${oldCheck.sweep_log.length} sweeps — matches ledger.`);

  // 3) Re-grade mark-settled trades on true resolutions.
  const candidates = closed.filter(t => t.note === 'delisted_settled_at_last_mark' || t.note === 'stale-expired');
  let verified = 0, stillApprox = 0;
  const newCashIn = new Map(); // slug -> corrected cash_in
  for (const t of candidates){
    const res = await resolveOutcome(t.slug);
    await sleep(150); // polite cadence against the public API
    const cur = t.side === 'YES' ? num(t.yes_now) : (1 - num(t.yes_now));
    const markPayout = r2((t.shares || 0) * cur);
    if (res && typeof res.yesWon === 'boolean'){
      const won = (t.side === 'YES') === res.yesWon;
      const truePayout = won ? (t.shares || 0) : 0;
      const newPnl = r2((t.pnl || 0) - markPayout + truePayout);
      newCashIn.set(t.slug + '|' + t.closed_at, r2((t.cash_in || 0) - markPayout + truePayout));
      t.regraded_from = t.note;
      t.note = 'verified_resolution';
      t.yes_won = res.yesWon;
      t.won = won;
      t.pnl = newPnl;
      t.resolution_source = res.source;
      verified++;
    } else {
      stillApprox++;
    }
  }

  // 4) Replay with corrected cash flows; recompute bankroll, savings, day P&L.
  const final = replay(closed, state.positions || [],
    t => newCashIn.has(t.slug + '|' + t.closed_at) ? newCashIn.get(t.slug + '|' + t.closed_at) : (t.cash_in || 0));
  state.bankroll = final.bankroll;
  state.savings = final.savings;
  state.sweep_log = final.sweep_log;
  // Day P&L (breaker input): sum of corrected pnl for trades closed today.
  // (Approximation: banked partial-TP profits are attributed to the close
  // date rather than the TP date — same convention as the mark-based ledger.)
  const today = new Date().toISOString().slice(0, 10);
  const todayPnl = r2(closed.filter(t => (t.closed_at || '').slice(0, 10) === today)
    .reduce((a, t) => a + (t.pnl || 0), 0));
  state.day = { date: today, pnl: todayPnl };

  fs.writeFileSync(PAPER, JSON.stringify(state, null, 1));

  const newRealized = r2(closed.reduce((a, t) => a + (t.pnl || 0), 0));
  const newW = closed.filter(t => t.pnl > 0).length;
  const newL = closed.filter(t => t.pnl <= 0).length;
  console.log(JSON.stringify({
    candidates: candidates.length, verified_resolutions: verified,
    still_approximations: stillApprox,
    before: { realized_pnl: oldRealized, wins: oldW, losses: oldL, savings: oldSavings },
    after: { realized_pnl: newRealized, wins: newW, losses: newL, savings: final.savings, bankroll: final.bankroll },
  }, null, 1));
})().catch(e => { console.error('REGRADE_ERROR: ' + e.message); process.exit(1); });
