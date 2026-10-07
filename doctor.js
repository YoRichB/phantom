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
  for (const f of ['lib.js', 'scan.js', 'paper.js', 'doctor.js']) {
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
  const dash = '/home/hatch/workspace/your_files/phantom-paper-trader.html';
  try {
    const ageMin = (Date.now() - fs.statSync(dash).mtimeMs) / 60000;
    note('dashboard:fresh', ageMin < 90, Math.round(ageMin) + ' min old');
  } catch (e) { note('dashboard:fresh', false, 'missing'); }
  // 5. API reachability (short timeout)
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch('https://gamma-api.polymarket.com/markets?limit=1', { signal: ctl.signal });
    clearTimeout(t);
    note('api:gamma', r.ok, 'HTTP ' + r.status);
  } catch (e) { note('api:gamma', false, e.name === 'AbortError' ? 'timeout' : e.message); }
  // 6. resolutions.json shape
  const res = state['resolutions.json'];
  if (res) {
    const bad = Object.entries(res).filter(([, v]) => typeof v.yesWon !== 'boolean');
    note('resolutions:shape', bad.length === 0, bad.length + ' malformed');
  }
  const bad = findings.filter(f => !f.ok);
  console.log(JSON.stringify({ ok: bad.length === 0, findings }, null, 1));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(JSON.stringify({ ok: false, fatal: e.message })); process.exit(1); });
