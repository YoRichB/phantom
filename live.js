// ============================================================================
// live.js — LIVE order-execution module for the Phantom paper-trading bot.
//
// !!! SAFETY: STAY-PAPER DECISION (2026-10-12) !!!
// The user explicitly decided to STAY PAPER. This module exists for engineering
// readiness ONLY. It is DARK BY DEFAULT: no real orders, no accounts, no
// funding, no real money anywhere unless a human deliberately arms every
// layer below. Nothing in the cron path, paper.js, or the scanner imports this
// file — it runs only when a human operator explicitly runs it.
//
// What a human must do to EVER enable live placement:
//   1. Set LIVE_TRADING_ENABLED=1 in the environment.
//   2. Remove the HALT file (/home/hatch/workspace/phantom-signal-monitor/HALT)
//      — while HALT exists, nothing here will arm or place.
//   3. Provide real CLOB credentials via environment ONLY (never in files,
//      never in chat, never hardcoded): POLY_CLOB_API_KEY,
//      POLY_CLOB_API_SECRET, POLY_CLOB_API_PASSPHRASE, POLY_WALLET_PRIVATE_KEY.
//   4. In-process, call enableLive({ iUnderstand: true }) — the explicit opt-in.
//   5. Approve EACH trade individually via approveTrade(id, { by }) —
//      approveTrade is a HUMAN-OPERATOR action. Automation (the cron, the bot)
//      must NEVER call it; one approval = one order, approvals expire after 24h.
//
// Conventions match paper.js: BUY signal = buy YES at the ask; SELL signal =
// buy NO at (1 - bid); stakes $100 full / $50 half. The live path places
// BUY orders for the outcome token (YES or NO token) — it never shorts.
//
// Usage: node live.js selftest   (dry-run; zero real network calls)
// ============================================================================
const fs = require('fs');
const path = require('path');

const DIR = '/home/hatch/workspace/phantom-signal-monitor';
const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

const APPROVAL_TTL_MS = 24 * 3600 * 1000;
const r6 = n => Math.round(n * 1e6) / 1e6;

const haltPath = () => process.env.LIVE_HALT_FILE || path.join(DIR, 'HALT');
const approvalsPath = () => process.env.LIVE_APPROVALS_FILE || path.join(DIR, 'pending-approvals.json');

// ---------------------------------------------------------------------------
// 1. Credentials: environment only. Never hardcoded, never written to files,
//    never logged (not even partially).
// ---------------------------------------------------------------------------
const REQUIRED_CREDS = [
  'POLY_CLOB_API_KEY',
  'POLY_CLOB_API_SECRET',
  'POLY_CLOB_API_PASSPHRASE',
  'POLY_WALLET_PRIVATE_KEY',
];
// Placeholder values that must be rejected on the real path.
const PLACEHOLDERS = new Set([
  'test', 'changeme', 'placeholder', 'example', 'xxx', 'todo',
  'none', 'null', 'undefined', 'your-api-key', 'your_api_key',
]);

function loadCreds(env){
  const src = env || process.env;
  const out = {};
  for (const name of REQUIRED_CREDS){
    const v = src[name];
    if (typeof v !== 'string' || !v.trim())
      throw new Error('live.js: missing required credential ' + name +
        ' — set it in the environment (never hardcode, never commit)');
    const val = v.trim();
    if (PLACEHOLDERS.has(val.toLowerCase()))
      throw new Error('live.js: credential ' + name + ' looks like a placeholder — refusing');
    out[name] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Master switch — default OFF. All three conditions required:
//    LIVE_TRADING_ENABLED === '1'  AND  enableLive({ iUnderstand: true })
//    was called in-process  AND  no HALT file exists.
// ---------------------------------------------------------------------------
let liveArmed = false;

function haltExists(){
  try { return fs.existsSync(haltPath()); }
  catch(e){ return true; } // fail closed
}

function enableLive(opts){
  opts = opts || {};
  if (opts.iUnderstand !== true)
    throw new Error('live.js: enableLive requires { iUnderstand: true } — explicit human opt-in only');
  if (haltExists())
    throw new Error('live.js: HALT file present (' + haltPath() + ') — live trading is halted; refusing to arm');
  liveArmed = true;
  return true;
}

function disableLive(){ liveArmed = false; }

function isLiveEnabled(){
  return process.env.LIVE_TRADING_ENABLED === '1' && liveArmed && !haltExists();
}

function requireLiveEnabled(){
  if (!isLiveEnabled())
    throw new Error('live.js: live trading is DISABLED (dark by default). ' +
      'To enable: set LIVE_TRADING_ENABLED=1, call enableLive({ iUnderstand: true }), ' +
      'ensure no HALT file, and approve each trade. Refusing.');
}

// ---------------------------------------------------------------------------
// 3. Human approval per trade. Records live in pending-approvals.json.
//    requestApproval: anyone may queue a request (harmless on its own).
//    approveTrade:    HUMAN OPERATOR ONLY — automation must never call this.
//    One approval = one order; approvals expire after 24h.
// ---------------------------------------------------------------------------
function loadApprovals(){
  try {
    const j = JSON.parse(fs.readFileSync(approvalsPath(), 'utf8'));
    return Array.isArray(j.approvals) ? j : { approvals: [] };
  } catch(e){ return { approvals: [] }; }
}

function saveApprovals(a){
  fs.mkdirSync(path.dirname(approvalsPath()), { recursive: true });
  fs.writeFileSync(approvalsPath(), JSON.stringify(a, null, 1));
}

function requestApproval(trade){
  // trade: { market, side: 'BUY'|'SELL', outcome: 'YES'|'NO',
  //          tokenId, stake, limitPrice }
  if (!trade || !trade.market || !trade.tokenId)
    throw new Error('live.js: requestApproval needs { market, tokenId, ... }');
  if (trade.side !== 'BUY' && trade.side !== 'SELL')
    throw new Error('live.js: requestApproval needs side BUY|SELL');
  if (trade.outcome !== 'YES' && trade.outcome !== 'NO')
    throw new Error('live.js: requestApproval needs outcome YES|NO');
  const a = loadApprovals();
  const rec = {
    id: 'appr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    market: trade.market, side: trade.side, outcome: trade.outcome,
    tokenId: trade.tokenId, stake: trade.stake, limitPrice: trade.limitPrice,
    requestedAt: new Date().toISOString(), status: 'pending',
  };
  a.approvals.push(rec);
  saveApprovals(a);
  return rec;
}

// HUMAN OPERATOR ONLY. The bot/cron must never call this automatically —
// every approval represents a person looking at the trade and saying yes.
function approveTrade(id, opts){
  opts = opts || {};
  if (!opts.by)
    throw new Error('live.js: approveTrade requires { by } — record who approved');
  const a = loadApprovals();
  const rec = a.approvals.find(x => x.id === id);
  if (!rec) throw new Error('live.js: approval not found: ' + id);
  if (rec.status !== 'pending')
    throw new Error('live.js: approval ' + id + ' is ' + rec.status + ' — cannot re-approve');
  rec.status = 'approved';
  rec.approvedBy = String(opts.by);
  rec.approvedAt = new Date().toISOString();
  saveApprovals(a);
  return rec;
}

// Find a matching approved, unexpired, unconsumed approval and consume it.
function consumeApproval(order){
  const a = loadApprovals();
  const now = Date.now();
  const rec = a.approvals.find(x =>
    x.status === 'approved' && !x.consumedAt &&
    x.market === order.market && x.side === order.side &&
    x.tokenId === order.tokenId && x.outcome === order.outcome &&
    (now - new Date(x.requestedAt).getTime()) < APPROVAL_TTL_MS
  );
  if (!rec)
    throw new Error('live.js: no matching human approval (approved, <24h old, unconsumed) ' +
      'for ' + order.market + ' ' + order.side + ' — refusing to place order');
  rec.consumedAt = new Date().toISOString();
  saveApprovals(a);
  return rec;
}

// ---------------------------------------------------------------------------
// 4. Order lifecycle. ALL network calls go through the injectable `transport`:
//      transport.signOrder(order)     -> signed order payload
//      transport.postOrder(signed)    -> receipt { orderId, ... }
//      transport.getOrderStatus(id)   -> { status, filledSize, avgPrice, ... }
//      transport.getBook(tokenId)     -> { bids: [[p,s]...], asks: [[p,s]...] }
//    Default transport = real Polymarket CLOB client (dark unless armed).
//    Tests inject a fake.
// ---------------------------------------------------------------------------

// Unsigned order following paper.js semantics: we always BUY the outcome
// token — BUY signal buys the YES token at the ask; SELL signal buys the
// NO token at (1 - bid). Shares are floored to 2dp so cost never exceeds stake.
function buildOrder(o){
  if (!o || !o.tokenId) throw new Error('live.js: buildOrder needs tokenId');
  if (o.outcome !== 'YES' && o.outcome !== 'NO')
    throw new Error('live.js: buildOrder needs outcome YES|NO');
  const stake = Number(o.stake);
  const limitPrice = Number(o.limitPrice);
  if (!(stake > 0 && Number.isFinite(stake)))
    throw new Error('live.js: buildOrder needs a positive finite stake');
  if (!(limitPrice > 0 && limitPrice < 1))
    throw new Error('live.js: buildOrder needs limitPrice in (0, 1)');
  const shares = Math.floor((stake / limitPrice) * 100) / 100;
  if (!(shares > 0)) throw new Error('live.js: stake too small for limitPrice — zero shares');
  return {
    market: o.market || '', tokenId: o.tokenId, outcome: o.outcome,
    side: 'BUY',              // we buy the outcome token (paper.js semantics)
    signalSide: o.signalSide || (o.outcome === 'YES' ? 'BUY' : 'SELL'),
    stake: r6(stake), limitPrice: r6(limitPrice), shares: shares,
    orderType: o.orderType || 'GTC',
  };
}

// Sign an order via the transport. Real transport signs locally with the
// wallet (no network); fake transport returns a canned signature.
async function signOrder(order, ctx){
  ctx = ctx || {};
  const transport = ctx.transport || defaultTransport(ctx.creds);
  if (typeof transport.signOrder !== 'function')
    throw new Error('live.js: transport missing signOrder()');
  const signed = await transport.signOrder(order);
  return Object.assign({}, order, { signed: signed });
}

// Place a signed order. Requires: live enabled AND a matching human approval
// (consumed exactly once). Returns { receipt, approvalId }.
async function placeOrder(signedOrder, ctx){
  requireLiveEnabled();
  ctx = ctx || {};
  if (!signedOrder || !signedOrder.signed)
    throw new Error('live.js: placeOrder needs a signed order — run signOrder() first');
  const approval = consumeApproval(signedOrder);
  const transport = ctx.transport || defaultTransport(ctx.creds);
  if (typeof transport.postOrder !== 'function')
    throw new Error('live.js: transport missing postOrder()');
  const receipt = await transport.postOrder(signedOrder.signed);
  return { receipt: receipt, approvalId: approval.id };
}

// Poll getOrderStatus until filled (or terminal). Read-only, but part of the
// order path, so it requires the master switch too.
async function awaitFill(orderId, ctx){
  requireLiveEnabled();
  ctx = ctx || {};
  const transport = ctx.transport || defaultTransport(ctx.creds);
  if (typeof transport.getOrderStatus !== 'function')
    throw new Error('live.js: transport missing getOrderStatus()');
  const timeoutMs = ctx.timeoutMs || 60000;
  const intervalMs = ctx.intervalMs || 2000;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;){
    last = await transport.getOrderStatus(orderId);
    const st = String((last && last.status) || '').toUpperCase();
    if (st === 'FILLED') return last;
    if (st === 'CANCELLED' || st === 'CANCELED' || st === 'EXPIRED' || st === 'REJECTED')
      return last; // terminal, not filled — caller decides
    if (Date.now() >= deadline)
      throw new Error('live.js: awaitFill timed out for ' + orderId);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// ---- Default (real) transport: Polymarket CLOB via @polymarket/clob-client.
// Lazy requires — never loaded unless a real placement is actually attempted
// (the self-test never touches it). ----
function defaultTransport(creds){
  const c = creds || loadCreds(); // throws if env creds missing/placeholder
  const { ClobClient } = require('@polymarket/clob-client');
  const { Wallet } = require('ethers');
  const wallet = new Wallet(c.POLY_WALLET_PRIVATE_KEY); // local signing only
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, {
    key: c.POLY_CLOB_API_KEY,
    secret: c.POLY_CLOB_API_SECRET,
    passphrase: c.POLY_CLOB_API_PASSPHRASE,
  }, 0); // SignatureType 0 = EOA
  const numPair = xs => (xs || [])
    .map(l => [Number(l.price), Number(l.size)])
    .filter(p => p[0] > 0 && p[1] > 0);
  return {
    name: 'polymarket-clob',
    signOrder(order){ // local EIP-712 signing — no network
      return client.createOrder({
        tokenID: order.tokenId,
        price: order.limitPrice,
        side: 'BUY',
        size: order.shares,
      });
    },
    async postOrder(signed){
      const res = await client.postOrder(signed);
      return { orderId: res.orderID || res.orderId || res.id || null, raw: res };
    },
    async getOrderStatus(orderId){
      const o = await client.getOrder(orderId);
      return {
        status: String(o.status || '').toUpperCase(),
        filledSize: Number(o.size_matched != null ? o.size_matched : (o.sizeMatched || 0)),
        avgPrice: o.avg_price != null ? Number(o.avg_price) : (o.avgPrice != null ? Number(o.avgPrice) : null),
        raw: o,
      };
    },
    async getBook(tokenId){
      const b = await client.getOrderBook(tokenId);
      return { bids: numPair(b.bids), asks: numPair(b.asks) };
    },
  };
}

// ---- Fake transport for tests / dry runs. Records every call; never touches
// the network. ----
function createFakeTransport(scenario){
  scenario = scenario || {};
  const calls = [];
  const statusQueue = (scenario.statuses || [
    { status: 'PENDING', filledSize: 0, avgPrice: null },
    { status: 'FILLED', filledSize: scenario.fillSize != null ? scenario.fillSize : 0,
      avgPrice: scenario.fillPrice != null ? scenario.fillPrice : null },
  ]).map(s => Object.assign({}, s));
  const book = scenario.book || { bids: [], asks: [] };
  return {
    name: 'fake',
    calls: calls,
    signOrder(order){
      calls.push({ method: 'signOrder', order: Object.assign({}, order) });
      return { fakeSignature: 'sig_' + String(order.tokenId || '').slice(0, 8), order: Object.assign({}, order) };
    },
    postOrder(signed){
      calls.push({ method: 'postOrder', signed: signed });
      return { orderId: scenario.orderId || 'fake-order-1', success: true, raw: { ok: true } };
    },
    getOrderStatus(orderId){
      calls.push({ method: 'getOrderStatus', orderId: orderId });
      const s = statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0];
      return Object.assign({}, s);
    },
    getBook(tokenId){
      calls.push({ method: 'getBook', tokenId: tokenId });
      return { bids: book.bids.map(p => p.slice()), asks: book.asks.map(p => p.slice()) };
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Slippage + partial-fill modeling against a book snapshot.
//    side: 'BUY' walks asks (taker), 'SELL' walks bids.
//    book: { bids: [[price,size]...] | [{price,size}...],
//            asks: [...] } — highest bids first, lowest asks first.
// ---------------------------------------------------------------------------
function simulateFill(o){
  const side = o.side;
  if (side !== 'BUY' && side !== 'SELL')
    throw new Error('live.js: simulateFill needs side BUY|SELL');
  const price = Number(o.price);
  const size = Number(o.size);
  if (!(price > 0)) throw new Error('live.js: simulateFill needs price > 0');
  if (!(size > 0)) throw new Error('live.js: simulateFill needs size > 0');
  const rawLevels = ((side === 'BUY' ? o.book.asks : o.book.bids) || []);
  let remaining = size, filled = 0, cost = 0;
  for (const lvl of rawLevels){
    const lp = Number(Array.isArray(lvl) ? lvl[0] : lvl.price);
    const ls = Number(Array.isArray(lvl) ? lvl[1] : lvl.size);
    if (!(lp > 0) || !(ls > 0)) continue;
    const take = Math.min(remaining, ls);
    filled += take; cost += take * lp; remaining -= take;
    if (remaining <= 1e-9){ remaining = 0; break; }
  }
  const avgPrice = filled > 0 ? r6(cost / filled) : null;
  const slippageBps = (avgPrice != null)
    ? Math.round(Math.abs(avgPrice - price) / price * 10000 * 10) / 10
    : 0;
  return {
    side: side, limitPrice: r6(price),
    avgPrice: avgPrice, filledSize: r6(filled), unfilledSize: r6(remaining),
    slippageBps: slippageBps,
    partial: remaining > 0,
  };
}

// Realistic entry modeling for a scanner-style signal, using the actual book
// instead of paper.js's idealized "pay the ask" fill.
// signal: { market, side: 'BUY'|'SELL', yes, bid, ask, size: 'full'|'half' }
// book:   book of the TOKEN BEING BOUGHT (YES token for BUY, NO token for SELL)
const PAPER_STAKE = { full: 100, half: 50 };
function repaperTrade(signal, book){
  if (!signal || (signal.side !== 'BUY' && signal.side !== 'SELL'))
    throw new Error('live.js: repaperTrade needs signal.side BUY|SELL');
  const stake = PAPER_STAKE[signal.size];
  if (!stake) throw new Error('live.js: repaperTrade needs signal.size full|half');
  // paper.js honest-fill semantics: BUY = pay ask on YES; SELL = pay 1-bid on NO
  const outcome = signal.side === 'BUY' ? 'YES' : 'NO';
  const limitPrice = signal.side === 'BUY'
    ? (Number(signal.ask) || Number(signal.yes))
    : (1 - (Number(signal.bid) || Number(signal.yes)));
  if (!(limitPrice > 0 && limitPrice < 1))
    throw new Error('live.js: repaperTrade could not derive a valid limit price');
  const shares = Math.floor((stake / limitPrice) * 100) / 100;
  const fill = simulateFill({ side: 'BUY', price: limitPrice, size: shares, book: book });
  return {
    market: signal.market || '', signalSide: signal.side, outcome: outcome,
    stake: stake, paperEntryPrice: r6(limitPrice), sharesWanted: shares,
    realisticEntryPrice: fill.avgPrice, filledSize: fill.filledSize,
    unfilledSize: fill.unfilledSize, partial: fill.partial,
    slippageBps: fill.slippageBps,
    // paper.js only takes 40-60c entries (2026-10-09 review)
    withinPaperBand: limitPrice >= 0.40 && limitPrice <= 0.60,
  };
}

// ---------------------------------------------------------------------------
// 6. Dry-run self-test: exercises the FULL code path with throwaway fake
//    creds and a FakeTransport. Zero network calls to trading endpoints —
//    a fetch guard fails the test if any request targets clob.polymarket.com.
//    Exit 0 on success (readable summary), non-zero on failure.
// ---------------------------------------------------------------------------
const FAKE_CREDS = {
  POLY_CLOB_API_KEY: 'selftest-fake-key-not-real',
  POLY_CLOB_API_SECRET: 'selftest-fake-secret-not-real',
  POLY_CLOB_API_PASSPHRASE: 'selftest-fake-passphrase-not-real',
  POLY_WALLET_PRIVATE_KEY: 'selftest-fake-private-key-not-real',
};

async function selftest(){
  const results = [];
  const ok = (name, detail) => { results.push({ name: name, pass: true, detail: detail }); };
  const fail = (name, err) => {
    results.push({ name: name, pass: false, detail: String((err && err.message) || err) });
  };
  const expectThrow = async (name, fn, hint) => {
    try { await fn(); fail(name, new Error('expected throw, none thrown' + (hint ? ' (' + hint + ')' : ''))); }
    catch(e){
      if (/^expected throw/.test(e.message)) throw e;
      ok(name, e.message);
    }
  };

  // Guard: any fetch to the real CLOB host fails the test loudly.
  const realFetch = globalThis.fetch;
  let clobFetches = 0;
  globalThis.fetch = (url, init) => {
    if (String(url).indexOf('clob.polymarket.com') >= 0){ clobFetches++; }
    return realFetch ? realFetch(url, init) : Promise.reject(new Error('no fetch in selftest'));
  };

  // Sandbox: throwaway approvals file + throwaway env, restored afterwards.
  const savedEnv = {};
  for (const k of ['LIVE_TRADING_ENABLED'].concat(REQUIRED_CREDS)) savedEnv[k] = process.env[k];
  const tmpApprovals = '/tmp/live-selftest-approvals.json';
  try { fs.unlinkSync(tmpApprovals); } catch(e){}
  process.env.LIVE_APPROVALS_FILE = tmpApprovals;
  delete process.env.LIVE_TRADING_ENABLED;
  for (const k of REQUIRED_CREDS) delete process.env[k];
  disableLive();

  try {
    // --- credential loading ---
    try {
      loadCreds({});
      fail('loadCreds rejects missing creds', new Error('no throw'));
    } catch(e){ ok('loadCreds rejects missing creds', e.message); }
    await expectThrow('loadCreds rejects placeholder (changeme)',
      () => loadCreds(Object.assign({}, FAKE_CREDS, { POLY_CLOB_API_KEY: 'changeme' })));
    await expectThrow('loadCreds rejects placeholder (test)',
      () => loadCreds(Object.assign({}, FAKE_CREDS, { POLY_CLOB_API_SECRET: 'test' })));
    try {
      const c = loadCreds(FAKE_CREDS);
      ok('loadCreds accepts labeled fake creds', Object.keys(c).length + ' keys loaded, none logged');
    } catch(e){ fail('loadCreds accepts labeled fake creds', e); }

    // --- master switch: dark by default ---
    ok('master switch OFF by default', 'isLiveEnabled() === ' + isLiveEnabled());
    await expectThrow('placeOrder throws when disabled',
      () => placeOrder({ signed: { fake: 1 }, market: 'm', side: 'BUY', tokenId: 't', outcome: 'YES' },
        { transport: createFakeTransport() }));
    await expectThrow('enableLive requires explicit iUnderstand', () => enableLive());
    await expectThrow('enableLive requires explicit iUnderstand (false)', () => enableLive({ iUnderstand: false }));

    // --- HALT enforcement (via sandboxed HALT path, real HALT untouched) ---
    process.env.LIVE_HALT_FILE = '/tmp/live-selftest-HALT';
    fs.writeFileSync('/tmp/live-selftest-HALT', 'halted');
    process.env.LIVE_TRADING_ENABLED = '1';
    await expectThrow('enableLive refuses while HALT exists', () => enableLive({ iUnderstand: true }));
    if (isLiveEnabled()) fail('isLiveEnabled false under HALT', new Error('returned true'));
    else ok('isLiveEnabled false under HALT', 'halt file respected');
    fs.unlinkSync('/tmp/live-selftest-HALT');
    delete process.env.LIVE_HALT_FILE;

    // --- arm for the order-path tests ---
    enableLive({ iUnderstand: true });
    if (!isLiveEnabled()) throw new Error('arming failed');
    ok('master switch arms with env=1 + enableLive({iUnderstand:true})', 'isLiveEnabled() === true');

    // --- build -> sign -> approve -> place -> confirm ---
    const fake = createFakeTransport({
      orderId: 'fake-order-1',
      statuses: [
        { status: 'PENDING', filledSize: 0, avgPrice: null },
        { status: 'FILLED', filledSize: 196.07, avgPrice: 0.512 },
      ],
    });
    const unsigned = buildOrder({
      market: 'Selftest Market', tokenId: '1234', outcome: 'YES',
      stake: 100, limitPrice: 0.51, signalSide: 'BUY',
    });
    ok('buildOrder', 'shares=' + unsigned.shares + ' @ ' + unsigned.limitPrice + ' (BUY YES token)');
    const signed = await signOrder(unsigned, { transport: fake });
    if (!signed.signed) throw new Error('signOrder did not attach signature');
    ok('signOrder (fake transport)', 'signature attached, no network');

    await expectThrow('placeOrder throws with NO human approval',
      () => placeOrder(signed, { transport: fake }));

    const appr = requestApproval({
      market: 'Selftest Market', side: 'BUY', outcome: 'YES',
      tokenId: '1234', stake: 100, limitPrice: 0.51,
    });
    ok('requestApproval', 'pending record ' + appr.id);
    const apprd = approveTrade(appr.id, { by: 'selftest-human-operator' });
    ok('approveTrade', 'approved by ' + apprd.approvedBy);
    const placed = await placeOrder(signed, { transport: fake });
    if (placed.receipt.orderId !== 'fake-order-1') throw new Error('bad receipt');
    ok('placeOrder (approved)', 'orderId=' + placed.receipt.orderId + ', approval ' + placed.approvalId + ' consumed');

    await expectThrow('one approval = one order (replay throws)',
      () => placeOrder(signed, { transport: fake }));

    // --- expired approval ---
    const appr2 = requestApproval({
      market: 'Selftest Market 2', side: 'BUY', outcome: 'YES',
      tokenId: '5678', stake: 50, limitPrice: 0.45,
    });
    approveTrade(appr2.id, { by: 'selftest-human-operator' });
    const all = loadApprovals();
    const rec2 = all.approvals.find(x => x.id === appr2.id);
    rec2.requestedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); // 25h old
    saveApprovals(all);
    const signed2 = await signOrder(buildOrder({
      market: 'Selftest Market 2', tokenId: '5678', outcome: 'YES',
      stake: 50, limitPrice: 0.45, signalSide: 'BUY',
    }), { transport: fake });
    await expectThrow('placeOrder throws on expired (>24h) approval',
      () => placeOrder(signed2, { transport: fake }));

    // --- fill confirmation ---
    const final = await awaitFill('fake-order-1', { transport: fake, timeoutMs: 2000, intervalMs: 10 });
    if (final.status !== 'FILLED') throw new Error('expected FILLED, got ' + final.status);
    ok('awaitFill confirmation', 'FILLED ' + final.filledSize + ' shares @ ' + final.avgPrice);

    // --- slippage model on a thin book ---
    const thinBook = { bids: [], asks: [[0.50, 10], [0.52, 50], [0.55, 200]] };
    const f1 = simulateFill({ side: 'BUY', price: 0.50, size: 100, book: thinBook });
    const expAvg = (10 * 0.50 + 50 * 0.52 + 40 * 0.55) / 100; // 0.53
    if (Math.abs(f1.avgPrice - expAvg) > 1e-6) throw new Error('avgPrice ' + f1.avgPrice + ' != ' + expAvg);
    if (f1.partial) throw new Error('should be fully filled');
    if (Math.abs(f1.slippageBps - 600) > 0.1) throw new Error('slippage ' + f1.slippageBps + ' != 600bps');
    ok('simulateFill walks thin book', 'avg=' + f1.avgPrice + ' slippage=' + f1.slippageBps + 'bps');
    const f2 = simulateFill({ side: 'BUY', price: 0.50, size: 500, book: thinBook });
    if (!f2.partial || Math.abs(f2.filledSize - 260) > 1e-6 || Math.abs(f2.unfilledSize - 240) > 1e-6)
      throw new Error('partial fill wrong: ' + JSON.stringify(f2));
    ok('simulateFill reports partial fills honestly', 'filled=' + f2.filledSize + ' unfilled=' + f2.unfilledSize);
    const f3 = simulateFill({ side: 'SELL', price: 0.49, size: 30,
      book: { bids: [[0.49, 20], [0.47, 100]], asks: [] } });
    if (Math.abs(f3.avgPrice - ((20 * 0.49 + 10 * 0.47) / 30)) > 1e-6) throw new Error('SELL walk wrong');
    ok('simulateFill SELL walks bids', 'avg=' + f3.avgPrice);

    // --- repaperTrade: realistic entry vs paper.js idealized ask ---
    const sig = { market: 'Selftest Market', side: 'BUY', yes: 0.50, bid: 0.49, ask: 0.51, size: 'full' };
    const rp = repaperTrade(sig, thinBook);
    if (!(rp.realisticEntryPrice > rp.paperEntryPrice))
      throw new Error('realistic price should be worse than the idealized ask on a thin book');
    ok('repaperTrade vs paper.js', 'paper pays ask 0.51 -> realistic avg ' + rp.realisticEntryPrice +
      ' (' + rp.slippageBps + 'bps slippage), withinPaperBand=' + rp.withinPaperBand);

    // --- zero real network assertion ---
    if (clobFetches > 0) throw new Error(clobFetches + ' real fetch(es) to clob.polymarket.com detected');
    ok('zero network calls to trading endpoints', fake.calls.length + ' fake-transport calls, 0 real fetches');

    // --- disable again ---
    disableLive();
    if (isLiveEnabled()) throw new Error('disableLive failed');
    ok('disableLive re-arms the dark default', 'isLiveEnabled() === false');
  } catch(e){
    fail('selftest harness', e);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['LIVE_TRADING_ENABLED'].concat(REQUIRED_CREDS)){
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    delete process.env.LIVE_APPROVALS_FILE;
    delete process.env.LIVE_HALT_FILE;
    disableLive();
    try { fs.unlinkSync(tmpApprovals); } catch(e){}
  }

  const passed = results.filter(r => r.pass);
  const failed = results.filter(r => !r.pass);
  console.log('live.js selftest — ' + passed.length + ' passed, ' + failed.length + ' failed');
  for (const r of results)
    console.log((r.pass ? '  PASS ' : '  FAIL ') + r.name + (r.detail ? ' — ' + r.detail : ''));
  if (failed.length){ console.log('SELFTEST FAILED'); process.exit(1); }
  console.log('SELFTEST OK — full order path exercised with fake creds + fake transport; no real orders, no real network.');
  process.exit(0);
}

module.exports = {
  DIR, CLOB_HOST,
  loadCreds,
  isLiveEnabled, enableLive, disableLive, requireLiveEnabled, haltExists,
  requestApproval, approveTrade, loadApprovals, consumeApproval,
  buildOrder, signOrder, placeOrder, awaitFill,
  defaultTransport, createFakeTransport,
  simulateFill, repaperTrade,
  selftest,
};

const mode = process.argv[2];
if (mode === 'selftest'){
  selftest().catch(e => { console.error('SELFTEST_ERROR: ' + e.message); process.exit(1); });
} else if (require.main === module){
  console.error('usage: node live.js selftest');
  console.error('NOTE: this module is dark by default (stay-paper decision 2026-10-12).');
  process.exit(2);
}
