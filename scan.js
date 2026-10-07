// Phantom Scanner — background signal monitor.
// Fetches Polymarket markets + recent tape, scores with the Phantom rules,
// and prints only NEW full-size intraday (<=48h) signals as JSON.
// Dedupes via seen.json (slug -> first-seen ISO); entries pruned after 7 days.
const fs = require('fs');
const path = require('path');
const { getJSON, scoreMarkets } = require('./lib');
const DIR = '/home/hatch/workspace/phantom-signal-monitor';
const SEEN = path.join(DIR, 'seen.json');

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(SEEN, 'utf8')); } catch(e){ seen = {}; }
  const now = Date.now();
  for (const k of Object.keys(seen)) {
    if (now - new Date(seen[k]).getTime() > 7 * 864e5) delete seen[k];
  }
  const [markets, trades] = await Promise.all([
    getJSON('https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=80&order=volume24hr&ascending=false'),
    getJSON('https://data-api.polymarket.com/trades?limit=500')
  ]);
  const scored = scoreMarkets(markets, trades);
  const fresh = scored.filter(r => {
    if (r.size !== 'full' || seen[r.slug]) return false;
    if (!r.end) return false;
    const h = (new Date(r.end).getTime() - now) / 36e5;
    return h > 0 && h <= 48;
  });
  for (const r of fresh) seen[r.slug] = new Date(now).toISOString();
  fs.writeFileSync(SEEN, JSON.stringify(seen, null, 1));
  console.log(JSON.stringify({ as_of: new Date(now).toISOString(), new_signals: fresh }, null, 1));
})().catch(e => { console.error('SCAN_ERROR: ' + e.message); process.exit(1); });
