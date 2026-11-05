// DEFAULT MODE: what the wallet decides by itself, so that a person never takes a step, sees a
// choice or reads a word about how value moves. The contract is the web wallet's
// docs/DEFAULT_MODE.md; the words and the route rules are the web wallet's own modules
// (vendor/default-arca.js, vendor/pay-code.js, vendor/btc-ark.js), copied unchanged.
//
//   - Joining: a wallet in default mode that has joined no operator joins the pinned one
//     (config.js ARCA) by itself, once its server shows the pinned key, and tries again every
//     two minutes when it cannot. The wallet's own answer must name the same key after.
//   - BTC is held on the Bitcoin ark (offscreen-ark.js), opened whenever the wallet is
//     unlocked; confirmed BTC at the wallet's address is boarded by itself.
//   - Receiving: one receive code, `bitcoin:<tb1>?ark=<ark address>&sequentia=<request>`, with
//     `amount=` and an ark invoice as `lightning=` when an amount is asked. The faucet pays it.
//   - Sending: a receive code of the same operator is paid in the tree; an address from the
//     chain, else out of the tree; an invoice over Lightning; BTC from the ark first. Where
//     the first route cannot, the next is taken without asking; where none can, one sentence.
//
// The leaf library and Bark decide every fee, coin and refusal; this module names the route.

import { ARCA, FAUCET_URL } from './config.js';
import { stGet, stSet, parseAtoms, fmtAtoms } from './util.js';
import { ensureOffscreen, offscreenUp } from './offscreen-doc.js';
import { sessionMnemonic } from './vault.js';
import { mode, walletTag, modeStamp } from './mode.js';
import * as leaves from './leaves.js';
import * as engine from './engine.js';
import * as A from './assets.js';
import * as ln from './ln.js';
import { leafPerAsset } from './balance-view.js';
import { plainRefusal } from './leaf-profiles.js';
import { fromWire } from './wire.js';
import { codeNamesChannels } from './leaf-schedule.js';
import { boardCap, moveDown, direct, lnFits } from './ark-band.js';
import {
  pinnedOperator, defaultWatchtowers, checkPinned, treeRoute, parseReceiveCode, arrivingAtoms, addressRoute, arrivalMinutes,
  DEFAULT_WORDS, JOIN_RETRY_MS, BOARD_QUIET_MS, vestingShort,
} from '../vendor/default-arca.js';
import { buildPayCode, readPayCode, expandRequest } from '../vendor/pay-code.js';
import { BTC_WORDS, destination } from '../vendor/btc-ark.js';
import { decodeBolt11 } from '../vendor/bolt11.js';
import { forbiddenIn } from '../vendor/user-trade.js';
import { faucetWalletId, faucetClaimed, faucetAlreadyPaid } from '../vendor/faucet-wallet.js';

const CODE_KEY = 'ext.default.code';     // { [walletTag]: { text, owner, until, channels } }
const ARK_SUM_KEY = 'ext.ark.sum';       // { [walletTag]: { total, spendable, arriving } }
const CODE_MARGIN_S = 86_400;
const BTC_BOARD_QUIET_MS = 120_000;
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

export const isDefault = async () => (await mode()) === 'user';

// A refusal as default mode says it: the operator's, the bond's and a frozen coin's in the
// shared plain words; any other that would name how value moves, as a declined payment.
export function userRefusal(e) {
  const p = plainRefusal(e);
  const m = String((p && p.message) || p || '');
  if (forbiddenIn(m).length) { console.warn('[default] refusal:', m); return new Error(DEFAULT_WORDS_DECLINED); }
  return p instanceof Error ? p : new Error(m);
}
const DEFAULT_WORDS_DECLINED = 'This payment was declined; nothing was sent.';

// ---- the Bitcoin ark, in the offscreen document ----
async function arkHost(op, args = {}) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ scope: 'ark', op, args });
  if (!r) throw new Error('the wallet did not answer');
  if (!r.ok) throw new Error((r.error && r.error.message) || 'the wallet refused');
  return r.value;
}
export async function ensureArk() {
  const m = await sessionMnemonic();
  if (!m) return false;
  try { return !!(await arkHost('start', { mnemonic: m })).open; } catch (e) { console.warn('[btc ark] open:', e.message); return false; }
}
export async function stopArk() {
  if (!(await offscreenUp())) return;
  try { await chrome.runtime.sendMessage({ scope: 'ark', op: 'stop', args: {} }); } catch {}
}
export async function arkIsOpen() { return await arkOpen(); }
async function arkOpen() {
  try { return !!(await arkHost('status')).open; } catch { return false; }
}
// What the ark can claim of Lightning payments to it, in sats, as its host last said: the move of a
// BTC channel to the ark (src/ln-to-ark.js) reads it at once, to count a payment the ark already
// holds once.
let arkClaimableNow = null;
export function arkClaimable() { return arkClaimableNow; }
export async function rememberArkSum(f) {
  if (f && f.claimable != null) { try { arkClaimableNow = BigInt(f.claimable); } catch {} }
  const tag = await walletTag();
  if (!tag || !f) return;
  const all = (await stGet('local', ARK_SUM_KEY)) || {};
  all[tag] = { total: String(f.total || 0), spendable: String(f.spendable || 0), arriving: String(f.arriving || 0),
    exitNote: typeof f.exitNote === 'string' ? f.exitNote : null, at: Date.now() };
  await stSet('local', ARK_SUM_KEY, all);
}
export async function arkSum() {
  const tag = await walletTag();
  const all = (await stGet('local', ARK_SUM_KEY)) || {};
  return (tag && all[tag]) || null;
}
// The Bitcoin ark server's limits, as the wallet last read them (its `info`), or null before.
export async function arkInfo() { try { return await arkHost('info'); } catch { return null; } }
// An invoice of the wallet's own ark, and whether it was paid (claimed as the server holds it).
export async function arkInvoice(sats, description) { return await arkHost('invoice', { sats: String(sats), description }); }
// The trade composer's BTC, on the ark (vendor/btc-ark.js `lightning()`), one method at a time.
export async function arkLightning(method, args) { return await arkHost('ln', { method, args }); }

// The wallet's own BTC payment is fresh: nothing is boarded that could race it.
let btcSentAt = 0, seqSentAt = 0;
export function noteOwnPayment(chain) {
  if (chain === 'bitcoin' || chain === 'btc') btcSentAt = Date.now();
  else { seqSentAt = Date.now(); leaves.hostOp('defaults', { on: true, quietUntil: seqSentAt + BOARD_QUIET_MS }).catch(() => {}); }
}
// The figures of the Bitcoin ark's band (src/ark-band.js): the defaults, or those a test set.
async function bandOverride() { try { return (await stGet('local', 'ext.arkLimits')) || null; } catch { return null; } }
// What the ark holds now, arriving included, in sats.
async function arkHeld() { const st = await arkHost('status'); return big(st && st.figures && st.figures.total); }

// Confirmed BTC at the wallet's address goes onto the ark by itself (default mode only), only
// while the ark holds less than a quarter of its resting level, and then back up to it.
let boardAskedAt = 0;
export async function boardBtcSoon() {
  if (!(await isDefault())) return null;
  if (engine.availableFor('BTC') <= 0n) return null;
  if (Date.now() - btcSentAt < BTC_BOARD_QUIET_MS || Date.now() - boardAskedAt < 30_000) return null;
  const cap = boardCap({ held: await arkHeld(), override: await bandOverride(), price: A.priceFor('BTC') });
  if (cap === 0n) return null;
  boardAskedAt = Date.now();
  const r = await arkHost('board', { ...engine.btcWindow(), cap: cap == null ? null : String(cap) });
  if (r) { console.info('[btc ark] boarded', r.amount, 'sat in', r.txid); engine.sync().catch(() => {}); }
  return r;
}

// A trade paying more BTC than the ark holds asks for BTC at the address to be moved onto the ark
// now, whatever the quiet after a payment: the trade waits on it, and says so.
export async function boardBtcFor(sats) {
  if (!(await isDefault())) return null;
  if (engine.availableFor('BTC') <= 0n) return null;
  boardAskedAt = Date.now();
  const cap = boardCap({ held: await arkHeld(), override: await bandOverride(), price: A.priceFor('BTC'), wanted: big(sats) });
  const r = await arkHost('board', { ...engine.btcWindow(), cap: cap == null ? null : String(cap) });
  if (r) { console.info('[btc ark] boarded', r.amount, 'sat in', r.txid, 'for a trade asking', String(sats)); engine.sync().catch(() => {}); }
  return r;
}
// Once the ark holds the band's ceiling, everything above its resting level moves to the wallet's
// own address in one move: default mode only, one move at a time, at most every two minutes.
let movingDown = false, movedDownAt = 0;
const MOVE_DOWN_EVERY_MS = 120_000;
export async function moveDownSoon() {
  if (movingDown || Date.now() - movedDownAt < MOVE_DOWN_EVERY_MS || !(await isDefault()) || !(await arkOpen())) return null;
  movingDown = true; movedDownAt = Date.now();
  try {
    const over = moveDown({ held: await arkHeld(), override: await bandOverride(), price: A.priceFor('BTC') });
    if (!(over > 0n)) return null;
    await engine.ensureOpen();
    const to = engine.currentAddress(false).address;
    const max = big(await arkHost('max', { to }));
    const sats = over < max ? over : max;
    if (!(sats > 0n)) return null;
    const r = fromWire(await arkHost('send', { to, sats: String(sats) }));
    console.info('[ark limit] moved', String(sats), 'sat of BTC to the wallet\'s address', r && r.txid);
    engine.sync().catch(() => {});
    return { sats: String(sats), txid: (r && r.txid) || null };
  } catch (e) {
    console.warn('[ark limit] moving out:', (e && e.message) || e);
    return null;
  } finally { movingDown = false; }
}

// Developer mode's exit of BTC from the Bitcoin ark by hand (offscreen-ark.js).
export async function exitEstimate() { await ensureArk(); return arkHost('exitEstimate'); }
export async function exitStart(vtxos) { await ensureArk(); return arkHost('exitStart', { vtxos }); }

// BTC at the wallet's address (the kit wallet's figure), in default mode, as a string of sats.
export async function btcAtAddress() { return (await isDefault()) ? String(engine.availableFor('BTC')) : '0'; }

// ---- joining the pinned operator ----
let joinTriedAt = 0;
export async function autoJoin() {
  if (!(await isDefault())) return false;
  if (await leaves.config()) return true;
  const pinned = pinnedOperator(ARCA);
  if (!pinned || !(await sessionMnemonic())) return false;
  if (Date.now() - joinTriedAt < JOIN_RETRY_MS) return false;
  joinTriedAt = Date.now();
  const t0 = Date.now();
  try {
    const r = await fetch(pinned.server + '/v1/info', { cache: 'no-store' });
    if (!r.ok) throw new Error('the server answered HTTP ' + r.status);
    checkPinned((await r.json()).operator, pinned, 'the server');
    const info = await leaves.join({ server: pinned.server, node_url: pinned.node_url });
    try { checkPinned(info && info.operator, pinned, 'the wallet'); } catch (e) { await leaves.unjoin(); throw e; }
    console.info(`[default] joined ${pinned.server} in ${Date.now() - t0} ms`);
    return true;
  } catch (e) {
    console.warn('[default] not joined (tried again in two minutes):', e.message);
    return false;
  }
}
// Tells the leaf host whether default mode's upkeep runs (boarding, the mailbox read).
export async function syncDefaults() {
  const st = await modeStamp();
  const joined = !!(await leaves.config());
  const on = st.mode === 'user' && joined;
  await leaves.hostOp('defaults', { on, at: st.at }).catch(() => {});
  if (joined) await setDefaultWatchtowers();
  return on;
}
// The other operators' watchtowers, beside the operator's own, given to the library once each
// time the leaf wallet runs, in either mode: it deposits each coin with them too, sealed.
let towersSet = false;
async function setDefaultWatchtowers() {
  if (towersSet) return;
  try {
    await leaves.runAny('set_default_watchtowers', { urls: defaultWatchtowers(ARCA) });
    towersSet = true;
  } catch (e) { console.warn('[default] default watchtowers not set:', (e && e.message) ?? e); }
}

// ---- the receive code ----
async function leafInfo() {
  return await leaves.runAny('info');
}
async function leafOpen() {
  if (!(await leaves.config())) return false;
  try { return !!(await leaves.status()).open; } catch { return false; }
}
// The single-use Sequentia receive request: the one shown before while it waits, has a day before
// it lapses and names the channels the wallet can be paid over now, or a new one.
async function leafCode(fresh) {
  const tag = await walletTag();
  const all = (await stGet('local', CODE_KEY)) || {};
  let kept = all[tag];
  if (kept && !fresh) {
    const st = await leaves.status().catch(() => null);
    if (st && st.payable && !codeNamesChannels(kept, st.payable)) kept = null;
  }
  if (!fresh && kept && kept.text && kept.owner) {
    try {
      const s = await leaves.runAny('schedule');
      const r = ((s && s.receive_requests) || []).find((x) => x.owner === kept.owner);
      if (r && r.state === 'waiting' && (r.lapses_at == null || r.lapses_at - ((s && s.now) || 0) > CODE_MARGIN_S)) return kept;
    } catch { /* a new one */ }
  }
  const v = await leaves.runUser('receive', {});
  all[tag] = { text: v.request, owner: (v.details && v.details.owner) || null, until: (v.details && v.details.until) || null,
    channels: (v.details && v.details.channels) || {} };
  await stSet('local', CODE_KEY, all);
  return all[tag];
}
export async function forgetCode() {
  const tag = await walletTag();
  const all = (await stGet('local', CODE_KEY)) || {};
  if (tag && all[tag]) { delete all[tag]; await stSet('local', CODE_KEY, all); }
}

let arkAddress = null;
// -> { code, qr, isCode, invoiceHash? }: the receive code, or the address alone when the wallet
// holds no coins with the operator yet (nothing is said about why).
export async function receiveCode({ sats = null, fresh = false } = {}) {
  await engine.ensureOpen();
  const address = engine.currentAddress(false).address;
  let sequentia = null, ark = null, lightning = null, amount = null, invoiceHash = null;
  const open = await leafOpen();
  if (open) { try { sequentia = (await leafCode(fresh)).text; } catch (e) { console.warn('[default] receive request:', e.message); } }
  const n = big(sats);
  if (n > 0n) amount = fmtAtoms(n, 8);
  // An amount of the band's `direct` or more goes to the address: the code then carries neither the
  // ark's address nor an invoice. Nor does it carry an invoice for more than the operator takes in
  // one payment over Lightning (src/ark-band.js).
  const price = A.priceFor('BTC');
  const large = n > 0n && direct({ sats: n, override: await bandOverride(), price }) != null;
  if (await arkOpen()) {
    if (!large) { try { if (!arkAddress || fresh) arkAddress = (await arkHost('run', { command: 'address' })).address; ark = arkAddress; } catch (e) { console.warn('[btc ark] address:', e.message); } }
    let info = null;
    if (n > 0n && !large && open) { try { info = await leafInfo(); } catch { /* the fallback */ } }
    if (n > 0n && !large && lnFits({ info, kind: 'BTC', dir: 'in', atoms: n, price })) {
      // The ark's server has a limit of its own on what it takes over Lightning: an invoice it
      // refuses leaves the code without one, paid at the ark or the address.
      try {
        const inv = await arkHost('invoice', { sats: String(n), description: 'Receive' });
        lightning = inv.invoice; invoiceHash = inv.payment_hash;
      } catch (e) { console.warn('[btc ark] no invoice for the code:', e.message); }
    }
  }
  const qr = (text) => { try { return engine.qrFor(text); } catch (e) { console.warn('[default] no picture for the code:', e.message); return null; } };
  if (!sequentia) return { code: address, qr: qr(address), isCode: false };
  const code = buildPayCode({ address, ark, sequentia, amount, lightning });
  return { code, qr: qr(code), isCode: true, invoiceHash };
}
export async function invoiceReceived(hash) { return await arkHost('received', { hash }); }

// ---- the testnet faucet: it pays the receive code, else the address ----
// It pays each asset once per wallet: every request names the wallet by its id, the same one
// phrase has in every Sequentia wallet (vendor/faucet-wallet.js).
async function faucetWallet() {
  await engine.ensureOpen();
  return await faucetWalletId(engine.firstScriptPubKey());
}
// -> the faucet labels of the assets this wallet has received from it, or null when the faucet
// could not be asked.
export async function faucetReceived() {
  const got = await faucetClaimed(fetch, FAUCET_URL, await faucetWallet());
  return got ? [...got] : null;
}
export async function faucet(asset) {
  const wallet = await faucetWallet();
  const post = async (body) => {
    const r = await fetch(FAUCET_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, wallet }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.error || ('HTTP ' + r.status));
      if (faucetAlreadyPaid(r.status, j)) e.alreadyPaid = true;
      throw e;
    }
    return j;
  };
  const what = (j) => `${Number(j.amount).toLocaleString('en-US', { maximumFractionDigits: 8 })} ${j.asset}`;
  const t0 = Date.now();
  // BTC is paid on chain to the wallet's address, which boards it into the Bitcoin ark by itself.
  if (asset !== 'BTC' && (await isDefault()) && (await leafOpen())) {
    try {
      const code = await leafCode(false);
      const j = await post(asset ? { request: code.text, asset } : { request: code.text });
      await forgetCode();
      await leaves.runAny('mailbox').catch(() => {});
      await leaves.hostOp('sync').catch(() => {});
      console.info(`[faucet] paid the receive code in ${Date.now() - t0} ms`);
      return { text: DEFAULT_WORDS.faucetReceived(what(j)), to: 'code', ms: Date.now() - t0 };
    } catch (e) {
      // The wallet has the asset: the address is the same wallet, so it is not asked again.
      if (e.alreadyPaid) throw e;
      console.warn('[faucet] to the receive code:', e.message, '; to the address instead');
    }
  }
  await engine.ensureOpen();
  const j = await post(asset ? { address: engine.currentAddress(false).address, asset } : { address: engine.currentAddress(false).address });
  engine.sync().catch(() => {});
  if (j.asset === 'BTC') return { text: BTC_WORDS.sentBlock(j.amount).replace(/^Sent/, 'The faucet sent'), to: 'address', ms: Date.now() - t0 };
  return { text: DEFAULT_WORDS.faucetReceived(what(j)), to: 'address', ms: Date.now() - t0 };
}

// ---- send ----
const looksLikeBolt11 = (s) => /^(lightning:)?ln(bc|tb|tbs|bcrt|sq|tsq)[0-9a-z]+$/i.test(String(s || '').trim());
const plans = new Map();
let planSeq = 0;
function stash(plan) {
  const id = 'd' + (++planSeq) + '.' + Date.now();
  plans.set(id, { ...plan, at: Date.now() });
  for (const [k, v] of plans) if (Date.now() - v.at > 600_000) plans.delete(k);
  return id;
}
const meta = (asset) => (asset === 'BTC' ? { ticker: 'BTC', precision: 8 } : A.assetMeta(asset));

// What the tree holds of an asset, and of it what is still arriving (the library's balance).
async function treeHeld(asset) {
  if (!(await leafOpen())) return { held: 0n, arriving: 0n, balance: null };
  const b = await leaves.runAny('balance');
  return { held: big(leafPerAsset(b)[asset]), arriving: arrivingAtoms(b, asset), balance: b };
}

// An amount of an asset that needs more than the wallet can spend now, the rest vesting later
// (the host's last `claims` reading, vendor/default-arca.js vestingShort), is refused with the date
// all of it can be used from. Nothing is signed. Anything else is left to the route.
export async function refuseIfVesting(asset, atoms) {
  if (asset === 'BTC' || String(asset).startsWith('oamp:')) return;
  const sum = await leaves.leafSum().catch(() => null);
  const lots = (sum && Array.isArray(sum.vesting)) ? sum.vesting : [];
  if (!lots.some((l) => l && l.asset === asset)) return;
  const { held, arriving } = await treeHeld(asset).catch(() => ({ held: 0n, arriving: 0n }));
  const v = vestingShort(lots, asset, atoms, engine.availableFor(asset) + held - arriving);
  if (!v) return;
  const m = meta(asset);
  if (v.arriving) throw new Error(DEFAULT_WORDS.stillArriving(m.ticker));
  throw new Error(DEFAULT_WORDS.notVested(fmtAtoms(v.atoms, m.precision || 0), m.ticker, v.vests));
}

// -> { id, title, lines: [text], button }
export async function prepareSend({ to, amtS, asset }) {
  const text = String(to || '').trim();
  if (!text) throw new Error('Enter a receive code, an address or an invoice.');
  const m = meta(asset);
  if (asset === 'BTC') return await prepareBtc(text, amtS);
  // An invoice names what it is paid in: over Lightning, as it always was.
  if (looksLikeBolt11(text)) {
    const bolt11 = text.replace(/^lightning:/i, '');
    const d = decodeBolt11(bolt11);
    if (!d.ok) throw new Error('This invoice cannot be read.');
    const kind = d.chain === 'btc' ? 'BTC' : d.asset;
    if (kind === 'BTC') return await prepareBtc(text, amtS);
    const km = meta(kind);
    const amt = d.amountMsat != null ? fmtAtoms(big(d.amountMsat) / 1000n, km.precision || 0) : '';
    return { id: stash({ kind: 'ln', lnKind: kind, bolt11, amt, ticker: km.ticker }), title: DEFAULT_WORDS.sendTitle(amt, km.ticker), lines: [DEFAULT_WORDS.sendLine], button: DEFAULT_WORDS.send };
  }
  const atoms = parseAtoms(amtS, m.precision || 0);
  if (atoms <= 0n) throw new Error('Enter how much to send.');
  const amt = fmtAtoms(atoms, m.precision || 0);
  await refuseIfVesting(asset, atoms);
  let request = null, address = null;
  if (/^bitcoin:/i.test(text)) {
    let c = null; try { c = readPayCode(text); } catch { throw new Error(DEFAULT_WORDS_DECLINED); }
    request = c.sequentia || null; address = c.address || null;
  } else if (parseReceiveCode(text)) request = text;
  else address = text;
  // A receive code of this wallet's operator and chain: in the tree, in seconds.
  if (request && (await leafOpen())) {
    const info = await leafInfo();
    // A code carries the request short: the library is handed its own spelling of it.
    if (treeRoute(request, info)) {
      request = expandRequest(request, info) || request;
      const { held, arriving } = await treeHeld(asset);
      if (atoms > held - arriving) {
        if (atoms <= held) throw new Error(DEFAULT_WORDS.stillArriving(m.ticker));
        if (!address) throw new Error(`You can send up to ${fmtAtoms(held - arriving > 0n ? held - arriving : 0n, m.precision || 0)} ${m.ticker} this way now.`);
      } else {
        return { id: stash({ kind: 'tree', request, atoms, asset, amt, ticker: m.ticker }), title: DEFAULT_WORDS.sendTitle(amt, m.ticker), lines: [DEFAULT_WORDS.sendLine], button: DEFAULT_WORDS.send };
      }
    }
  }
  if (!address) throw new Error(DEFAULT_WORDS_DECLINED);
  // An address: from the chain when the wallet's coins there cover it, else out of the tree.
  const { held, arriving } = await treeHeld(asset);
  const route = addressRoute(atoms, engine.availableFor(asset), held - arriving);
  if (route === 'chain') {
    // The fee is paid in the asset moved; an asset no node prices is not sent this way.
    let prep = null;
    try { prep = await engine.prepareSeqSend([{ addr: address, amtS, asset }], asset); } catch (e) { console.warn('[default] chain send:', e.message); }
    if (prep) {
      const lines = [];
      if (prep.review.feeEst) lines.push(DEFAULT_WORDS.fee(fmtAtoms(big(prep.review.feeEst), meta(prep.review.feeAssetHex).precision || 0), meta(prep.review.feeAssetHex).ticker));
      if (request) lines.unshift(DEFAULT_WORDS.byAddress(DEFAULT_WORDS.arrivesNextBlock));
      else lines.push(DEFAULT_WORDS.arrivesWithin(1));
      return { id: stash({ kind: 'engine', prepId: prep.id, chain: 'sequentia', amt, ticker: m.ticker }), title: DEFAULT_WORDS.sendTitle(amt, m.ticker), lines, button: DEFAULT_WORDS.send };
    }
  }
  if (route === 'tree' || (route === 'chain' && held - arriving >= atoms)) {
    let q;
    try { q = await leaves.runUser('offboard_quote', { asset, amount: String(atoms), address }); }
    catch (e) { console.warn('[default] offboard quote:', e.message); throw new Error(DEFAULT_WORDS.addressShort); }
    const info = await leafInfo().catch(() => null);
    const f = info && info.server_info && info.server_info.fills;
    const minutes = arrivalMinutes(f && f.round_interval_seconds);
    const fee = q && q.fee ? big(q.fee.amount) : 0n;
    const lines = [];
    if (fee > 0n) lines.push(DEFAULT_WORDS.fee(fmtAtoms(fee, m.precision || 0), m.ticker));
    lines.push(DEFAULT_WORDS.arrivesWithin(minutes));
    return { id: stash({ kind: 'offboard', asset, atoms, address, q, minutes, amt, ticker: m.ticker }), title: DEFAULT_WORDS.sendTitle(amt, m.ticker), lines, button: DEFAULT_WORDS.send };
  }
  throw new Error(DEFAULT_WORDS.addressShort);
}

async function prepareBtc(text, amtS) {
  let d = destination(text, (s) => decodeBolt11(s));
  if (!d) {
    if (/^bitcoin:/i.test(text) || parseReceiveCode(text)) throw new Error(DEFAULT_WORDS.codeBtc);
    throw new Error('Enter a receive code, an address or an invoice.');
  }
  const sats = d.route === 'invoice' ? 0n : parseAtoms(amtS, 8);
  if (d.route !== 'invoice' && sats <= 0n) throw new Error('Enter how much to send.');
  // One payment of the band's `direct` or more goes to a receive code's address, never into an ark
  // (src/ark-band.js), and the review says so.
  let why = null;
  if (/^bitcoin:/i.test(text)) {
    const usd = direct({ sats, override: await bandOverride(), price: A.priceFor('BTC') });
    const c = usd != null ? (() => { try { return readPayCode(text); } catch { return null; } })() : null;
    if (c && c.address) { text = c.address; d = destination(text, (s) => decodeBolt11(s)); why = DEFAULT_WORDS.byAddressLarge(usd.toLocaleString('en-US')); }
  }
  // An address is paid from the wallet's own BTC there first: the ark pays it out only when that
  // does not cover it, since paying an address out of the ark has a fee of its own.
  if (d.route === 'chain' && sats > 0n && engine.availableFor('BTC') >= sats) {
    let prep = null;
    try { prep = await engine.prepareBtcSend(d.dest, amtS); } catch (e) { console.warn('[default] BTC from the address:', e.message); }
    if (prep) {
      const amt = fmtAtoms(sats, 8);
      return {
        id: stash({ kind: 'engine', prepId: prep.id, chain: 'bitcoin', amt, ticker: 'BTC' }),
        title: BTC_WORDS.review(amt),
        lines: [...(why ? [why] : []), `${BTC_WORDS.to}: ${d.dest.slice(0, 14)}…`, `${BTC_WORDS.fee}: ${fmtAtoms(big(prep.review.feeEst), 8)} BTC`, BTC_WORDS.arrivesBlock],
        button: BTC_WORDS.send,
      };
    }
  }
  let q = null;
  if (await arkOpen()) { try { q = fromWire(await arkHost('quote', { to: text, sats: String(sats) })); } catch (e) { console.warn('[btc ark] quote:', e.message); } }
  if (q && !q.short) {
    const amt = fmtAtoms(q.sats, 8);
    const toLine = d.route === 'invoice' ? BTC_WORDS.toInvoice : /^bitcoin:/i.test(text) ? BTC_WORDS.toCode : (d.dest.slice(0, 14) + '…');
    return {
      id: stash({ kind: 'ark', to: text, sats: q.sats, route: d.route, amt }),
      title: BTC_WORDS.review(amt),
      lines: [...(why ? [why] : []), `${BTC_WORDS.to}: ${toLine}`, `${BTC_WORDS.fee}: ${q.fee > 0n ? fmtAtoms(q.fee, 8) + ' BTC' : BTC_WORDS.noFee}`, d.route === 'chain' ? BTC_WORDS.arrivesBlock : BTC_WORDS.arrivesNow],
      button: BTC_WORDS.send,
    };
  }
  // The ark cannot: an address is paid from the chain, as before.
  const address = d.route === 'chain' ? d.dest : (/^bitcoin:/i.test(text) ? (readPayCode(text) || {}).address : null);
  if (address && sats > 0n && engine.availableFor('BTC') >= sats) {
    const prep = await engine.prepareBtcSend(address, amtS);
    const amt = fmtAtoms(sats, 8);
    return {
      id: stash({ kind: 'engine', prepId: prep.id, chain: 'bitcoin', amt, ticker: 'BTC' }),
      title: BTC_WORDS.review(amt),
      lines: [`${BTC_WORDS.to}: ${address.slice(0, 14)}…`, `${BTC_WORDS.fee}: ${fmtAtoms(big(prep.review.feeEst), 8)} BTC`, BTC_WORDS.arrivesBlock],
      button: BTC_WORDS.send,
    };
  }
  if (d.route === 'invoice' && !q) {
    const bolt11 = text.replace(/^lightning:/i, '');
    const dd = decodeBolt11(bolt11);
    const amt = dd.amountMsat != null ? fmtAtoms(big(dd.amountMsat) / 1000n, 8) : '';
    return { id: stash({ kind: 'ln', lnKind: 'BTC', bolt11, amt, ticker: 'BTC' }), title: BTC_WORDS.review(amt), lines: [BTC_WORDS.arrivesNow], button: BTC_WORDS.send };
  }
  const st = await arkHost('status').catch(() => null);
  const spendable = st && st.figures ? big(st.figures.spendable) : 0n;
  throw new Error(BTC_WORDS.upTo(fmtAtoms(spendable, 8)));
}

// -> { text }
export async function confirmSend({ id }) {
  const p = plans.get(id);
  if (!p) throw new Error('This review expired; review the payment again.');
  plans.delete(id);
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
  try {
    if (p.kind === 'tree') {
      await leaves.runUser('send', { request: p.request, amount: String(p.atoms), asset: p.asset });
      await forgetCode().catch(() => {});
      console.info(`[default] paid a receive code in the tree in ${Date.now() - t0} ms`);
      return { text: DEFAULT_WORDS.sent(p.amt, p.ticker, secs()), ms: Date.now() - t0 };
    }
    if (p.kind === 'offboard') {
      const v = await leaves.runUser('offboard', { asset: p.asset, amount: String(p.atoms), address: p.address, shown: p.q });
      const mins = arrivalMinutes(v && v.round_within_seconds) || p.minutes;
      return { text: DEFAULT_WORDS.sentLater(p.amt, p.ticker, mins), ms: Date.now() - t0 };
    }
    if (p.kind === 'engine') {
      const r = await engine.confirmSend(p.prepId);
      noteOwnPayment(r.chain);
      return { text: p.chain === 'bitcoin' ? BTC_WORDS.sentBlock(p.amt) : DEFAULT_WORDS.sentLater(p.amt, p.ticker, 1), ms: Date.now() - t0 };
    }
    if (p.kind === 'ark') {
      const r = fromWire(await arkHost('send', { to: p.to, sats: String(p.sats) }));
      console.info(`[btc ark] sent by ${r.route} (${r.state || 'done'}) in ${Date.now() - t0} ms`);
      // An invoice whose payee holds the payment is not paid until they take it: followed for a
      // minute, then said as it stands ("On its way…"), never "Sent" before it is.
      if (r.route === 'invoice' && r.state && r.state !== 'complete' && r.hash) {
        const out = fromWire(await arkHost('payOutcome', { hash: r.hash, untilMs: 60000 }))
        if (out.state === 'came-back') throw new Error(BTC_WORDS.payCameBack)
        if (out.state !== 'complete') return { text: BTC_WORDS.payWaiting, ms: Date.now() - t0 }
      }
      return { text: p.route === 'chain' ? BTC_WORDS.sentBlock(p.amt) : BTC_WORDS.sent(p.amt, secs()), ms: Date.now() - t0 };
    }
    if (p.kind === 'ln') {
      await ln.payInvoice({ kind: p.lnKind, bolt11: p.bolt11 });
      return { text: p.lnKind === 'BTC' ? BTC_WORDS.sent(p.amt, secs()) : DEFAULT_WORDS.sent(p.amt, p.ticker, secs()), ms: Date.now() - t0 };
    }
    throw new Error('unknown payment');
  } catch (e) {
    throw userRefusal(e);
  }
}

// ---- removing the wallet ----
// Closes its leaf wallet and its ark wallet, so a wallet made next shows none of their coins;
// both stores stay where they are, and the same phrase imported again finds them.
export async function closeWallets() {
  await leaves.stop().catch(() => {});
  await stopArk();
  arkAddress = null;
}
export async function forgetWallet(tag) {
  for (const k of [CODE_KEY, ARK_SUM_KEY]) {
    const all = (await stGet('local', k)) || {};
    if (tag && all[tag]) { delete all[tag]; await stSet('local', k, all); }
  }
}
