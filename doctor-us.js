// Phantom US doctor — read-only self-check for the Polymarket US stack.
// Exit 0 = all green. Exit 1 = print failed checks as JSON.
const fs = require('fs');
const path = require('path');
const { getUSEvents, getUSBBO, getUSHistory, getUSSettlement } = require('./lib-us');
const DIR = '/home/hatch/workspace/phantom-signal-monitor';
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) });

(async () => {
  // 1. Gateway reachable: events listing
  try {
    const evs = await getUSEvents({ active: 'true', closed: 'false', limit: '1' });
    check('gw:events', evs.length >= 1, evs.length + ' event(s)');
  } catch(e){ check('gw:events', false, e.message); }

  // 2. BBO endpoint
  try {
    const b = await getUSBBO('tec-mlb-nlchamp-2026-09-27-mil');
    check('gw:bbo', b.bid > 0 && b.ask > b.bid, 'bid=' + b.bid + ' ask=' + b.ask);
  } catch(e){ check('gw:bbo', false, e.message); }

  // 3. Price history endpoint (momentum engine fuel)
  try {
    const h = await getUSHistory('tec-mlb-nlchamp-2026-09-27-mil');
    check('gw:price-history', h.length >= 60, h.length + ' points');
  } catch(e){ check('gw:price-history', false, e.message); }

  // 4. Settlement endpoint: known resolved YES + known resolved NO
  try {
    const y = await getUSSettlement('aec-nfl-car-gb-2025-11-02');   // Panthers won -> YES
    const n = await getUSSettlement('aec-nfl-atl-ne-2025-11-02');   // Falcons lost -> NO
    check('gw:settlement', y.resolved && y.yesWon === true && n.resolved && n.yesWon === false,
      'yes=' + JSON.stringify(y) + ' no=' + JSON.stringify(n));
  } catch(e){ check('gw:settlement', false, e.message); }

  // 5. Settlement on an UNRESOLVED market must report resolved:false (not throw)
  try {
    const u = await getUSSettlement('tec-mlb-nlchamp-2026-09-27-mil');
    check('gw:settlement-unresolved', u.resolved === false, JSON.stringify(u));
  } catch(e){ check('gw:settlement-unresolved', false, e.message); }

  // 6. US ledger valid
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DIR, 'paper-us.json'), 'utf8'));
    check('ledger:paper-us', s.venue === 'polymarket-us' && s.bankroll >= 0 && Array.isArray(s.positions),
      'bankroll=' + s.bankroll + ' open=' + s.positions.length);
  } catch(e){ check('ledger:paper-us', false, e.message); }

  // 7. seen-us.json valid
  try {
    const sn = JSON.parse(fs.readFileSync(path.join(DIR, 'seen-us.json'), 'utf8'));
    check('ledger:seen-us', sn && typeof sn === 'object', Object.keys(sn).length + ' seen');
  } catch(e){ check('ledger:seen-us', false, e.message); }

  // 8. Syntax check all US files
  for (const f of ['lib-us.js', 'scan-us.js', 'paper-us.js', 'doctor-us.js']){
    try { new (require('vm').Script)(fs.readFileSync(path.join(DIR, f), 'utf8'), { filename: f }); check('syntax:' + f, true); }
    catch(e){ check('syntax:' + f, false, e.message); }
  }

  // 9. Kill switch state (informational)
  check('ops:halt', true, fs.existsSync(path.join(DIR, 'HALT')) ? 'HALTED' : 'clear');

  // 10. Pending approvals queue (informational)
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DIR, 'pending-approvals-us.json'), 'utf8'));
    check('ops:pending-approvals', true, (Array.isArray(p) ? p.length : 0) + ' queued');
  } catch(e){ check('ops:pending-approvals', true, '0 queued (no file)'); }

  // 11. No credentials anywhere in the US stack (paper only)
  try {
    const blob = ['lib-us.js','scan-us.js','paper-us.js','doctor-us.js'].map(f => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n');
    const bad = /(api[_-]?key|secret|passphrase|private[_-]?key)\s*[:=]\s*['"][^'"]{8,}/i.test(blob);
    check('security:no-credentials', !bad, bad ? 'SUSPICIOUS STRING FOUND' : 'clean');
  } catch(e){ check('security:no-credentials', false, e.message); }

  // 12. International stack untouched (still the live cron target until cutover)
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DIR, 'paper.json'), 'utf8'));
    check('intl:untouched', Array.isArray(s.positions), 'intl open=' + s.positions.length);
  } catch(e){ check('intl:untouched', false, e.message); }

  const failed = checks.filter(c => !c.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.length, checks }, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('DOCTOR_US_ERROR: ' + e.message); process.exit(1); });
