// Phantom US Scanner — Polymarket US price-action signal monitor.
// Paper venue: Polymarket US public gateway (no key). NO whale tape exists
// publicly here, so signals are price-action momentum (see lib-us.js).
// Prints only NEW full/half-size intraday (<=48h, event end) signals as JSON.
// Dedupes via seen-us.json (market slug -> first-seen ISO); pruned after 7d.
//
// Same output contract as scan.js: {as_of, new_signals:[...]} where each
// signal carries market/slug/side/size/yes/bid/ask/spread/end. Momentum
// evidence replaces wallets/prints/net_usd (null on this venue).
const fs = require('fs');
const path = require('path');
const { getUSEvents, getUSBook, getUSHistory, scoreUSCandidate } = require('./lib-us');
const DIR = '/home/hatch/workspace/phantom-signal-monitor';
const SEEN = path.join(DIR, 'seen-us.json');

// polite concurrency for per-market fan-out (public limit: 20 req/s/IP)
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

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(SEEN, 'utf8')); } catch(e){ seen = {}; }
  const now = Date.now();
  for (const k of Object.keys(seen)) {
    if (now - new Date(seen[k]).getTime() > 7 * 864e5) delete seen[k];
  }

  // Page active events whose EVENT ends within 48h (market endDate is the
  // settlement date, often much later — the event end is the resolution time).
  const endMin = new Date(now).toISOString();
  const endMax = new Date(now + 48 * 36e5).toISOString();
  let events = [], offset = 0;
  for (;;){
    const page = await getUSEvents({ active: 'true', closed: 'false', limit: '100',
      offset: String(offset), endDateMin: endMin, endDateMax: endMax });
    events.push(...page);
    if (page.length < 100) break;
    offset += 100;
    if (offset > 1000) break; // sanity cap
  }

  // Candidate markets: active, quoted, 40-60c mid, <=3c spread, event ends in (0,48h].
  const cands = [];
  for (const e of events){
    let eEnd = null;
    try { eEnd = new Date(e.endDate).getTime(); } catch(err){}
    if (!(eEnd && eEnd > now && eEnd <= now + 48 * 36e5)) continue;
    for (const m of (e.markets || [])){
      if (!m.active || m.closed) continue;
      const bid = Number((m.bestBidQuote || {}).value), ask = Number((m.bestAskQuote || {}).value);
      if (!(bid > 0 && ask > bid)) continue;
      const mid = (bid + ask) / 2, spread = ask - bid;
      if (!(mid >= 0.40 && mid <= 0.60 && spread <= 0.03)) continue;
      cands.push({ market: m.question || e.title, slug: m.slug, eventSlug: e.slug,
        eventTitle: e.title, bid, ask, end: new Date(eEnd).toISOString() });
    }
  }

  // Liquidity screen via the full book: executable depth (shares within 3c
  // of touch, each side). The venue's OI/volume fields are absent or tiny;
  // book depth is the honest fill-ability read.
  const withLiq = (await mapLimit(cands, 8, async c => {
    try {
      const b = await getUSBook(c.slug);
      if (!(b.bid > 0 && b.ask > b.bid)) return null;
      return { ...c, bid: b.bid, ask: b.ask,
               bidQty3: b.bidQty3, askQty3: b.askQty3 };
    } catch(e){ return null; }
  })).filter(Boolean);

  // Momentum scoring via 6h price history (one request per market).
  const scored = (await mapLimit(withLiq, 8, async c => {
    try {
      const hist = await getUSHistory(c.slug);
      return scoreUSCandidate({ ...c, hist });
    } catch(e){ return null; }
  })).filter(Boolean);

  const fresh = scored.filter(r => !seen[r.slug]);
  for (const r of fresh) seen[r.slug] = new Date(now).toISOString();
  fs.writeFileSync(SEEN, JSON.stringify(seen, null, 1));
  console.log(JSON.stringify({ as_of: new Date(now).toISOString(), venue: 'polymarket-us',
    events_scanned: events.length, candidates: cands.length, new_signals: fresh }, null, 1));
})().catch(e => { console.error('SCAN_US_ERROR: ' + e.message); process.exit(1); });
