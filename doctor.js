// Phantom doctor — background self-check. Read-only: diagnoses, never mutates.
// Exits 0 when clean, 1 with findings printed as JSON.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const DIR = '/home/hatch/workspace/phantom-signal-monitor';
const findings = [];
const note = (check, ok, detail) => findings.push({ check, ok, detail: detail || '' });

(async () => {
  // 1. scripts parse
  for (const f of ['lib.js', 'scan.js', 'paper.js', 'doctor.js', 'regrade.js', 'halt.js', 'live.js']) {
    try { execSync(`node --check ${path.join(DIR, f)}`, { stdio: 'pipe' }); note('syntax:' + f, true); }
    catch (e) { note('syntax:' + f, false, 'node --check failed'); }
  }
  // 2. state files are valid JSON
  const state = {};
  for (const f of ['paper.json', 'seen.json', 'resolutions.json']) {
    try { state[f] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); note('json:' + f, true); }
    catch (e) { note('json:' + f, false, e.message); state[f] = null; }
  }
  // 3. paper.json invariants
  const p = state['paper.json'];
  if (p) {
    note('paper:bankroll', p.bankroll >= 0, 'bankroll=' + p.bankroll);
    const req = ['slug', 'market', 'side', 'stake', 'shares', 'entry_price', 'status'];
    const bad = (p.positions || []).filter(x => !req.every(k => x[k] !== undefined));
    note('paper:position-fields', bad.length === 0, bad.length + ' malformed');
    const slugs = (p.positions || []).map(x => x.slug);
    note('paper:no-dup-open', new Set(slugs).size === slugs.length, slugs.length + ' open');
    const realized = Math.round((p.closed || []).reduce((a, x) => a + (x.pnl || 0), 0) * 100) / 100;
    note('paper:history-bounded', (p.history || []).length <= 500, (p.history || []).length + ' points');
    void realized;
  }
  // 4. dashboard freshness
  const dash = '/home/hatch/workspace/your_files/phantom.html';
  try {
    const ageMin = (Date.now() - fs.statSync(dash).mtimeMs) / 60000;
    note('dashboard:fresh', ageMin < 90, Math.round(ageMin) + ' min old');
  } catch (e) { note('dashboard:fresh', false, 'missing'); }
  // 5. API reachability (short timeout) — gamma via /markets/keyset
  // (migrated 2026-10-13; the offset-paginated /markets route is deprecated).
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch('https://gamma-api.polymarket.com/markets/keyset?limit=1', { signal: ctl.signal });
    clearTimeout(t);
    let okShape = false;
    try { const j = await r.json(); okShape = r.ok && Array.isArray(j.markets); } catch(e){}
    note('api:gamma', okShape, 'HTTP ' + r.status + (okShape ? ', keyset envelope ok' : ', unexpected shape'));
  } catch (e) { note('api:gamma', false, e.name === 'AbortError' ? 'timeout' : e.message); }
  // 6. resolutions.json shape
  const res = state['resolutions.json'];
  if (res) {
    const bad = Object.entries(res).filter(([, v]) => typeof v.yesWon !== 'boolean');
    note('resolutions:shape', bad.length === 0, bad.length + ' malformed');
  }
  // 7. V2 readiness: gamma version distribution + v2 trades endpoint shape.
  //    Data API v1 retires 2026-10-24; Protocol V2 markets go live 2026-11-02.
  //    Market reads migrated to /markets/keyset 2026-10-13 (offset /markets
  //    returns `deprecation: true` + `warning: 299 "use /markets/keyset"`).
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const j = await (await fetch('https://gamma-api.polymarket.com/markets/keyset?closed=false&active=true&limit=80&order=volume24hr&ascending=false', { signal: ctl.signal })).json();
    clearTimeout(t);
    const ms = Array.isArray(j) ? j : (j.markets || []);
    const vers = {};
    const missShape = [];
    for (const m of ms || []) {
      const v = m.version || 'unknown';
      vers[v] = (vers[v] || 0) + 1;
      if (v !== 'v1') {
        const need = ['outcomePrices', 'bestBid', 'bestAsk', 'liquidity', 'question', 'slug', 'endDate', 'conditionId'];
        const miss = need.filter(k => m[k] == null);
        if (miss.length) missShape.push((m.slug || '?') + ':' + miss.join(','));
      }
    }
    note('v2:gamma-versions', true, JSON.stringify(vers));
    note('v2:gamma-v2-shape', missShape.length === 0, missShape.length ? missShape.slice(0, 3).join('; ') : 'no v2 markets in top-80 yet');
  } catch (e) { note('v2:gamma-versions', false, e.name === 'AbortError' ? 'timeout' : e.message); }
  // 8. Kill switch + approval queue state (informational — never a failure).
  try {
    const halted = fs.existsSync(path.join(DIR, 'HALT'));
    note('ops:halt', true, halted ? 'HALT SET — new opens paused' : 'no HALT file');
  } catch (e) { note('ops:halt', true, 'unknown'); }
  try {
    const pend = JSON.parse(fs.readFileSync(path.join(DIR, 'pending-approvals.json'), 'utf8'));
    note('ops:pending-approvals', Array.isArray(pend), Array.isArray(pend) ? pend.length + ' queued' : 'bad shape');
  } catch (e) {
    note('ops:pending-approvals', true, 'no queue file');
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch('https://data-api.polymarket.com/v2/trades?limit=1', { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    const okShape = r.ok && j && Array.isArray(j.data);
    note('v2:data-api-trades', !!okShape, 'HTTP ' + r.status + (okShape ? ', {data,pagination} envelope ok' : ', unexpected shape'));
  } catch (e) { note('v2:data-api-trades', false, e.name === 'AbortError' ? 'timeout' : e.message); }
  const bad = findings.filter(f => !f.ok);
  console.log(JSON.stringify({ ok: bad.length === 0, findings }, null, 1));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(JSON.stringify({ ok: false, fatal: e.message })); process.exit(1); });
