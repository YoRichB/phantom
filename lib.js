// Shared fetch + Phantom scoring logic for the signal monitor and paper trader.
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function getJSON(url){
  const r = await fetch(url, { headers: { 'User-Agent': 'PhantomScanner/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

// v2 envelope: { data: [...], pagination } — unwrap, tolerating a bare array.
const unwrapTrades = j => Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);

// Per-market tape. The global recent-trades feed (?limit=500 with no market)
// is dominated by crypto up/down micro-markets, so most of the top-80 volume
// markets show zero prints and every signal degrades to "skip". Pulling each
// candidate market's own tape is the reliable read (verified 2026-10-10:
// 34 candidates -> 3,272 prints -> 34 signals vs 0 with the global feed).
//
// V2 migration (2026-10-10): Data API v1 retires 2026-10-24, so all reads use
// the /v2/* routes: `condition` replaces the v1 `market` filter param, and
// responses arrive in the { data, pagination } envelope with snake_case fields.
async function fetchTape(markets){
  const cands = (markets || []).filter(m => {
    let prices = [];
    try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch(e){}
    const bid = num(m.bestBid), ask = num(m.bestAsk);
    const spread = num(m.spread || (ask && bid ? ask - bid : 1));
    const liq = num(m.liquidity);
    const yes = prices[0] ?? ((bid && ask) ? (bid + ask) / 2 : 0);
    return m.conditionId && liq >= 20000 && spread <= 0.04 && yes > 0.03 && yes < 0.97;
  }).slice(0, 40);
  // NOTE: keep one request per market — a batched `condition=a,b,...` call
  // applies `limit` per-request, starving per-market coverage (verified live).
  const res = await Promise.all(cands.map(m =>
    getJSON('https://data-api.polymarket.com/v2/trades?condition=' + encodeURIComponent(m.conditionId) + '&limit=100')
      .then(unwrapTrades).catch(() => [])
  ));
  const trades = [];
  for (const a of res) trades.push(...a);
  if (!trades.length){
    // last resort: global feed (noisy, but better than no tape at all)
    try {
      const g = await getJSON('https://data-api.polymarket.com/v2/trades?limit=500');
      trades.push(...unwrapTrades(g));
    } catch(e){}
  }
  return trades;
}

function scoreMarkets(markets, trades){
  const by = new Map();
  for (const t of trades){
    const title = t.title || '';
    if (!title) continue;
    const usd = num(t.size) * num(t.price);
    const row = by.get(title) || { buy:0, sell:0, prints:0, wallets:new Set() };
    row.prints++; row.wallets.add(t.proxy_wallet || t.proxyWallet || '');
    if (String(t.side || '').toUpperCase() === 'BUY') row.buy += usd; else row.sell += usd;
    by.set(title, row);
  }
  return markets.map(m => {
    let prices = [];
    try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch(e){}
    const bid = num(m.bestBid), ask = num(m.bestAsk);
    const spread = num(m.spread || (ask && bid ? ask - bid : 1));
    const liq = num(m.liquidity);
    const yes = prices[0] ?? ((bid && ask) ? (bid + ask) / 2 : 0);
    const flow = by.get(m.question) || { buy:0, sell:0, prints:0, wallets:new Set() };
    const wallets = flow.wallets.size || 0;
    const net = flow.buy - flow.sell;
    const votes = [liq >= 32000, spread <= 0.03, flow.prints >= 3 || wallets >= 3].filter(Boolean).length;
    const confirmed = flow.prints >= 3 || wallets >= 2;
    let size = 'skip';
    if (votes >= 2 && confirmed && liq >= 20000 && yes > 0.03 && yes < 0.97 && spread <= 0.04)
      size = (votes === 3 && wallets >= 3) ? 'full' : 'half';
    return {
      market: m.question || '', slug: m.slug || '', yes,
      bid, ask, spread, liquidity: liq, volume24hr: num(m.volume24hr),
      prints: flow.prints, wallets,
      buy_usd: Math.round(flow.buy * 100) / 100,
      sell_usd: Math.round(flow.sell * 100) / 100,
      net: Math.round(net * 100) / 100,
      votes, side: net >= 0 ? 'BUY' : 'SELL', size,
      end: m.endDate || null
    };
  });
}

module.exports = { num, getJSON, fetchTape, scoreMarkets };
