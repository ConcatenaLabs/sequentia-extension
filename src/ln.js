// Lightning (Tier-2 hosted SeqLN) glue for the extension.
//
// The LSP hosts KEYLESS CLN-fork nodes; this wallet derives every device
// identity from the ONE mnemonic (vendor/seqln-keys.js) and co-signs each
// commitment via the Noise/BOLT-8 signer SDK, so the LSP can route but never
// move funds. SeqLN is single-asset per node: each asset gets its own hosted
// node (per-asset device identity), plus one BTC node on testnet4.
//
// Unlike the web wallet, there is no built-in DEX here, so the shared hub-node
// signers are never connected; only the user's OWN provisioned nodes are used,
// brought online on demand (invoice, pay, move, close). BTC and every
// fee-priced Sequentia asset can go over LN; OpenAMP assets cannot.

import {
  initSeqln, seqlnState, seqlnGetStatus, seqlnChannelInbound, seqlnNodeReceive,
  seqlnNodePay, provisionAndConnect, waitNodeReady, deviceTransportPubkey,
  registerOwnStatusKeys, closeChannelLsp, fundChannel, resumeFundChannel, approveCloseDestination,
} from '../vendor/seqln.js';
import { btc as btcLib } from '../vendor/btc.js';
// Statically imported and injected into seqln.js: the HTML spec disallows
// dynamic import() on ServiceWorkerGlobalScope, so the lazy sdkPath load that
// works on the web wallet page throws here.
import * as signerSdk from '../vendor/lightning/seqln-signer-sdk.js';
import { lnDeriveNode, lnDeriveAsset } from '../vendor/seqln-keys.js';
import { LSP } from './config.js';
import * as A from './assets.js';
import * as engine from './engine.js';
import { stGet, stSet, stDel, lnInvoiceKind } from './util.js';

let inited = false;
let lastStatus = null;
let progressSink = null;
export function setProgressSink(fn) { progressSink = fn; }
function say(text) { try { progressSink && progressSink(text); } catch {} }

export function lnInit() {
  if (inited) return;
  initSeqln({
    lspUrl: LSP.url,
    token: LSP.token,
    sdk: signerSdk,
    wsBase: LSP.wsBase,
    nodes: {
      asset: { wsUrl: LSP.wsAsset, hostPubkey: LSP.hostPubkeyAsset },
      btc: { wsUrl: LSP.wsBtc, hostPubkey: LSP.hostPubkeyBtc },
    },
  });
  inited = true;
}

export function deployed() { lnInit(); return seqlnState().deployed; }

// ---- own-node identities ----
function phraseOrThrow() {
  const p = engine.getMnemonic();
  if (!p) throw new Error('wallet is locked');
  return p;
}
function btcIdentity() {
  const d = lnDeriveNode(phraseOrThrow(), 'btc');
  return { transportPrivkey: d.transportPrivkey, signingSeed: d.signingSeed };
}

export async function assetNodeKey(assetHex) {
  const id = lnDeriveAsset(phraseOrThrow(), assetHex);
  const pub = await deviceTransportPubkey(id.transportPrivkey);
  return 'seq:' + assetHex.toLowerCase() + ':' + String(pub).toLowerCase();
}
export async function btcNodeKey() {
  const k = btcIdentity();
  const pub = await deviceTransportPubkey(k.transportPrivkey);
  return 'btc:' + String(pub).toLowerCase();
}

// Patient node-readiness: a revived node blocks at hsmd until the device
// signer attaches (which connectOwnNode holds open), then may need minutes of
// block catch-up before its RPC answers. One short waitNodeReady budget turns
// that into a user-facing failure; retry inside the SAME held connection.
export async function waitNodeReadyPatient(nodeKey, label, totalMs = 5 * 60_000) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    try {
      await waitNodeReady({ nodeKey, onProgress: () => say('Preparing your ' + label + ' node (booting and syncing)…') });
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      say('Your ' + label + ' node is still syncing; holding on…');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Bring the user's OWN hosted node online (idempotent: re-attaches to an
// existing provisioned node, never re-funds). kind: 'BTC' | assetHex.
export async function connectOwnNode(kind) {
  lnInit();
  const phrase = phraseOrThrow();
  const prov = kind === 'BTC'
    ? await provisionAndConnect({ chain: 'btc', label: 'BTC', policy: 'enforce',
        deriveIdentity: () => btcIdentity() })
    : await provisionAndConnect({ chain: 'seq', assetId: kind, label: A.assetMeta(kind).ticker, policy: 'enforce',
        deriveIdentity: (id) => lnDeriveAsset(phrase, id) });
  if (!(prov && prov.connected)) throw new Error('could not bring your device signer online for your Lightning node');
  return prov;
}

// ---- status / balances ----
// Register this device's candidate node keys so /status reads back channels on
// the user's own nodes across restarts, then cache the status snapshot.
let _keysSig = '';
async function refreshOwnKeys() {
  const heldChain = Object.keys((await engine.balances()).seq || {}).filter((h) => { const e = A.feeRateEntry(h); return e && e.rate > 0; });
  // Assets this wallet has EVER swapped over Lightning (recorded at dispatch):
  // an LN-only balance has no on-chain trace, and skipping its node made the
  // wallet display "no channel" while the swap engine traded real funds on it.
  const swapped = (await stGet('local', 'ext.lnAssets')) || [];
  const held = [...new Set([...heldChain, ...swapped.filter((h) => /^[0-9a-f]{64}$/.test(String(h)))])];
  const sig = held.slice().sort().join(',');
  if (sig === _keysSig) return;
  const keys = [];
  try { keys.push(await btcNodeKey()); } catch {}
  for (const a of held) { try { keys.push(await assetNodeKey(a)); } catch {} }
  registerOwnStatusKeys(keys);
  _keysSig = sig;
}

export async function refreshStatus() {
  lnInit();
  if (!seqlnState().deployed) { lastStatus = null; return null; }
  try { await refreshOwnKeys(); } catch {}
  lastStatus = await seqlnGetStatus();
  return lastStatus;
}

// In-channel spendable balance for a kind ('BTC' | assetHex), OWN channels only
// (node_key present) — shared/demo topology channels are never this wallet's funds.
export function spendableFor(kind) {
  const chs = (lastStatus && lastStatus.channels) || [];
  let units = 0, n = 0;
  for (const c of chs) {
    if (!c.node_key) continue;
    const isBtc = (c.asset_label === 'BTC' || c.leg === 'btc');
    const match = kind === 'BTC' ? isBtc : (!isBtc && (c.asset === kind || c.asset_label === A.assetMeta(kind).ticker));
    if (match && String(c.state || '').startsWith('CHANNELD')) { units += Number(c.spendable_units || 0); n++; }
  }
  return { units, channels: n };
}
export function ownChannelsFor(kind) {
  const chs = (lastStatus && lastStatus.channels) || [];
  const out = [];
  for (const c of chs) {
    if (!c.node_key) continue;
    const isBtc = (c.asset_label === 'BTC' || c.leg === 'btc');
    const match = kind === 'BTC' ? isBtc : (!isBtc && (c.asset === kind || c.asset_label === A.assetMeta(kind).ticker));
    if (match && String(c.state || '').startsWith('CHANNELD')) out.push({ scid: c.short_channel_id, node_key: c.node_key, spendable_units: Number(c.spendable_units || 0) });
  }
  return out;
}

// The wallet's share of its own channels for a kind, the reserve included: its
// Lightning balance, which counts in the asset's figure. An LSP that predates
// balance_units reports only what can be sent, which stands in for it.
export function balanceFor(kind) {
  const chs = (lastStatus && lastStatus.channels) || [];
  let units = 0, n = 0;
  for (const c of chs) {
    if (!c.node_key) continue;
    const isBtc = (c.asset_label === 'BTC' || c.leg === 'btc');
    const match = kind === 'BTC' ? isBtc : (!isBtc && (c.asset === kind || c.asset_label === A.assetMeta(kind).ticker));
    if (match && String(c.state || '').startsWith('CHANNELD')) { units += Number(c.balance_units ?? c.spendable_units ?? 0); n++; }
  }
  return { units, channels: n };
}

// Summary for the popup: per-kind Lightning balance (`balanceFor`), serializable (strings).
export async function summary(heldHexes) {
  lnInit();
  if (!seqlnState().deployed) return { deployed: false, perKind: {} };
  try { await refreshStatus(); } catch { return { deployed: true, perKind: {}, unreachable: true }; }
  const swapped = (await stGet('local', 'ext.lnAssets').catch(() => null)) || [];
  const perKind = {};
  for (const k of [...new Set(['BTC', ...heldHexes, ...swapped])]) {
    const s = balanceFor(k);
    if (s.channels > 0) perKind[k] = { units: String(Math.round(s.units)), channels: s.channels };
  }
  return { deployed: true, perKind };
}

// LN-capable kinds: BTC plus held, fee-priced Sequentia assets (a hosted node
// prices its channel asset for fees; uniform across assets — no privilege).
export function capableKinds(heldHexes) {
  return ['BTC', ...heldHexes.filter((h) => { const e = A.feeRateEntry(h); return e && e.rate > 0; })];
}

// Per-kind channel detail for the website provider (the LNDEX gate: a trade
// needs spendable capacity to send and receivable capacity to get paid).
// Serializable, own channels only.
export async function channelsSerialized(heldHexes) {
  const swapped = (await stGet('local', 'ext.lnAssets').catch(() => null)) || [];
  heldHexes = [...new Set([...(heldHexes || []), ...swapped])];
  lnInit();
  if (!seqlnState().deployed) return { deployed: false, channels: [] };
  await refreshStatus();
  const chs = (lastStatus && lastStatus.channels) || [];
  const out = [];
  for (const c of chs) {
    if (!c.node_key) continue;
    if (!String(c.state || '').startsWith('CHANNELD')) continue;
    const isBtc = (c.asset_label === 'BTC' || c.leg === 'btc');
    let kind = isBtc ? 'BTC' : (c.asset || null);
    if (!kind) {
      // Some LSP builds only echo the ticker; resolve it against held assets.
      const hit = heldHexes.find((h) => A.assetMeta(h).ticker === c.asset_label);
      kind = hit || null;
    }
    if (!kind) continue;
    out.push({
      kind,
      scid: c.short_channel_id || null,
      state: c.state,
      spendable: String(Math.round(Number(c.spendable_units || 0))),
      receivable: c.receivable_units != null ? String(Math.round(Number(c.receivable_units))) : null,
    });
  }
  return { deployed: true, channels: out };
}

// Marketplace phase one: buy JIT inbound liquidity from the LSP for `kind`.
export async function requestInbound({ kind, atoms }) {
  lnInit();
  const meta = kind === 'BTC' ? { ticker: 'BTC' } : A.assetMeta(kind);
  say('Bringing your ' + meta.ticker + ' Lightning node online…');
  const prov = await connectOwnNode(kind);
  say('Preparing your Lightning node…');
  await waitNodeReadyPatient(prov.key, meta.ticker);
  say('Requesting inbound capacity…');
  const node_key = kind === 'BTC' ? await btcNodeKey() : await assetNodeKey(kind);
  const r = await seqlnChannelInbound({ node_key, asset: kind === 'BTC' ? undefined : kind, amount: Number(atoms) });
  return { ok: true, result: r ?? null };
}

// ---- invoice / pay ----
export async function createInvoice({ kind, atoms, memo }) {
  lnInit();
  const meta = kind === 'BTC' ? { ticker: 'BTC' } : A.assetMeta(kind);
  say('Bringing your ' + meta.ticker + ' Lightning node online…');
  const prov = await connectOwnNode(kind);
  // A freshly provisioned node blocks at hsmd init until the device signer
  // attaches, and its RPC socket appears only seconds later — calling
  // lightning-cli before that fails with "lightning-rpc: No such file".
  say('Preparing your Lightning node (booting and syncing)…');
  await waitNodeReadyPatient(prov.key, meta.ticker);
  const node_key = kind === 'BTC' ? await btcNodeKey() : await assetNodeKey(kind);
  say('Ensuring inbound liquidity…');
  try { await seqlnChannelInbound({ node_key, asset: kind === 'BTC' ? undefined : kind, amount: Number(atoms) }); } catch {}
  say('Creating the invoice…');
  const inv = await seqlnNodeReceive({ node_key, amount: Number(atoms), description: memo || ('Receive ' + meta.ticker) });
  if (!inv || !inv.bolt11) throw new Error((inv && inv.error) || 'no invoice returned');
  return { bolt11: inv.bolt11 };
}

export async function payInvoice({ kind, bolt11 }) {
  lnInit();
  const meta = kind === 'BTC' ? { ticker: 'BTC' } : A.assetMeta(kind);
  // The invoice names what it is paid in, and only a node holding that can pay it: refuse
  // another before any node is brought online.
  const inv = lnInvoiceKind(bolt11);
  if (inv.error) throw new Error(inv.error);
  if (inv.kind !== kind) {
    const want = inv.kind === 'BTC' ? 'BTC' : (A.assetMeta(inv.kind).ticker || inv.kind.slice(0, 8) + '…');
    throw new Error('this invoice is paid in ' + want + ', not ' + meta.ticker + '; pay it from your ' + want + ' Lightning node');
  }
  say('Bringing your ' + meta.ticker + ' Lightning node online…');
  const prov = await connectOwnNode(kind);
  say('Preparing your Lightning node…');
  await waitNodeReadyPatient(prov.key, meta.ticker);
  const node_key = kind === 'BTC' ? await btcNodeKey() : await assetNodeKey(kind);
  say('Paying over Lightning…');
  const r = await seqlnNodePay({ node_key, bolt11 });
  if (!(r && r.paid)) throw new Error((r && r.error) || 'payment did not complete');
  return { paid: true, preimage: r.preimage || null };
}

// ---- move to Lightning (non-custodial channel funding) ----
// The wallet signs the on-chain deposit itself; the LSP then opens a channel
// the device co-signs. The pending move is persisted the moment the deposit is
// sent so an interruption can always be finished (never strands funds).
const MOVE_KEY = 'ext.ln.pendingMove';

export async function moveToLightning({ kind, atoms }) {
  lnInit();
  const isBtc = kind === 'BTC';
  const meta = isBtc ? { ticker: 'BTC', precision: 8 } : A.assetMeta(kind);
  if (isBtc && BigInt(atoms) < 546n) throw new Error('minimum channel is 546 sats (the dust limit)');
  say('Provisioning your ' + meta.ticker + ' Lightning node…');
  const prov = await connectOwnNode(kind);
  say('Preparing your Lightning node (booting and syncing)…');
  await waitNodeReadyPatient(prov.key, meta.ticker);
  say('Node ready. Preparing the on-chain deposit…');
  const moveRec = { chain: isBtc ? 'btc' : 'seq', asset: isBtc ? undefined : kind, amount: Number(atoms), node: prov.key, ticker: meta.ticker };
  const phases = {
    'deposit-address': 'Getting your hosted node deposit address…',
    'sending': 'Signing and sending the on-chain deposit…',
    'sent': 'Deposit sent; waiting for confirmation…',
    'pending_deposit': 'Waiting for the deposit to confirm on-chain…',
    'opening': 'Opening the Lightning channel (your device is co-signing)…',
    'awaiting_lockin': 'Channel funding broadcast; waiting for it to confirm…',
  };
  const res = await fundChannel({
    chain: moveRec.chain, asset: moveRec.asset, amount: moveRec.amount, node: prov.key,
    sendOnchain: (args) => engine.sendToAddress(args),
    onProgress: (e) => {
      if (e.phase === 'sent') stSet('local', MOVE_KEY, moveRec).catch(() => {});
      if (e.phase === 'reconnecting') { say('Connection hiccup — reconnecting (your deposit is safe)…'); return; }
      if (phases[e.phase]) say(phases[e.phase]);
    },
  });
  await stDel('local', MOVE_KEY);
  await rememberOwnLeg(isBtc ? 'btc' : kind.toLowerCase());
  return { short_channel_id: res.short_channel_id || null, spendable_msat: res.spendable_msat ?? null };
}

// Finish an interrupted move (deposit landed, channel not yet open). Called on
// unlock; idempotent and best-effort.
export async function resumePendingMove() {
  const rec = await stGet('local', MOVE_KEY);
  if (!rec || !rec.node) return;
  try {
    lnInit();
    const kind = rec.chain === 'btc' ? 'BTC' : rec.asset;
    const prov = await connectOwnNode(kind);
    try { await waitNodeReady({ nodeKey: prov.key, onProgress: () => {} }); } catch {}
    await resumeFundChannel({ chain: rec.chain, asset: rec.asset || undefined, amount: rec.amount, node: prov.key, onProgress: () => {} });
    await stDel('local', MOVE_KEY);
    await rememberOwnLeg(rec.chain === 'btc' ? 'btc' : String(rec.asset || '').toLowerCase());
  } catch (e) {
    console.warn('[ln] resume move (will retry on next unlock):', e?.message ?? e);
  }
}
export async function pendingMove() { return await stGet('local', MOVE_KEY); }

async function rememberOwnLeg(leg) {
  try {
    const s = new Set((await stGet('local', 'ext.ln.ownLegs')) || []);
    if (!s.has(leg)) { s.add(leg); await stSet('local', 'ext.ln.ownLegs', [...s]); }
  } catch {}
}

// ---- move back on-chain (cooperative close to a fresh wallet address) ----
export async function closeToChain({ kind }) {
  lnInit();
  await refreshStatus();
  const own = ownChannelsFor(kind);
  if (!own.length) throw new Error('no Lightning channel to close for this asset');
  const chan = own[0];
  say('Connecting your device signer…');
  say('Closing the channel (your device is co-signing)…');
  const res = await closeToWallet({ kind, scid: chan.scid, node_key: chan.node_key });
  return { closing_txid: res.closing_txid || null };
}
// Closes the wallet's own channel `scid` of `kind` cooperatively to an address of this wallet (the
// same tb1 address on both chains). The device signs a close only to its own scripts or to one the
// wallet names to it, so the address is named first; without that the close would fall back to a
// unilateral one paying the node's own address. `unilateraltimeout`: the seconds the cooperative
// close is given first.
export async function closeToWallet({ kind, scid, node_key, unilateraltimeout }) {
  lnInit();
  const prov = await connectOwnNode(kind);
  const dest = engine.currentAddress(false).address;
  const script = btcLib.OutScript.encode(btcLib.Address(btcLib.TEST_NETWORK).decode(dest));
  approveCloseDestination(prov.key, Array.from(script, (x) => x.toString(16).padStart(2, '0')).join(''));
  return await closeChannelLsp({
    chain: kind === 'BTC' ? 'btc' : 'seq',
    asset: kind === 'BTC' ? undefined : kind,
    node: prov.key || node_key,
    scid,
    destination: dest,
    unilateraltimeout,
  });
}

// ---- the move of what the channels hold to the Ark (src/ln-to-ark.js) ----
// The wallet's own channels as the last status gave them.
export function ownChannels() { return ((lastStatus && lastStatus.channels) || []).filter((c) => c && c.node_key); }
// 'BTC' or the asset id of channel `c`.
export function channelKind(c) {
  if (c.asset_label === 'BTC' || c.leg === 'btc') return 'BTC';
  const a = String(c.asset || '').toLowerCase();
  if (a === 'policy' || String(c.asset_label || '').toLowerCase() === 'policy') return String(engine.getPolicyHex() || '').toLowerCase();
  return a;
}
// The node key of the wallet's own node for `kind`, brought online and ready.
export async function readyNode(kind) {
  const prov = await connectOwnNode(kind);
  await waitNodeReadyPatient(prov.key, kind === 'BTC' ? 'BTC' : A.assetMeta(kind).ticker);
  return kind === 'BTC' ? await btcNodeKey() : await assetNodeKey(kind);
}
export async function nodePay({ node_key, bolt11 }) {
  const r = await seqlnNodePay({ node_key, bolt11 });
  if (!(r && r.paid)) throw new Error((r && r.error) || 'payment did not complete');
  return r;
}
// How the node's payments under a hash stand: { state: 'none'|'pending'|'complete'|'failed' }
// (the service's /node/pay-status, as the web wallet's seqln.js asks it).
export async function nodePayStatus({ node_key, payment_hash }) {
  const r = await fetch(LSP.url + '/node/pay-status?node=' + encodeURIComponent(node_key) + '&payment_hash=' + encodeURIComponent(payment_hash),
    { headers: { authorization: 'Bearer ' + LSP.token } });
  if (!r.ok) throw new Error('the Lightning service answered HTTP ' + r.status);
  return await r.json();
}
