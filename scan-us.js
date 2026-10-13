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
const APP_PATH = '/home/hatch/workspace/your_files/phantom.html';

// Write the latest scan into the app's Signals/Board tabs by replacing the
// JSON inside <script id="us-pack">. Signals = momentum signals; Board = the
// full candidate board with non-qualifiers marked size:'skip' so the tabs
// stay distinct. SEED remains the offline fallback when no pack is present.
function writeAppPack(pack){
  try {
    let html = fs.readFileSync(APP_PATH, 'utf8');
    const marker = '<script id="us-pack" type="application/json">';
    const a = html.indexOf(marker);
    if (a < 0) return 'no-slot';
    const openEnd = a + marker.length;
    const b = html.indexOf('</scr' + 'ipt>', openEnd);
    if (b < 0) return 'no-close';
    html = html.slice(0, openEnd) + JSON.stringify(pack) + html.slice(b);
    fs.writeFileSync(APP_PATH, html);
    return 'ok';
  } catch(e){ return 'err:' + e.message; }
}

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
  // Keep candidate alignment so the app board can show skipped rows too.
  const scoredAll = (await mapLimit(withLiq, 8, async c => {
    try {
      const hist = await getUSHistory(c.slug);
      return { cand: c, sig: scoreUSCandidate({ ...c, hist }) };
    } catch(e){ return { cand: c, sig: null }; }
  }));

  // App board: every screened candidate; non-qualifiers become size:'skip'
  // rows so the Board tab stays distinct from the Signals tab.
  // Signals lead so the 200-row cap never drops them.
  const r2 = v => Math.round(v * 100) / 100;
  const boardAll = scoredAll.map(({ cand, sig }) => {
    if (sig) return sig;
    const mid = (cand.bid + cand.ask) / 2;
    const hl = cand.end ? (new Date(cand.end).getTime() - now) / 36e5 : null;
    return {
      market: cand.market, slug: cand.slug, eventSlug: cand.eventSlug, eventTitle: cand.eventTitle,
      side: null, size: 'skip', yes: r2(mid), bid: cand.bid, ask: cand.ask,
      spread: r2(cand.ask - cand.bid),
      end: cand.end || null, hours_left: hl == null ? null : Math.round(hl * 10) / 10,
      signal_basis: 'price-action',
      chg_6h_c: null, chg_1h_c: null, max_adverse_c: null,
      bid_depth_shares: cand.bidQty3 != null ? cand.bidQty3 : null,
      ask_depth_shares: cand.askQty3 != null ? cand.askQty3 : null,
      open_interest: null, shares_traded: null,
      wallets: null, prints: null, net_usd: null, liquidity: null, volume24hr: null, votes: null,
    };
  });
  const board = [
    ...boardAll.filter(r => r.size !== 'skip'),
    ...boardAll.filter(r => r.size === 'skip'),
  ].slice(0, 200);
  const scored = scoredAll.map(x => x.sig).filter(Boolean);

  const fresh = scored.filter(r => !seen[r.slug]);
  for (const r of fresh) seen[r.slug] = new Date(now).toISOString();
  fs.writeFileSync(SEEN, JSON.stringify(seen, null, 1));

  // Push the live board into the app (Signals + Board tabs).
  const packStatus = writeAppPack({
    as_of: new Date(now).toISOString(), venue: 'polymarket-us',
    signals: scored, board, whales: [],
    events_scanned: events.length, candidates: cands.length,
  });

  console.log(JSON.stringify({ as_of: new Date(now).toISOString(), venue: 'polymarket-us',
    events_scanned: events.length, candidates: cands.length,
    signals: scored.length, board: board.length, pack: packStatus,
    new_signals: fresh }, null, 1));
})().catch(e => { console.error('SCAN_US_ERROR: ' + e.message); process.exit(1); });
