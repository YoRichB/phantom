// Polymarket US public gateway client + price-action scoring.
// Base: https://gateway.polymarket.us (public, no key needed).
//
// WHAT'S AVAILABLE (verified live 2026-10-13):
//   GET /v1/events?active=&closed=&limit=&offset=&endDateMin=&endDateMax=
//       -> {events:[{slug,title,endDate,startTime,live,category,
//                     markets:[{slug,question,endDate,active,
//                               marketSides:[{description,long,price,quote}],
//                               bestBidQuote:{value},bestAskQuote:{value},status}]}]}
//   GET /v1/markets/{slug}/bbo
//       -> {marketData:{bestBid,bestAsk,currentPx,lastTradePx,openInterest,
//                       sharesTraded,bidDepth,askDepth}}   (values are {value,currency} or strings)
//   GET /v1/price-history?symbol={slug}&fixedInterval=INTERVAL_6H&fidelity=1
//       -> {history:[{timestamp,longPrice,shortPrice}]}  (~1-min points, 6h; longPrice=Yes display)
//   GET /v1/markets/{slug}/settlement
//       -> {slug, settlement: 1|0}  (1 = YES won); unresolved -> HTTP error "Settlement not found"
//
// WHAT'S NOT AVAILABLE (public):
//   - Trade tape / prints / wallet-level flow  -> the old whale-flow engine CANNOT port.
//   - Per-market 24h volume on the listing     -> openInterest/sharesTraded/depths from BBO are the proxies.
//   - Order-book beyond BBO top levels is at /v1/markets/{slug}/book (unused; BBO suffices).
//
// Rate limit: 20 req/s per IP (public). One market per price-history request;
// stagger and keep scans well under the limit.
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const GW = 'https://gateway.polymarket.us';

async function getJSON(url, tries){
  tries = tries || 3;
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'PhantomScannerUS/1.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      return r.json();
    } catch(e) {
      last = e;
      // Retry transient network drops and rate-limit/server errors; not 4xx (e.g. 404 = unsettled).
      const m = /^HTTP (\d+)/.exec(String(e && e.message));
      const retriable = !m || m[1] === '429' || m[1][0] === '5';
      if (!retriable || i === tries - 1) throw e;
      await new Promise(res => setTimeout(res, 1000 * (i + 1)));
    }
  }
  throw last;
}

async function getUSEvents(params){
  const qs = new URLSearchParams(params).toString();
  const j = await getJSON(GW + '/v1/events?' + qs);
  return (j && Array.isArray(j.events)) ? j.events : [];
}

// BBO for one market slug. Lightweight quote refresh (used for live marks
// in grading and approve-time re-pricing). Returns normalized numbers.
async function getUSBBO(slug){
  const j = await getJSON(GW + '/v1/markets/' + encodeURIComponent(slug) + '/bbo');
  const md = (j && j.marketData) || {};
  const qv = q => num(q && q.value);
  return {
    bid: qv(md.bestBid), ask: qv(md.bestAsk),
    last: qv(md.lastTradePx), current: qv(md.currentPx),
    openInterest: num(md.openInterest), sharesTraded: num(md.sharesTraded),
    bidDepth: num(md.bidDepth), askDepth: num(md.askDepth),
  };
}

// Full L2 book for one market slug.
// Returns best bid/ask plus executable depth: total shares bid/offered
// within 3c of the touch. The venue's books are deep here (median ~28k
// shares/side within 3c, sampled 2026-10-13) — this is the liquidity gate,
// replacing the venue's absent volume/liquidity fields and the old bot's
// $32k-liquidity rule. A $100 stake at 50c = 200 shares, so the 500-share
// floor is ~2.5x the largest order the bot will ever send.
async function getUSBook(slug){
  const j = await getJSON(GW + '/v1/markets/' + encodeURIComponent(slug) + '/book');
  const md = (j && j.marketData) || {};
  const bids = md.bids || [], offers = md.offers || [];   // NB: offers, not asks
  const qv = q => num(q && q.value);
  const bpx = bids.length ? qv(bids[0].px) : 0;
  const apx = offers.length ? qv(offers[0].px) : 0;
  let bidQty3 = 0, askQty3 = 0;
  for (const b of bids){ if (bpx && qv(b.px) >= bpx - 0.03) bidQty3 += num(b.qty); }
  for (const a of offers){ if (apx && qv(a.px) <= apx + 0.03) askQty3 += num(a.qty); }
  return { bid: bpx, ask: apx, bidQty3: Math.round(bidQty3), askQty3: Math.round(askQty3) };
}

// Minute-level Yes/No display prices, last 6h. Returns [{t, long, short}] or [].
async function getUSHistory(slug){
  const j = await getJSON(GW + '/v1/price-history?symbol=' + encodeURIComponent(slug) +
    '&fixedInterval=INTERVAL_6H&fidelity=1');
  const h = (j && Array.isArray(j.history)) ? j.history : [];
  return h.map(p => ({ t: num(p.timestamp) * 1000, long: num(p.longPrice), short: num(p.shortPrice) }))
          .filter(p => p.t > 0);
}

// Resolution truth: settlement 1 => YES won, 0 => YES lost.
// Unresolved markets -> the endpoint errors; resolved:false.
async function getUSSettlement(slug){
  try {
    const j = await getJSON(GW + '/v1/markets/' + encodeURIComponent(slug) + '/settlement');
    if (j && (j.settlement === 1 || j.settlement === 0))
      return { resolved: true, yesWon: j.settlement === 1 };
    return { resolved: false, yesWon: null };
  } catch(e){ return { resolved: false, yesWon: null }; }
}

// Fallback resolution read: the closed events listing still carries marketSides
// with the long (YES) side priced "1"/"0" after resolution (verified 2026-10-13).
async function getUSClosedMarket(slug){
  try {
    const evs = await getUSEvents({ active: 'false', closed: 'true', limit: '50', slug: undefined });
    for (const e of evs) for (const m of (e.markets || [])){
      if (m.slug === slug){
        const yes = (m.marketSides || []).find(s => s.long === true);
        const px = yes ? String(yes.price) : null;
        if (px === '1' || px === '0') return { resolved: true, yesWon: px === '1' };
        if (m.status === 'MARKET_STATUS_RESOLVED') return { resolved: true, yesWon: null, ambiguous: true };
        return { resolved: false, yesWon: null };
      }
    }
  } catch(e){}
  return { resolved: false, yesWon: null };
}

// ---- price-action signal model (v1 heuristics — unproven on this venue) ----
// The old engine keyed on whale tape (prints/wallets/net flow). None of that
// exists publicly on Polymarket US, so signals come from price momentum:
// a sustained directional drift in the Yes (or No) display price over 6h,
// confirmed by continued movement in the last hour, with a whipsaw guard.
const MIN_HIST_POINTS = 60;   // ~1h of minute data minimum
const MOM_6H = 0.04;          // 4c net drift over 6h to qualify
const MOM_1H = 0.01;          // 1c continued drift in the last hour (not exhausted)
const MOM_STRONG_6H = 0.06;  // 6c+ drift = strong (full-size vote)
const MOM_FRESH_1H = 0.02;    // 2c+ in the last hour = fresh (vote)
const MAX_ADVERSE = 0.10;     // whipsaw guard: path never reverses >10c against the drift
const SPREAD_MAX = 0.03;      // 3c max spread (entry filter)
const SPREAD_TIGHT = 0.02;    // 2c = tight (vote)
const DEPTH_MIN = 500;        // executable-depth floor: shares within 3c of touch, EACH side
const DEPTH_DEEP = 5000;      // deep book (vote)

function momentumStats(hist, side){
  // side 'BUY' tracks longPrice (Yes rising); 'SELL' tracks shortPrice (No rising).
  const px = hist.map(h => side === 'BUY' ? h.long : h.short).filter(Number.isFinite);
  if (px.length < MIN_HIST_POINTS) return null;
  const first = px[0], last = px[px.length - 1];
  const hour = px[Math.max(0, px.length - 61)];
  const chg6 = last - first, chg1 = last - hour;
  let adverse = 0;
  for (const p of px){
    const a = side === 'BUY' ? (first - p) : (p - first);
    if (a > adverse) adverse = a;
  }
  return { chg6, chg1, adverse, points: px.length, last };
}

// c: {market, slug, eventSlug, eventTitle, bid, ask, end (event endDate ISO),
//     bidQty3, askQty3 (executable shares within 3c of touch, each side),
//     openInterest, sharesTraded (informational), hist}
// Returns a scored signal or null.
function scoreUSCandidate(c){
  const mid = (c.bid + c.ask) / 2;
  const spread = c.ask - c.bid;
  if (!(mid >= 0.40 && mid <= 0.60)) return null;      // proven 40-60c entry band
  if (!(spread > 0 && spread <= SPREAD_MAX)) return null;
  if (!(c.bidQty3 >= DEPTH_MIN && c.askQty3 >= DEPTH_MIN)) return null; // depth gate
  if (!c.end) return null;
  const hoursLeft = (new Date(c.end).getTime() - Date.now()) / 36e5;
  if (!(hoursLeft > 0 && hoursLeft <= 48)) return null; // intraday only

  let best = null;
  for (const side of ['BUY', 'SELL']){
    const st = momentumStats(c.hist, side);
    if (!st) continue;
    const dirOk = side === 'BUY' ? (st.chg6 >= MOM_6H && st.chg1 >= MOM_1H)
                                 : (st.chg6 <= -MOM_6H && st.chg1 <= -MOM_1H);
    if (!dirOk || st.adverse > MAX_ADVERSE) continue;
    const votes = [
      Math.abs(st.chg6) >= MOM_STRONG_6H,                 // strong drift
      spread <= SPREAD_TIGHT,                            // tight spread
      c.bidQty3 >= DEPTH_DEEP && c.askQty3 >= DEPTH_DEEP, // deep book
      Math.abs(st.chg1) >= MOM_FRESH_1H,                 // fresh move
    ].filter(Boolean).length;
    if (votes < 3) continue;
    const size = votes === 4 ? 'full' : 'half';
    const sig = {
      market: c.market, slug: c.slug, eventSlug: c.eventSlug, eventTitle: c.eventTitle,
      side, size, yes: mid, bid: c.bid, ask: c.ask, spread,
      end: c.end, hours_left: Math.round(hoursLeft * 10) / 10,
      // price-action evidence (replaces wallets/prints/net flow — unavailable publicly)
      signal_basis: 'price-action',
      chg_6h_c: Math.round(st.chg6 * 10000) / 100,
      chg_1h_c: Math.round(st.chg1 * 10000) / 100,
      max_adverse_c: Math.round(st.adverse * 10000) / 100,
      bid_depth_shares: c.bidQty3, ask_depth_shares: c.askQty3,
      open_interest: c.openInterest || null, shares_traded: c.sharesTraded || null,
      wallets: null, prints: null, net_usd: null,
    };
    if (!best || (size === 'full' && best.size === 'half')) best = sig;
  }
  return best;
}

module.exports = { num, getJSON, getUSEvents, getUSBBO, getUSBook, getUSHistory, getUSSettlement, getUSClosedMarket, scoreUSCandidate };
