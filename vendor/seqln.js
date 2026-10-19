// ---------------------------------------------------------------------------
// seqln.js — the wallet's Lightning module (the LSP / hosted-SeqLN thin client).
//
// The non-custodial instant-LN cross-chain DEX from a thin wallet. Under the LSP
// model (UX-audit §8.2 Tier 2): WE host the SeqLN nodes; the wallet is a thin
// client that (a) holds the keys and CO-SIGNS the hosted nodes' commitment
// updates via the on-device wasm signer SDK over wss Noise links, and (b)
// COMMANDS a cross-chain swap through a thin LSP HTTP API.
//
// The cross-chain pure-LN rail is TWO hosted nodes co-signed by ONE wallet:
//   * an ASSET node (holds the GOLD channel on Sequentia), and
//   * a BTC node    (holds the BTC channel on testnet4).
// The two legs settle atomically on one preimage. Both hosted nodes are KEYLESS
// (no hsm_secret): the browser device is the sole signer for BOTH. It signs only
// commitments it has validated and approves each payment only within its payment
// limit for the asset (SEQ_LN_PAYMENT_LIMITS). That does not protect the user
// from an operator who runs both the hosted node and its channel peer: the node
// still collects the device's signature on each commitment before the device
// revokes it (the preempt slot), so the two together could broadcast a revoked
// commitment. The wallet's job
// on the swap path is simply to keep BOTH device signers serving so the two
// hosted nodes can co-sign their legs; the LSP (`POST /swap`) drives both legs.
//
// Two independent concerns, kept separate:
//   1. connectDevice()  — bring ONE on-device signer online (needs the wasm SDK,
//      a wss endpoint, and the wallet-derived per-node device identity). Called
//      once per hosted node (asset + btc). Browser-gated.
//   2. seqlnGetStatus() / seqlnSwap()  — the LSP HTTP client (plain fetch, so it
//      is fully testable in Node and mirrors the SEQ_SEQOB_URL global pattern).
//
// This module holds NO app/DOM references; index.html derives the per-node keys
// (seqln-keys.js), wires status into the UI, and swap.js reaches it through the
// `ln` bridge (beside xswap/xrswap/xmaker).
// ---------------------------------------------------------------------------

import { makeNoteStore, channelFate } from './lnupgrade.js';

const W = (typeof window !== 'undefined') ? window : {};

const DEFAULTS = {
  lspUrl: W.SEQ_LSP_URL
    || (typeof location !== 'undefined' ? location.origin + '/lsp' : 'http://127.0.0.1:9981'),
  token: W.SEQ_LSP_TOKEN || '',
  // Per-node wss front of each hosted node's Noise_XK responder (WS<->TCP relay).
  // Absent for a node => the on-device signer for that node cannot come online.
  // The legacy single-node vars (SEQ_LSP_WS / SEQ_LSP_HOST_PUBKEY) are honoured as
  // a fallback for the ASSET slot so an existing one-node deployment keeps working.
  nodes: {
    asset: {
      wsUrl: W.SEQ_LSP_WS_ASSET || W.SEQ_LSP_WS || '',
      hostPubkey: W.SEQ_LSP_HOST_PUBKEY_ASSET || W.SEQ_LSP_HOST_PUBKEY || '',
    },
    btc: {
      wsUrl: W.SEQ_LSP_WS_BTC || '',
      hostPubkey: W.SEQ_LSP_HOST_PUBKEY_BTC || '',
    },
  },
  // The wasm signer SDK (vendored under /lightning). Dynamic-imported so a wallet
  // with LN unconfigured never loads the 1.5MB wasm.
  sdkPath: W.SEQ_LSP_SDK || './lightning/seqln-signer-sdk.js',
  // The device's payment limits: { default: atoms|null, period: seconds,
  // assets: { <asset id>|'btc': atoms|null } }, each in the asset's own atoms,
  // null for no limit. The device approves a payment only within what its
  // limit leaves for the period. Unset, the device's own default applies
  // (10,000,000 atoms of each asset per day).
  paymentLimits: W.SEQ_LN_PAYMENT_LIMITS || null,
};

const NODES = ['asset', 'btc'];

// Resolve the signer SDK module. Environments where dynamic import() is
// unavailable (MV3 extension service workers: the HTML spec disallows
// import() on ServiceWorkerGlobalScope) pass the statically imported module
// via initSeqln({ sdk }); everywhere else it is lazy-loaded from sdkPath so a
// wallet with LN unconfigured never fetches the 1.5MB signer wasm.
async function loadSdk() {
  if (CFG.sdk) return CFG.sdk;
  return await import(CFG.sdkPath);
}

let CFG = cloneCfg(DEFAULTS);
let onChange = null;

// Per-node signer + connection state. `enabled` = this node has a wss endpoint +
// host key configured, so it is REQUIRED for the cross-chain rail to be available.
function freshNode() {
  return { signer: null, connected: false, nodeId: null, phase: 'idle', detail: '', enabled: false };
}
const nodeState = { asset: freshNode(), btc: freshNode() };

function cloneCfg(src) {
  return {
    lspUrl: src.lspUrl, token: src.token, sdkPath: src.sdkPath, sdk: src.sdk || null, wsBase: src.wsBase || null,
    paymentLimits: src.paymentLimits || null,
    nodes: {
      asset: { ...src.nodes.asset },
      btc: { ...src.nodes.btc },
    },
  };
}

function markEnabled() {
  for (const n of NODES) {
    nodeState[n].enabled = !!(CFG.nodes[n].wsUrl && CFG.nodes[n].hostPubkey);
  }
}

function setPhase(node, phase, detail) {
  const s = nodeState[node];
  s.phase = phase; s.detail = detail || '';
  if (onChange) { try { onChange(seqlnState()); } catch {} }
}

// initSeqln reads the window globals into CFG (SEQ_LSP_URL / _TOKEN and the
// per-node _WS_ASSET/_HOST_PUBKEY_ASSET + _WS_BTC/_HOST_PUBKEY_BTC, with the
// legacy single-node vars as the asset-slot fallback). `opts` overrides any of
// these (used by the Node tests, which pass an explicit lspUrl/sdkPath/nodes).
export function initSeqln(opts = {}) {
  CFG = cloneCfg(DEFAULTS);
  if (opts.lspUrl != null) CFG.lspUrl = opts.lspUrl;
  if (opts.token != null) CFG.token = opts.token;
  if (opts.sdkPath != null) CFG.sdkPath = opts.sdkPath;
  if (opts.sdk != null) CFG.sdk = opts.sdk;
  if (opts.wsBase != null) CFG.wsBase = opts.wsBase;
  if (opts.paymentLimits !== undefined) CFG.paymentLimits = opts.paymentLimits;
  if (opts.nodes) {
    for (const n of NODES) {
      if (opts.nodes[n]) CFG.nodes[n] = { ...CFG.nodes[n], ...opts.nodes[n] };
    }
  }
  markEnabled();
  return CFG;
}

export function seqlnConfigured() { return !!CFG.lspUrl; }

// True when ANY hosted node is configured (so the UI should surface the LN pill).
export function seqlnDeployed() {
  return NODES.some((n) => nodeState[n].enabled);
}

// Snapshot for the UI. `connected` (and the top-level phase) reflect the WHOLE
// rail: a cross-chain swap needs BOTH legs, so `connected` is true only when
// every ENABLED node's device signer is serving. `nodes` exposes each leg.
export function seqlnState() {
  const enabled = NODES.filter((n) => nodeState[n].enabled);
  const connectedCount = enabled.filter((n) => nodeState[n].connected).length;
  const allConnected = enabled.length > 0 && connectedCount === enabled.length;
  const anyError = enabled.some((n) => nodeState[n].phase === 'error');
  const nodes = {};
  for (const n of NODES) {
    const s = nodeState[n];
    nodes[n] = { enabled: s.enabled, connected: s.connected, nodeId: s.nodeId, phase: s.phase, detail: s.detail };
  }
  return {
    configured: seqlnConfigured(),
    deployed: enabled.length > 0,
    connected: allConnected,
    connectedCount, enabledCount: enabled.length,
    phase: allConnected ? 'ready' : (anyError ? 'error' : (enabled.length ? 'connecting' : 'idle')),
    nodes,
  };
}

export function onSeqlnStatus(fn) { onChange = fn; }

// The LN swap route is offerable only when the LSP is reachable AND every enabled
// hosted node's on-device signer is serving (so BOTH hosted legs can co-sign the
// atomic swap). Deliberately conservative: a missing leg => no LN route, and the
// composer falls back to the on-chain cross rail.
export function seqlnAvailable() {
  return seqlnConfigured() && seqlnState().connected;
}

// Pure-LN happy path: genuinely instant + final (nothing on-chain, zero reorg
// risk). This is the ONE swap state the DEX 0-conf policy lets us call "final".
export function lnFinalityCopy() {
  return 'Instant and final · pure Lightning, nothing on-chain, no Bitcoin-reorg risk.';
}

// Channel-store persistence for a device signer (the restart contract). CLN sends
// setup_channel ONCE at channel creation; a page reload builds a FRESH wasm signer
// that has lost every channel, and in enforce mode that freezes the channel's funds
// (every commitment sign refused, channeld dies at init, closing included). The
// hosted proxy's durable priming replays setup_channel on attach (the primary
// heal); this localStorage blob is the device-side backstop for when the node's
// priming cache is lost. It carries no secrets and is MAC'd to the signing seed,
// so a foreign or stale blob fails import harmlessly.
function chStoreFor(storageKey) {
  const k = 'swk.seqln.chstore.' + storageKey;
  return {
    load: () => {
      const b64 = localStorage.getItem(k);
      if (!b64) return null;
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    },
    save: (bytes) => {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      try { localStorage.setItem(k, btoa(s)); } catch {}
    },
  };
}
// Diagnostic surface for an untracked-channel refusal: name the channel and the
// recovery path instead of leaving only channeld's opaque death in the node log.
// A policy refusal kills the channel it was for (channeld exits, every later HTLC
// on it fails with "unowned"), so the REASON must reach the log — otherwise the
// wallet reports a generic Lightning failure for a decision the device made.
// The last refusal per node, so the WALLET can say what happened rather than reporting the
// node as unreachable. A refusal is not a transient failure: lightningd drops the signer
// session when a signer says no, and if the request comes from the node's startup the node
// never finishes starting — it looks exactly like a node that is down, and stays that way.
const _lastRefusal = new Map();
export function signerRefusals() { return new Map(_lastRefusal); }
export function clearSignerRefusal(label) { _lastRefusal.delete(label); }
// The options every device signer is built with: its persisted channel store, the
// refusal hooks, and the configured payment limits.
function signerOpts(key) {
  const o = { channelStore: chStoreFor(key), onUntracked: onUntrackedFor(key), onReject: onRejectFor(key),
    onPredating: onPredatingFor(key) };
  if (CFG.paymentLimits) o.paymentLimits = CFG.paymentLimits;
  return o;
}

// Channels the device found in a store its predecessor wrote, which validated nothing: the
// device signs no step of them. Kept per node (by its label), minus what the user dismissed, for
// the note the wallet builds from what the node reports (lnupgrade.js). Each { peerId, dbid,
// fundingTxid, fundingOutnum, fundingSats }.
const noteStore = makeNoteStore({
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
});
function onPredatingFor(label) {
  return (channels) => {
    // The SDK reports them again after every store restore: a dismissed channel stays dismissed.
    if (!noteStore.record(label, channels)) return;
    console.warn(`seqln[${label}]: channel(s) from the device's old store are not carried over`);
    if (onChange) { try { onChange(seqlnState()); } catch {} }
  };
}
// { [label]: [channel, ...] }: what each node's device found in an old store, not dismissed.
export function predatingChannels() { return noteStore.channels(); }
// Dismiss the note for node `label`: all of its old channels, or with `closedOnly` those the
// node (`node`, its /node/onchain answer) reports closed; and the line about its coins outside
// a channel while they stay at `onchainMsat` (or the node's reported amount).
export function dismissPredating(label, { closedOnly = false, node = null, onchainMsat = null } = {}) {
  const list = noteStore.channels()[label] || [];
  const channels = closedOnly ? list.filter((c) => channelFate(c, node) === 'closed') : list;
  const msat = onchainMsat != null ? onchainMsat : (node && node.node_up ? node.onchain_msat : null);
  noteStore.dismiss(label, { channels, onchainMsat: msat });
}
export function idleDismissed(label, onchainMsat) { return noteStore.idleDismissed(label, onchainMsat); }

function onRejectFor(label) {
  return ({ name, reason }) => {
    _lastRefusal.set(label, { name, reason, at: Date.now() });
    console.warn(`seqln[${label}]: the signer REFUSED ${name} — ${reason}`);
  };
}
function onUntrackedFor(label) {
  return ({ peerId, dbid }) => {
    console.warn(`seqln[${label}]: the signer refused channel dbid ${dbid} with peer ${peerId.slice(0, 16)}… `
      + '(no tracked channel). The hosted proxy re-primes it on the next device attach; '
      + 'if this repeats, the node\'s priming cache and the device store are both gone.');
  };
}

// -- 1. on-device signers (browser-gated: WebSocket + wasm + the SDK) ----------
// Connect ONE hosted node's device signer. Called once per node (asset + btc).
//   node                   'asset' | 'btc' (which hosted node this signer serves)
//   deviceSigningSeed      the per-node SeqLN signing seed (seqln-keys.js) fed to
//                          SeqlnSigner.fromMnemonic — determines the keyless
//                          hosted node's LN identity (node_id + channel keys).
//   deviceTransportPrivkey the per-node Noise static privkey (its pubkey is what
//                          the LSP pins for this node).
//   wsUrl / hostStaticPubkey  the node's wss relay + pinned host static pubkey
//                          (default: CFG.nodes[node], read from the window vars).
export async function connectDevice({
  node, deviceSigningSeed, deviceTransportPrivkey,
  wsUrl, hostStaticPubkey, policy = 'enforce',   // enforce custody by default; callers pass 'permissive' (SEQ_LSP_POLICY kill-switch) to override
} = {}) {
  if (!node || !NODES.includes(node)) { throw new Error("connectDevice: node must be 'asset' or 'btc'"); }
  const cfgNode = CFG.nodes[node] || {};
  const ws = wsUrl || cfgNode.wsUrl;
  const hostPub = hostStaticPubkey || cfgNode.hostPubkey;
  const s = nodeState[node];

  if (!ws || !hostPub) { setPhase(node, 'unconfigured', 'no wss endpoint / host key'); return null; }
  if (!deviceSigningSeed || !deviceTransportPrivkey) { setPhase(node, 'unconfigured', 'no device identity'); return null; }
  if (s.signer) return s.nodeId;   // already connected/connecting for this node

  setPhase(node, 'connecting', 'loading signer');
  const mod = await loadSdk();
  const SeqlnSigner = mod.SeqlnSigner || mod.default;
  const signer = await SeqlnSigner.fromMnemonic(deviceSigningSeed,
    signerOpts(node));
  signer.setPolicy(policy);
  s.signer = signer;
  signer.onStatus = (st) => {
    if (st.state === 'node_id') { s.nodeId = st.nodeId; setPhase(node, 'node_id', st.nodeId.slice(0, 14) + '…'); }
    else setPhase(node, st.state, st.detail);
    // Drop the dead signer object, not just the flag: a closed ws can't be reused (SDK builds a
    // fresh SeqlnSigner per connect), and the `if (s.signer) return` guards below would otherwise
    // block every reconnect after a link drop (the "won't reconnect after refresh/sleep" bug).
    if (st.state === 'closed' || st.state === 'error') { s.connected = false; s.signer = null; }
  };
  try {
    await signer.connect({ wsUrl: ws, hostStaticPubkey: hostPub, deviceStaticPrivkey: deviceTransportPrivkey });
    const id = await signer.whenNodeId(30000);
    s.nodeId = id; s.connected = true; setPhase(node, 'ready', 'signer serving');
    return id;
  } catch (e) {
    s.signer = null; s.connected = false; setPhase(node, 'error', e.message || String(e));
    return null;
  }
}

export function disconnectDevice(node) {
  const targets = node ? [node] : NODES;
  for (const n of targets) {
    const s = nodeState[n];
    try { s.signer?.disconnect(); } catch {}
    s.signer = null; s.connected = false; setPhase(n, 'idle', '');
  }
}

// -- provisioned per-asset nodes (dynamic N/M, beyond the fixed asset+btc rail) -----
// SeqLN is single-asset, so moving a NEW asset into Lightning provisions its own hosted
// node; the device attaches a signer to it exactly like the fixed nodes, but there can
// be arbitrarily many, so they live in a dynamic map (keyed by asset id) rather than the
// fixed asset/btc slots.
// The scripts of this wallet's own on-chain addresses a node's device may close a channel to
// (SeqlnSigner.approveCloseDestination). The device keeps none across a start, so they are kept
// here per node and named again whenever its signer is built.
const CLOSE_TO_KEY = 'swk.ln.closeTo.v1';   // { [nodeKey]: [scriptHex, ...] }
function closeToScripts() {
  try { return JSON.parse(localStorage.getItem(CLOSE_TO_KEY) || '{}') || {}; } catch { return {}; }
}
// Name `scriptHex`, a script of this wallet's own address, to the device of node `nodeKey`, so the
// node's next cooperative close may pay this side's balance there. Throws when that node's signer
// is not running.
export function approveCloseDestination(nodeKey, scriptHex) {
  const k = String(nodeKey || '').toLowerCase(), hex = String(scriptHex || '').toLowerCase();
  if (!k || !/^([0-9a-f]{2})+$/.test(hex)) throw new Error('approveCloseDestination: a node key and a script in hex are required');
  const s = provNodes[k];
  if (!s || !s.signer) throw new Error('your device signer for that Lightning node is not running');
  s.signer.approveCloseDestination(hex);
  const all = closeToScripts(), list = all[k] || [];
  if (!list.includes(hex)) {
    all[k] = [...list, hex].slice(-20);
    try { localStorage.setItem(CLOSE_TO_KEY, JSON.stringify(all)); } catch {}
  }
}
const provNodes = {};   // assetId -> { signer, connected, nodeId, phase, detail }

// Device transport pubkey (33-byte compressed hex) for a privkey — what the hosted node
// PINS (SEQLN_SIGNER_PEER_PUBKEY). Derived via the wasm SDK (same curve the node uses).
export async function deviceTransportPubkey(transportPrivkey) {
  const mod = await loadSdk();
  const S = mod.SeqlnSigner || mod.default;
  return S.devicePubkey(transportPrivkey);
}

// The wss URL a browser uses to reach a provisioned node's Noise responder (through the
// TLS front's per-node path). Deploy prerequisite: a Caddy wildcard mapping public_ws_path
// -> the node's private ws port. Overridable via SEQ_LSP_WS_BASE for local/test wiring.
function provWsUrl(publicWsPath) {
  // CFG.wsBase first: a page can fall back to location.origin, but an MV3
  // service worker's origin is chrome-extension:// and useless as a ws base,
  // so the extension passes the public base via initSeqln({ wsBase }).
  const base = CFG.wsBase || W.SEQ_LSP_WS_BASE
    || (typeof location !== 'undefined' ? location.origin.replace(/^http/, 'ws') : 'ws://127.0.0.1');
  return base.replace(/\/$/, '') + publicWsPath;
}

// Connect the on-device signer to a PROVISIONED node's responder (arbitrary asset).
export async function connectProvisioned({ assetId, key, deviceSigningSeed, deviceTransportPrivkey,
  wsUrl, hostStaticPubkey, policy = 'enforce' } = {}) {   // enforce custody by default; SEQ_LSP_POLICY='permissive' overrides
  // The provNodes map key: an explicit LSP registry key (e.g. `btc:<devicepub>` for a
  // per-user BTC node), else a 32-byte-hex asset id (a Sequentia asset node is keyed by
  // its asset id). One of the two is required so the signer state is addressable.
  const mapKey = key ? String(key).toLowerCase()
    : (/^[0-9a-fA-F]{64}$/.test(String(assetId || '')) ? String(assetId).toLowerCase() : null);
  if (!mapKey) throw new Error('connectProvisioned: a node key or a 32-byte-hex assetId is required');
  const s = provNodes[mapKey] || (provNodes[mapKey] = { signer: null, connected: false, nodeId: null, phase: 'idle', detail: '' });
  if (!wsUrl || !hostStaticPubkey) { s.phase = 'unconfigured'; s.detail = 'no wss endpoint / host key'; return null; }
  if (!deviceSigningSeed || !deviceTransportPrivkey) { s.phase = 'unconfigured'; s.detail = 'no device identity'; return null; }
  if (s.signer) return s.nodeId;
  s.phase = 'connecting';
  const mod = await loadSdk();
  const SeqlnSigner = mod.SeqlnSigner || mod.default;
  const signer = await SeqlnSigner.fromMnemonic(deviceSigningSeed,
    signerOpts(mapKey));
  signer.setPolicy(policy);
  for (const hex of closeToScripts()[mapKey] || []) { try { signer.approveCloseDestination(hex); } catch {} }
  s.signer = signer;
  signer.onStatus = (st) => {
    if (st.state === 'node_id') { s.nodeId = st.nodeId; s.phase = 'node_id'; }
    else s.phase = st.state;
    // Null the dead signer (not just the flag) so a later reconnect rebuilds — the `if (s.signer)`
    // guard above would otherwise short-circuit every retry once the link has dropped once.
    if (st.state === 'closed' || st.state === 'error') { s.connected = false; s.signer = null; }
    if (onChange) { try { onChange(seqlnState()); } catch {} }
  };
  try {
    await signer.connect({ wsUrl, hostStaticPubkey, deviceStaticPrivkey: deviceTransportPrivkey });
    const id = await signer.whenNodeId(30000);
    s.nodeId = id; s.connected = true; s.phase = 'ready';
    if (onChange) { try { onChange(seqlnState()); } catch {} }
    return id;
  } catch (e) {
    s.signer = null; s.connected = false; s.phase = 'error'; s.detail = e.message || String(e);
    return null;
  }
}

// One call the Balance tab uses to move an asset into Lightning end to end (client side):
// derive this asset's device identity, provision its hosted node keyed to that device,
// and bring the signer online. Returns { node, nodeId } (the wallet then funds a channel).
//   deriveIdentity(assetId) -> { transportPrivkey, signingSeed }  (seqln-keys.lnDeriveAsset)
// `chain` selects the hosted node kind: 'seq' (a Sequentia asset node, keyed by `assetId`)
// or 'btc' (a per-user testnet4 node, device-keyed — no assetId). `deriveIdentity` returns
// { transportPrivkey, signingSeed }: for seq it takes the assetId (lnDeriveAsset); for btc
// it ignores the arg (the btc device identity, lnDeriveNode(phrase,'btc')). Returns
// { node, nodeId, connected, key } — `key` is the LSP registry key the wallet then hands to
// fundChannel so the deposit + device-co-signed funding target THIS node, not a demo node.
export async function provisionAndConnect({ chain = 'seq', assetId, deriveIdentity, policy = 'enforce', label } = {}) {   // enforce custody by default; SEQ_LSP_POLICY='permissive' overrides
  if (typeof deriveIdentity !== 'function') throw new Error('provisionAndConnect: deriveIdentity(assetId) is required');
  const id = deriveIdentity(assetId);
  const devicePubkey = await deviceTransportPubkey(id.transportPrivkey);
  const node = await provisionNode({ chain, asset: assetId, deviceTransportPubkey: devicePubkey, label });
  // The registry key the LSP routes /channel/deposit + /channel/open by. Prefer the key the
  // LSP returned; fall back to the asset id (seq) or the device-keyed form (btc) so a stub
  // /node/provision (the Node test) that omits `key` still resolves the same key the LSP uses.
  const nodeKey = node.key
    || (chain === 'btc' ? `btc:${String(devicePubkey).toLowerCase()}` : String(assetId).toLowerCase());
  const wsUrl = provWsUrl(node.public_ws_path);
  const nodeId = await connectProvisioned({
    key: nodeKey, deviceSigningSeed: id.signingSeed, deviceTransportPrivkey: id.transportPrivkey,
    wsUrl, hostStaticPubkey: node.host_pubkey, policy,
  });
  return { node, nodeId, connected: !!nodeId, key: nodeKey };
}

// Snapshot of the provisioned-node signers (for the dynamic N/M leg display).
export function provisionedState() {
  const out = {};
  for (const [k, s] of Object.entries(provNodes)) out[k] = { connected: s.connected, nodeId: s.nodeId, phase: s.phase, detail: s.detail };
  return out;
}

export function disconnectProvisioned(assetId) {
  const keys = assetId ? [String(assetId).toLowerCase()] : Object.keys(provNodes);
  for (const k of keys) { const s = provNodes[k]; if (!s) continue; try { s.signer?.disconnect(); } catch {} s.signer = null; s.connected = false; s.phase = 'idle'; }
}

// -- 2. LSP HTTP client (plain fetch; Node-testable) ---------------------------
// How long an LSP call may take before it is a failure rather than a wait.
//
// ⚠ THIS USED TO BE UNBOUNDED, and that is why a rail-crossing trade could look like
// the app had ignored the button press: a bare fetch that never resolves leaves the
// caller awaiting forever, so the swap record stayed in 'starting', its driver lock
// stayed held, and the in-flight guard blocked every future trade with nothing on
// screen to explain it. A hung request must fail so the record can reach a terminal
// state and the user can retry.
//
// Settlement calls are the slow ones (a JIT channel, a maker handshake), so the
// budget is generous rather than tight; anything past it is a broken request, not a
// slow one. Callers that genuinely wait on a counterparty poll do so by REPEATING a
// bounded call, never by holding one open.
const LSP_TIMEOUT_MS = 90_000;

async function lspFetch(path, { allowNotOk = false, ...opts } = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (CFG.token) headers.authorization = `Bearer ${CFG.token}`;
  // FEATURE-DETECT the timeout. AbortSignal.timeout is not available on older
  // browsers and some WebViews, and calling it there throws a TypeError — which,
  // because every caller of this function guards with a bare catch, would silently
  // fail EVERY LSP call and present as "could not reach the order book" while the
  // relay-backed book kept rendering fine. A timeout is a safety net; it must never
  // be the thing that breaks the request.
  const ms = opts.timeoutMs || LSP_TIMEOUT_MS;
  let signal = opts.signal || null, timer = null;
  if (!signal) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      try { signal = AbortSignal.timeout(ms); } catch { signal = null; }
    }
    if (!signal && typeof AbortController === 'function') {
      const ac = new AbortController();
      signal = ac.signal;
      timer = setTimeout(() => { try { ac.abort(); } catch {} }, ms);
    }
  }
  let r;
  try {
    r = await fetch(CFG.lspUrl + path, signal ? { ...opts, headers, signal } : { ...opts, headers });
  } catch (e) {
    // Name the timeout for what it is. "The request timed out" is actionable; a bare
    // AbortError surfaced as an unexplained stall.
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      throw new Error('the request timed out - nothing of yours was committed');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { ok: false, error: txt || 'bad json' }; }
  // opts.allowNotOk: for a STATUS read, `ok:false` is the answer, not an error.
  // See seqlnJobStatusRaw. Transport failures (a non-2xx with no body we can parse)
  // still throw, because those genuinely tell the caller nothing.
  if (allowNotOk && txt && typeof j === 'object' && j && j.status) return j;
  if (!r.ok || j.ok === false) {
    // Surface the LSP's `detail` (the settlement binary's actual output) alongside the
    // summary error — dropping it left terminal failures as a bare "did not settle"
    // with the real reason discarded.
    const detail = j.detail ? String(j.detail).trim().split('\n').filter(Boolean).slice(-2).join(' · ') : '';
    const err = new Error((j.error || ('HTTP ' + r.status)) + (detail ? ` — ${detail.slice(0, 300)}` : ''));
    err.status = r.status;
    throw err;
  }
  return j;
}
// Registry keys for the device's OWN provisioned nodes to also read in /status, BEYOND the ones
// connected this session (provNodes). The wallet reconstructs these from its mnemonic on load
// (`registerOwnStatusKeys`), so a REOPENED wallet still reads back channels on its own nodes —
// else a just-moved balance looks gone after a refresh. Self-scoped: only keys this device could
// derive are added, and the LSP resolves a key ONLY if this device actually provisioned that node,
// so a candidate key for a node that was never opened simply returns nothing.
const ownStatusKeys = new Set();
export function registerOwnStatusKeys(keys) { for (const k of (keys || [])) if (k) ownStatusKeys.add(String(k).toLowerCase()); }

// Both hosted nodes' ids + per-asset channel balances (spendable=send, recv=recv). Passes THIS
// device's provisioned-node keys (`?nodes=`) so /status also reports the device's OWN per-asset
// channels — so the Balance card reflects a channel the user created on their own node (not only
// the shared demo nodes), including across page reloads. Only keys this device derived are sent,
// so it stays self-scoped.
export function seqlnGetStatus() {
  const keys = [...new Set([...Object.keys(provNodes), ...ownStatusKeys])];
  return lspFetch('/status' + (keys.length ? ('?nodes=' + encodeURIComponent(keys.join(','))) : ''));
}

// The PURE-LN order book for <asset>/BTC, read from the SAME relay the LSP's xpln lifts from — so the
// composer prices and PINS the exact offer that will execute, instead of the on-chain cross book (a
// different market). Returns { buy_offers, sell_offers } each best-first (buy = cheapest, sell =
// richest), with offer_id + maker_pubkey to pin into the swap. A thrown error / older LSP without the
// endpoint means "no pure-LN liquidity" — the caller degrades honestly (disables Review).
export function seqlnLnBook(asset, quote) {
  // quote: a real Sequentia asset id for an asset<->asset pure-LN market (EURX/OILX), else omitted =
  // the classic asset<->BTC book (unchanged wire for every existing call).
  let q = '/lnbook?asset=' + encodeURIComponent(String(asset || ''));
  if (quote && String(quote).toUpperCase() !== 'BTC') q += '&quote=' + encodeURIComponent(String(quote));
  return lspFetch(q);
}

// Ask the LSP which of the device's CANDIDATE node keys are ACTUALLY provisioned (exist in the
// registry) — resolved from the PROV registry, NOT the node RPC, so a node blocked waiting for its
// signer (invisible to /status) is still discoverable. This breaks the reconnect deadlock: a just-
// revived node can be found and have its signer reattached even though it can't answer /status yet.
// Returns { provisioned: [{ key, asset_id, chain }] }. Self-scoped: only keys THIS device can derive
// are sent, and the LSP confirms a key only if this device provisioned it. Callers should treat a
// thrown error (e.g. endpoint not deployed) as "no discovery" and fall back to /status + remembered legs.
export function seqlnListNodes(keys) {
  const list = [...new Set((keys || []).filter(Boolean).map((k) => String(k).toLowerCase()))];
  if (!list.length) return Promise.resolve({ provisioned: [] });
  return lspFetch('/nodes/list', { method: 'POST', body: JSON.stringify({ keys: list }) });
}

// The on-chain (not-yet-in-a-channel) state of one of the device's OWN nodes. Used to DETECT a
// stranded deposit — a Move-to-Lightning whose deposit landed but whose channel never opened — so
// the wallet can finish it. Returns { node_up, onchain_msat, asset_id, channels, stranded }.
// stranded = node_up && onchain_msat>0 && channels==0. node_up:false means the node is still
// booting / awaiting its signer (unknown, not "no deposit").
export function seqlnNodeOnchain(node_key) {
  return lspFetch('/node/onchain?node=' + encodeURIComponent(node_key));
}

// --- Sub-asset BUY (pay BTC on-chain, receive asset over Lightning) HODL primitives ------------
// Ensure inbound asset liquidity to the user's OWN node so the maker can pay the asset over LN
// (JIT 0-conf inbound channel). amount in ASSET SATS.
// `months` is how long the service keeps that channel open (the price grows with it); omitted, the
// service's default.
export function seqlnChannelInbound({ node_key, asset, amount, mode, fee_txid, months }) {
  return lspFetch('/channel/inbound', { method: 'POST', timeoutMs: 180_000,
    body: JSON.stringify({ node_key, asset, amount, mode, fee_txid, months }) });
}
// The price of room to receive `amount` atoms of `asset` over Lightning, and where a prepaid fee
// goes. Returns the service's answer as it is, an out-of-range amount included ({ ok:false, reason,
// min, max }), so the caller can say what range it sells; throws only when the service cannot be
// reached.
export async function seqlnInboundQuote({ asset, amount, node_key, months }) {
  const q = `/channel/inbound/quote?asset=${encodeURIComponent(asset)}&amount=${encodeURIComponent(amount)}`
    + (node_key ? `&node_key=${encodeURIComponent(node_key)}` : '')
    + (months ? `&months=${encodeURIComponent(months)}` : '');
  const r = await fetch(CFG.lspUrl + q, { headers: CFG.token ? { authorization: `Bearer ${CFG.token}` } : {} });
  try { return await r.json(); } catch { return { ok: false, reason: 'HTTP ' + r.status }; }
}
// Register a HODL invoice by hash H on the user's OWN node (the DEVICE keeps P; the node/LSP never
// learn it). Returns { payment_hash, bolt11:null, node_id, hodl:true } — the maker pays H BY HASH
// to node_id (pay-by-hash, like the sell). amount in ASSET SATS.
// `expiry` (seconds, optional) sizes a HODL hold's validity window. The BRIDGED-SELL taker passes the
// LSP-sized bridge_terms.hold_expiry_secs so its hold on H stays SETTLEABLE until strictly after the maker's
// latest asset claim (T_seq) + margin — without it a short hold could lapse before the maker reveals P,
// stranding the taker (dead hold, asset gone). Omitted for the sub-asset HODL buy (plugin default).
export function seqlnNodeInvoice({ node_key, asset, amount, payment_hash, expiry }) {
  return lspFetch('/node/invoice', { method: 'POST', body: JSON.stringify({ node_key, asset, amount, payment_hash, expiry }) });
}
// Poll the HODL invoice state on the user's node: { state, held /* maker's payment accepted+held */, settled }.
export function seqlnInvoiceStatus({ node_key, payment_hash }) {
  return lspFetch('/node/invoice-status?node=' + encodeURIComponent(node_key) + '&payment_hash=' + encodeURIComponent(payment_hash));
}
// Device-settle a HELD HODL invoice with P: releases the held asset payment to the user AND reveals
// P to the maker (via update_fulfill_htlc), atomically. Call ONLY after invoice-status shows held.
export function seqlnNodeSettle({ node_key, payment_hash, preimage }) {
  return lspFetch('/node/settle', { method: 'POST', body: JSON.stringify({ node_key, payment_hash, preimage }) });
}
// Generic Lightning RECEIVE: a plain (non-HODL) bolt11 to receive `amount` asset sats into the user's
// own hosted node. The node signs the invoice (device online required). Returns { bolt11, payment_hash }.
export function seqlnNodeReceive({ node_key, amount, description }) {
  return lspFetch('/node/receive', { method: 'POST', body: JSON.stringify({ node_key, amount, description }) });
}
// Generic Lightning SEND: the user's own hosted node PAYS `bolt11` (device co-signs every HTLC).
// Returns { paid, preimage, amount_msat, destination }.
//
// DEFENCE-IN-DEPTH (rail-crossing submarine / payer-bridge pay): thread wantHash(H) + amountMsat +
// minFinalCltv + maxCltv so the node can BIND the payment_hash, amount and final-hop CLTV of the outgoing
// payment (mirror the Go PayInvoice(bolt11, wantHash, amountMsat)). maxCltv BOUNDS the whole route's CLTV
// delay (CLN `maxdelay`): the reverse-submarine taker caps it to the safe ceiling so that if the maker HOLDS
// the payment (a masqueraded hold invoice), the incoming HTLC fails back — refunding the taker — as EARLY as
// possible instead of lingering to the invoice's requested delay. The wallet's client-side pre-pay gates
// (payment_hash === H, amount == the offer price, min_final_cltv can't settle past T_seq) remain the PRIMARY
// guard; the /node/pay handler now ENFORCES them too: it refuses an invoice whose payment_hash, amount or
// min_final_cltv disagree, and passes maxCltv to CLN as maxdelay (the direct-hop fallback is bounded alike).
export function seqlnNodePay({ node_key, bolt11, wantHash, amountMsat, minFinalCltv, maxCltv }) {
  const body = { node_key, bolt11 };
  if (wantHash) body.wantHash = String(wantHash).toLowerCase();
  if (amountMsat != null) body.amount_msat = Number(amountMsat);
  if (minFinalCltv != null) body.min_final_cltv = Number(minFinalCltv);
  if (maxCltv != null) body.max_cltv = Number(maxCltv);
  return lspFetch('/node/pay', { method: 'POST', body: JSON.stringify(body) });
}
// BARE-HASH Lightning SEND — the user's own hosted node commits an HTLC to `node_id` keyed on `hash`
// (NO bolt11) with a final-hop CLTV of min_final_cltv blocks. This is the LSP PAYER leg-bridge primitive:
// the seqln holdinvoice mints no bolt11, so the taker pays the LSP's hold by hash (mirror of the receiver
// bridge / sub-asset bare-hash sendpay). Returns { committed, status } — the HTLC lands HELD at the LSP and
// settles only when the LSP recoups with P; the client does NOT block on completion (see runLspPayerBridge).
export function seqlnNodePayHash({ node_key, node_id, hash, amount_msat, min_final_cltv, connect_hints }) {
  const body = { node_key, node_id: String(node_id).toLowerCase(), hash: String(hash).toLowerCase(), amount_msat: Number(amount_msat) };
  if (min_final_cltv != null) body.min_final_cltv = Number(min_final_cltv);
  if (Array.isArray(connect_hints) && connect_hints.length) body.connect_hints = connect_hints;
  return lspFetch('/node/payhash', { method: 'POST', body: JSON.stringify(body) });
}
// Advisory status of an async LSP job (e.g. the sub-asset HODL BUY /swap job). Takes the poll path
// ('/swap/<id>') the /swap 202 returned, or a bare id. The wallet drives its own settle; this is only
// a display hint (pending|held|settled|failed).
export function seqlnJobStatus(pathOrId) {
  const p = String(pathOrId || '');
  return lspFetch(p.startsWith('/') ? p : ('/swap/' + p));
}

// The SAME status read, but it does not throw when the job itself has failed.
//
// lspFetch rejects on `ok:false`, which is right for a command ("the thing you
// asked for did not happen") and exactly wrong for a status query: a FAILED job
// answers {ok:false, status:'failed', error:'...'}, so the caller that most needs
// to see the failure is the one that gets an exception instead of the body. That is
// why the wallet could sit on a job the LSP had already failed — every probe threw
// and was swallowed.
//
// Transport errors still throw; only a well-formed body with ok:false is returned
// as data, because for a status read that IS the answer.
export function seqlnJobStatusRaw(pathOrId) {
  const p = String(pathOrId || '');
  return lspFetch(p.startsWith('/') ? p : ('/swap/' + p), { allowNotOk: true });
}

// Is this job body one that is NO LONGER BEING DRIVEN? A dead job means the LSP is not
// commanding the maker any more, so a waiter must re-issue rather than keep waiting.
//
// Deliberately CONSERVATIVE about what counts as dead: a body we cannot read (null, a
// transport blip, an unknown status) is treated as ALIVE. Declaring a live job dead
// re-commands a maker that is already working; declaring a dead job alive only costs a
// 30s tick. The asymmetry favours not thrashing a healthy trade.
//
// Returns { dead, reason } — the reason is what makes a stall explicable to the user
// instead of an indefinite spinner.
export function jobIsDead(body) {
  if (!body || typeof body !== 'object') return { dead: false, reason: '' };
  const status = String(body.status || '');
  const dead = body.ok === false || status === 'failed' || status === 'interrupted' || !!body.interrupted;
  return { dead, reason: dead ? String(body.error || body.reason || status || '') : '' };
}

// "Move back to chain": cooperatively close a channel on the user's own hosted node and send the
// reclaimed funds to `destination` (the wallet's own on-chain address). The INVERSE of fundChannel.
// The device signer MUST be connected first (the keyless node's closing tx is device-signed), so the
// caller provisions/connects the node before calling this. Returns { closing_txid, type, destination }.
export function closeChannelLsp({ chain = 'seq', asset, node, scid, destination, unilateraltimeout } = {}) {
  return lspFetch('/channel/close', {
    method: 'POST',
    body: JSON.stringify({ chain, asset, node, scid, destination, unilateraltimeout }),
  });
}
// Take a cross-chain offer through the LSP: {side:'buy'|'sell', asset, amount,
// payRail?, recvRail?}. payRail/recvRail each 'ln' | 'chain':
//   • omitted / ln+ln -> pure-LN (both legs Lightning); the LSP drives BOTH legs and
//     each hosted node's device signer co-signs its commitment updates over its wss
//     link. Returns {preimage, base/quote amounts, finality:'final'}.
//   • mixed (one 'ln', one 'chain') -> a SUBMARINE swap (asset on-chain HTLC <-> BTC
//     over Lightning). Anchor-gated; returns finality:'confirming' (anchor-bound).
// Rails are only serialized when present, so the pure-LN call is byte-identical to
// before (the LSP treats a missing rail as ln/ln).
export function seqlnSwap({ side, asset, amount, take_atoms, quote_asset, payRail, recvRail, node_key, counter_node_key, btc_claim_pub, offer_id, maker_pubkey, swap_nonce, hodl, payment_hash, asset_amount, btc_htlc,
  // RAIL-BLIND BRIDGED TAKE (a genuine rail crossing): these fields route the take into the LSP's
  // non-custodial bridged driver (POST /swap with bridge:true). They were previously DROPPED by this
  // destructure, so a bridged take silently lost bridge:true + all its terms and was MISROUTED into the
  // custodial submarine path (a false-success fund hole). Forward every one of them (W3a).
  bridge, btc_node_key, maker_btc_rail, maker_asset_rail, btc_sats, asset_atoms,
  taker_asset_inbound, taker_btc_inbound, taker_seq_refund_pub,
  // PAYER LEG-BRIDGE (buy, pay BTC over LN, receive the asset on-chain). The taker
  // mints P and sends only H; the LSP fails closed without it, and the maker locks
  // the asset leg to taker_seq_claim_pub. Both were missing from this destructure,
  // so the wallet computed them, stored them, and then dropped them on the way out —
  // the LSP answered "payer bridge needs hash_h ... fail closed" and the take died
  // after the user had already confirmed it.
  hash_h, taker_seq_claim_pub,
  // WHICH RELAY HOLDS THE OFFER. The book merges four relays, but the LSP's bridge
  // lifted every offer against its cross relay — so any take on a submarine / sub-asset
  // / pure-LN offer answered "offer not found or not open". The LSP validates this
  // against its OWN configured relay list; it is a hint, never a URL to be trusted.
  relay_url,
  // Anything this function does not name is DROPPED. That has now caused the same
  // class of bug twice (bridge:true and its terms, then hash_h), so unknown keys are
  // surfaced rather than silently discarded — see the rest check below.
  ...rest }) {
  const body = { side, asset, amount };
  // A caller that sends a field this function has never heard of is almost always a
  // new protocol field that needs forwarding, not junk. Refusing to guess, but
  // refusing to hide it either.
  for (const k of Object.keys(rest || {})) {
    if (rest[k] !== undefined) console.warn('[lsp] seqlnSwap is dropping an unrecognised field:', k);
  }
  // asset<->asset pure-LN: the counter (quote) asset id. Omitted (or 'BTC') => the classic asset<->BTC
  // pure-LN, so the pure-LN body stays byte-identical to before for every existing asset<->BTC swap.
  if (quote_asset && String(quote_asset).toUpperCase() !== 'BTC') body.quote_asset = quote_asset;
  // Pure-LN PARTIAL FILL: the asset-side slice, in the asset's own atoms. The LSP
  // turns it into xpln's -take-asset-msat (atoms*1000); the BTC side is derived
  // from the signed offer's ratio, and the maker re-rests the remainder. Only
  // serialized when a partial was actually priced (> 0), so every whole-offer
  // body stays byte-identical to before.
  if (take_atoms != null && Number(take_atoms) > 0) body.take_atoms = Number(take_atoms);
  if (relay_url) body.relay_url = relay_url;
  if (payRail) body.payRail = payRail;
  if (recvRail) body.recvRail = recvRail;
  // Sub-asset SELL (pay asset over LN, receive BTC on-chain): the LSP drives the LN payment
  // from the user's OWN hosted node (`node_key`) and returns P + the BTC HTLC terms WITHOUT
  // claiming — the wallet then claims on-chain with the device key matching `btc_claim_pub`.
  if (node_key) body.node_key = node_key;
  // Pure-LN self-custody: the COUNTER (quote/BTC) leg's own user node. Nodes are keyed per-asset, so a
  // pure-LN swap runs on TWO of the user's own nodes — node_key (base asset) + counter_node_key (the quote
  // asset, or the user's BTC node for asset<->BTC). Only serialized when present, so every existing
  // asset<->BTC / sub-asset body that omits it stays byte-identical.
  if (counter_node_key) body.counter_node_key = counter_node_key;
  if (btc_claim_pub) body.btc_claim_pub = btc_claim_pub;
  // Forward the SPECIFIC reviewed offer so the LSP lifts THAT resting sell (its btc_sats is what
  // claimSell's economic gate checks) rather than an arbitrary one — matching Ambra's swapSub.
  if (offer_id) body.offer_id = offer_id;
  if (maker_pubkey) body.maker_pubkey = maker_pubkey;
  // Payer leg-bridge terms (see the destructure): H is what the LSP and the maker
  // bind to, and the asset leg is locked to the taker's own claim key.
  if (hash_h) body.hash_h = String(hash_h).toLowerCase();
  if (taker_seq_claim_pub) body.taker_seq_claim_pub = String(taker_seq_claim_pub).toLowerCase();
  // Sub-asset SELL idempotency key: the wallet persists it BEFORE this call and re-sends the SAME
  // value on a recovery re-call so the LSP returns the already-settled {preimage, btc_htlc} without
  // re-paying the asset. Only serialized when present, so the pure-LN body is byte-identical to before.
  if (swap_nonce) body.swap_nonce = swap_nonce;
  // Sub-asset BUY (pay BTC on-chain, receive asset over LN): the device funds a BTC HTLC + registers a
  // HODL invoice on H, then the LSP drives the maker's pay-by-hash. These MUST reach the LSP or its
  // /swap handler never takes the `hodl` BUY branch and falls through to pure-LN — silently breaking
  // the whole sub-asset buy. (They were dropped by this destructure.)
  if (hodl) body.hodl = hodl;
  if (payment_hash) body.payment_hash = payment_hash;
  if (asset_amount != null) body.asset_amount = asset_amount;
  if (btc_htlc) body.btc_htlc = btc_htlc;
  // Bridged take (W3a): forward the full bridged-take contract so the LSP enters the bridged branch and
  // binds every LSP front to the two legs' amounts. Only serialized when present, so every existing
  // pure-LN / sub-asset body stays byte-identical (no `bridge` field -> byte-for-byte the same as before).
  if (bridge) body.bridge = bridge;
  if (btc_node_key) body.btc_node_key = btc_node_key;
  if (maker_btc_rail) body.maker_btc_rail = maker_btc_rail;
  if (maker_asset_rail) body.maker_asset_rail = maker_asset_rail;
  if (btc_sats != null) body.btc_sats = btc_sats;
  if (asset_atoms != null) body.asset_atoms = asset_atoms;
  if (taker_asset_inbound != null) body.taker_asset_inbound = taker_asset_inbound;
  if (taker_btc_inbound != null) body.taker_btc_inbound = taker_btc_inbound;
  if (taker_seq_refund_pub) body.taker_seq_refund_pub = taker_seq_refund_pub;
  // The settle wait must OUTLAST a real settlement, not race it: live pure-LN swaps settle in
  // 85-100s wall-clock (two hold registrations + two pays through the hub), and the default 90s
  // lspFetch budget expired mid-settle on two consecutive live trades - the UI then declared
  // failure while both legs completed seconds later. The LSP keeps driving after the client
  // hangs up, so a short client budget here buys nothing and manufactures false failures.
  return lspFetch('/swap', { method: 'POST', body: JSON.stringify(body), timeoutMs: 8 * 60_000 });
}

// W2 FRONT-BEFORE-FUND — a bridged SELL (taker sells the asset, receives BTC over Lightning): AFTER the
// /swap handshake yields H (bridge_terms), the taker registers a hold on H at its OWN BTC-LN node and hands
// its recv_node_id here (hold-ready). The LSP fronts the hold as soon as the recoup is secured, STRICTLY
// BEFORE the taker exposes any asset. Poll GET /swap/<id> for status 'fronted', then fund + relay the asset.
// A declined/undriven front strands nothing — the taker has funded nothing yet.
// recv_min_final_cltv (blocks, optional) — the min-final-CLTV the taker needs the LSP's front HTLC to carry
// so it stays settleable until strictly after the maker's latest asset claim (T_seq). The LSP takes the MAX
// of this and its own handshake-sized value (the taker can only ask for MORE runway, never less).
export function seqlnBridgeFront({ job_id, recv_node_id, recv_min_final_cltv }) {
  return lspFetch('/bridge/front', { method: 'POST', body: JSON.stringify({ job_id, recv_node_id, recv_min_final_cltv }) });
}
// W2 FRONT-BEFORE-FUND — hand the FUNDED asset HTLC (taker self-custody: claim=maker-with-P, refund=taker-
// after-T_seq) to the LSP to relay to the maker. The LSP REJECTS this unless the front is already confirmed
// (status 'fronted'), so the taker never exposes its asset before it is guaranteed payment. Call ONLY after
// GET /swap/<id> shows status 'fronted' AND the taker's own hold on H is 'accepted'.
export function seqlnBridgeAsset({ job_id, taker_seq_leg, recv_node_id }) {
  return lspFetch('/bridge/asset', { method: 'POST', body: JSON.stringify({ job_id, taker_seq_leg, recv_node_id }) });
}
// LSP PAYER LEG-BRIDGE (rail-crossing BUY vs an on-chain-only maker): the INVERSE of /bridge/front. The taker
// mints H (holds P self-custody) and, after the /swap handshake secures the forward-maker terms, calls this so
// the LSP ISSUES a BTC-LN HOLD invoice on H at its OWN node. The taker pays it -> the payment lands HELD (not
// captured) at the LSP; only then does the LSP fund the on-chain BTC HTLC to the maker. Returns { node_id,
// payment_hash, bolt11, amount_msat, hold_min_final_cltv, hold_expiry_secs }. Idempotent (a re-post re-affirms
// the hold on H). Pay it setting the final-hop CLTV >= hold_min_final_cltv so the hold stays settleable past T_seq.
export function seqlnBridgeHold({ job_id }) {
  return lspFetch('/bridge/hold', { method: 'POST', body: JSON.stringify({ job_id }) });
}

// The sub-asset order book for an asset: { sell_available, buy_available, sell_offers[],
// buy_offers[] }. Drives DYNAMIC rail gating (light the toggle only when real resting
// counterparty liquidity exists — for ANY asset, no hardcoded maker list) and the book view.
export function seqlnBook(asset, quote) {
  // `quote` = a real Sequentia asset id for a mixed same-chain market (the on-chain
  // leg is that asset); omitted/'BTC' keeps the classic <asset>/BTC book unchanged.
  const q = quote && String(quote).toUpperCase() !== 'BTC' ? '&quote=' + encodeURIComponent(quote) : '';
  return lspFetch('/book?asset=' + encodeURIComponent(asset) + q);
}

// The UNIFIED order book for a BTC<->asset pair (Stage 2, rail-agnostic matching): ONE price-sorted
// book merging the on-chain cross relay + the sub-asset LN relays, rail as metadata. Returns
// { ok, asks[], bids[], best_ask, best_bid, counts } — each entry has { price, assetAtoms, btcSats,
// rail:'ln'|'onchain', id, raw }. The composer shows all resting liquidity and prices off the best,
// whichever rail carries it; the settlement router bridges the rails on take.
// The unified book for a pair. `quote` is a real Sequentia asset id for an
// asset<->asset market, or omitted/'BTC' for a BTC-paired one — the split that used
// to leave asset-paired markets with no unified book at all.
export function seqlnUnifiedBook(asset, quote) {
  const q = quote && String(quote).toUpperCase() !== 'BTC' ? '&quote=' + encodeURIComponent(quote) : '';
  return lspFetch('/book/unified?asset=' + encodeURIComponent(asset) + q);
}

// Post a resting sub-asset offer the wallet signed itself (the LSP never signs). `offer` is
// the signed Offer protojson. Returns { offer_id, status }.
export function seqlnPostOffer(offer) {
  return lspFetch('/offer', { method: 'POST', body: JSON.stringify({ offer }) });
}

// Just the channel list from /status (leg-tagged, per-asset spendable/receivable), for
// the Balance tab's in-channel ("Lightning") balance + the real channel count.
export async function seqlnChannels() {
  const st = await seqlnGetStatus();
  return st.channels || [];
}

// Which chains/assets the LSP can fund a channel for (Move to Lightning). SeqLN nodes
// are single-asset, so `assets` lists exactly the Sequentia assets that have a hosted
// node today (dynamic; grows as per-asset nodes are provisioned). `provisioning` is true
// when the LSP can spin up a node for ANY other asset (incl. a freshly-issued one) on
// demand. The Balance tab reads this to offer Move-to-Lightning per asset.
export async function seqlnFunding() {
  const st = await seqlnGetStatus();
  return st.funding || { btc: false, assets: [], provisioning: false };
}

// The provisioned per-asset hosted nodes (the dynamic "M" in "LN N/M"). Each is a
// single-asset keyless SeqLN node keyed to this device.
export async function seqlnNodes() {
  return (await lspFetch('/node/list')).nodes || [];
}

// Provision (or re-attach) a hosted SeqLN node for `asset`, keyed to THIS device. SeqLN
// nodes are single-asset, so moving a new asset into Lightning first needs its own node.
// `deviceTransportPubkey` is the device's per-node Noise static pubkey (seqln-keys.js);
// the node pins it so only this device can sign. Returns the node wiring the wallet then
// attaches its signer to (host_pubkey, public_ws_path) before funding a channel.
export function provisionNode({ asset, chain, deviceTransportPubkey, label }) {
  const body = { device_transport_pubkey: deviceTransportPubkey };
  // A per-USER BTC (testnet4) node is device-keyed (chain:'btc', NO asset id — the LSP
  // keys it by the device pubkey so a real wallet gets its OWN non-custodial BTC node).
  // A Sequentia asset node is asset-keyed. Only serialize `chain` for BTC so the seq
  // provision call is byte-identical to before.
  if (chain === 'btc') body.chain = 'btc';
  else body.asset = asset;
  if (label) body.label = label;
  return lspFetch('/node/provision', { method: 'POST', body: JSON.stringify(body) });
}

// Readiness of ONE provisioned node (by its registry key). A freshly-provisioned node boots
// + rescans, so its rpc is not answerable for the first seconds; the wallet polls this after
// provisionAndConnect (showing a "preparing your node…" progress) before it asks to fund a
// channel. Returns { ready, node_id, blockheight, synced }.
export function nodeGetinfo(nodeKey) {
  return lspFetch(`/node/getinfo?node=${encodeURIComponent(nodeKey)}`);
}

// Poll nodeGetinfo until the node's rpc answers (ready), emitting progress. Throws past the
// timeout with a clean message. This is what turns "still connecting" dead ends into an
// honest, bounded "preparing your node…" wait before funding.
export async function waitNodeReady({ nodeKey, onProgress, timeoutMs = 180_000, pollMs = 2500 } = {}) {
  if (!nodeKey) throw new Error('waitNodeReady: a node key is required');
  const emit = (extra) => { try { onProgress && onProgress({ phase: 'preparing', ...extra }); } catch {} };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let st = null;
    try { st = await nodeGetinfo(nodeKey); } catch { /* transient */ }
    if (st && st.ready) return st;
    emit({ ready: false });
    if (Date.now() > deadline) throw new Error('your Lightning node is still preparing (booting + syncing); try again in a moment');
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// -- "Move to Lightning": non-custodial channel funding --------------------------
// Move BTC (testnet4) or a Sequentia asset from on-chain into a Lightning channel on
// the user's hosted node. NON-CUSTODIAL: the wallet signs the on-chain deposit itself
// (via the `sendOnchain` hook the wallet supplies, so this module never depends on the
// wallet's signer), and the channel funding tx is co-signed by the on-device signer
// (the hosted node is keyless), so the LSP orchestrates fundchannel but cannot sign
// the funding transaction itself. The device signer for this chain's leg MUST be serving.
//
//   chain        'btc' | 'seq'
//   asset        (seq only) 'GOLD' or a 32-byte hex id — the asset to fund the channel with
//   amount       base units to move (BTC sats / asset atoms)
//   sendOnchain  async ({ chain, asset, amount, address }) => { txid } — the wallet's
//                own on-chain send to the hosted node's deposit address (it signs it)
//   onProgress   (evt) => void — { phase, ... }: 'deposit-address' | 'sending' | 'sent' |
//                'pending_deposit' | 'opening' | 'awaiting_lockin' | 'active' | 'failed'
// Resolves with the final active job ({ short_channel_id, spendable_msat, ... }).
// `node` is the LSP registry key of the user's OWN provisioned node (from
// provisionAndConnect). When present it is threaded into BOTH /channel/deposit and
// /channel/open so the deposit address AND the device-co-signed fundchannel target THAT
// node — NOT the shared demo node. Omitting it falls back to the LSP default (demo) node,
// so the wallet MUST pass it for a non-custodial per-user channel.
export async function fundChannel({ chain, asset, amount, node, sendOnchain, onProgress,
  pollMs = 5000, timeoutMs = 3_600_000 } = {}) {
  if (chain !== 'btc' && chain !== 'seq') throw new Error("fundChannel: chain must be 'btc' or 'seq'");
  if (typeof sendOnchain !== 'function') throw new Error('fundChannel: a sendOnchain hook is required (the wallet signs the deposit)');
  const emit = (phase, extra) => { try { onProgress && onProgress({ phase, ...extra }); } catch {} };

  // 1. The hosted node's on-chain deposit address for this chain (of the user's own node).
  emit('deposit-address');
  const depQ = `/channel/deposit?chain=${encodeURIComponent(chain)}`
    + (asset ? `&asset=${encodeURIComponent(asset)}` : '')
    + (node ? `&node=${encodeURIComponent(node)}` : '');
  const dep = await lspFetch(depQ);
  if (!dep.address) throw new Error('LSP returned no deposit address');

  // 2. The WALLET sends the deposit on-chain (it signs it — the LSP never holds the key).
  emit('sending', { address: dep.address });
  const sent = await sendOnchain({ chain, asset, amount, address: dep.address });
  emit('sent', { address: dep.address, deposit_txid: sent && sent.txid });

  // 3. Tell the LSP to watch for the deposit + fundchannel (device co-signs the funding).
  emit('opening-request');
  const body = { chain, amount };
  if (asset) body.asset = asset;
  if (node) body.node = node;               // route the fundchannel to the user's OWN node
  const started = await lspFetch('/channel/open', { method: 'POST', body: JSON.stringify(body) });
  const jobUrl = started.poll || `/channel/open/${started.job_id}`;

  // 4. Poll to completion, surfacing each phase for the UI. The channel-open runs SERVER-SIDE, so a
  // transient network blip on the poll (the "failed to fetch" that used to kill the whole move) must
  // NOT abandon it — retry a bounded number of times, and only then surface a RESUMABLE error (the
  // job keeps running; reopening the wallet re-polls it). This is what makes a flaky connection
  // survivable instead of stranding a deposit.
  const deadline = Date.now() + timeoutMs;
  let job = started, pollErrors = 0;
  const maxPollErrors = 24;   // 24 * pollMs (~2 min at 5s) of transient tolerance before giving up
  for (;;) {
    emit(job.status, { job, deposit_txid: sent && sent.txid });
    if (job.status === 'active') return job;
    if (job.status === 'failed') throw new Error(job.error || 'channel open failed');
    if (Date.now() > deadline) throw new Error('channel open timed out');
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      job = await lspFetch(jobUrl);
      pollErrors = 0;
    } catch (e) {
      if (++pollErrors > maxPollErrors) {
        const err = new Error('Lost connection while opening the channel. It may still be completing on the server — reopen the wallet to resume.');
        err.resumable = true; err.jobUrl = jobUrl; err.cause = e;
        throw err;
      }
      emit('reconnecting', { attempt: pollErrors, of: maxPollErrors });
      // keep `job` as-is (last known status) and loop; the next poll retries the same jobUrl.
    }
  }
}

// A channel (Sequentia or BTC) funded by ONE transaction of the wallet's own: no deposit to the node, one
// fee, one confirmation (tooling/lsp/external-funding.mjs has the protocol). The LSP starts the
// channel and names its funding address; `fund` is the wallet's side, and is handed `complete`:
//
//   fund({ chain, address, script, amount, asset, complete, onBroadcast }) -> { txid }
//     builds and blinds the transaction paying exactly `amount` of `asset` to `address`, in the
//     clear, checks it, and hands it UNSIGNED to `complete(psbtBase64)`, which answers the funding
//     txid once the peer has signed the first commitment, the way back. Only then does it sign,
//     check the signed transaction has that txid, call `onBroadcast()` and broadcast.
//
// Anything failing before `onBroadcast` cancels the channel, and no coin has moved. After it, the
// channel is never cancelled here: its coins may already be in the 2-of-2, which only this
// channel's commitments spend. An LSP without the endpoints throws with `unsupported` set, for the
// caller to fund through the deposit (fundChannel).
export async function fundChannelDirect({ chain = 'seq', asset, amount, node, fund, onProgress, pollMs = 5000, timeoutMs = 3_600_000 } = {}) {
  if (typeof fund !== 'function') throw new Error('fundChannelDirect: a fund hook is required (the wallet builds and signs the funding)');
  const emit = (phase, extra) => { try { onProgress && onProgress({ phase, ...extra }); } catch {} };
  emit('starting');
  let started;
  try {
    started = await lspFetch('/channel/start', { method: 'POST', timeoutMs: 300_000,
      body: JSON.stringify({ chain, asset, amount, node }) });
  } catch (e) {
    if (e && e.status === 404) {
      const u = new Error('this Lightning service funds channels only through a deposit');
      u.unsupported = true;
      throw u;
    }
    throw e;
  }
  if (!started.funding_address || !started.script) throw new Error('the Lightning service named no funding address');
  const jobId = started.job_id;
  let broadcast = false;
  let sent;
  try {
    sent = await fund({ chain, address: started.funding_address, script: started.script, amount, asset,
      complete: async (psbt) => {
        emit('completing');
        const done = await lspFetch('/channel/complete', { method: 'POST', timeoutMs: 180_000,
          body: JSON.stringify({ job_id: jobId, psbt }) });
        if (!/^[0-9a-f]{64}$/i.test(done.funding_txid || '')) throw new Error('the Lightning service named no funding txid');
        return String(done.funding_txid).toLowerCase();
      },
      onBroadcast: () => { broadcast = true; emit('broadcasting'); } });
  } catch (e) {
    if (!broadcast) {
      await lspFetch('/channel/cancel', { method: 'POST', body: JSON.stringify({ job_id: jobId }) })
        .catch((c) => console.warn('[ln] channel cancel:', c && c.message));
    }
    throw e;
  }
  emit('sent', { funding_txid: sent && sent.txid });
  const jobUrl = started.poll || `/channel/open/${jobId}`;
  const deadline = Date.now() + timeoutMs;
  let job = { status: 'awaiting_lockin' }, pollErrors = 0;
  const maxPollErrors = 24;
  for (;;) {
    emit(job.status, { job, funding_txid: sent && sent.txid });
    if (job.status === 'active') return job;
    if (job.status === 'failed') throw new Error(job.error || 'channel open failed');
    if (Date.now() > deadline) throw new Error('channel open timed out');
    await new Promise((r) => setTimeout(r, pollMs));
    try { job = await lspFetch(jobUrl); pollErrors = 0; }
    catch (e) {
      if (++pollErrors > maxPollErrors) {
        const err = new Error('Lost connection while the channel confirms. Its funding is on chain; reopen the wallet to see it open.');
        err.resumable = true; err.jobUrl = jobUrl; err.cause = e;
        throw err;
      }
      emit('reconnecting', { attempt: pollErrors, of: maxPollErrors });
    }
  }
}

// Resume a channel-open WITHOUT re-depositing: the deposit already landed on the node, so just
// (re)start the LSP's fundchannel-from-existing-balance job and poll it to completion. Used to
// recover a move that was interrupted after the deposit but before the channel opened (the
// "stranded deposit" case) — the funds are on the user's own node, this finishes moving them.
// `consolidate`: the node's coins move to its own address first (they may include what a
// channel's close paid it, which its device sends only to its own scripts).
export async function resumeFundChannel({ chain, asset, amount, node, consolidate = false, onProgress, pollMs = 5000, timeoutMs = 3_600_000 } = {}) {
  const emit = (phase, extra) => { try { onProgress && onProgress({ phase, ...extra }); } catch {} };
  emit('opening-request');
  const body = { chain, amount };
  if (asset) body.asset = asset;
  if (node) body.node = node;
  if (consolidate) body.consolidate = true;
  const started = await lspFetch('/channel/open', { method: 'POST', body: JSON.stringify(body) });
  const jobUrl = started.poll || `/channel/open/${started.job_id}`;
  const deadline = Date.now() + timeoutMs;
  let job = started, pollErrors = 0;
  const maxPollErrors = 24;
  for (;;) {
    emit(job.status, { job });
    if (job.status === 'active') return job;
    if (job.status === 'failed') throw new Error(job.error || 'channel open failed');
    if (Date.now() > deadline) throw new Error('channel open timed out');
    await new Promise((r) => setTimeout(r, pollMs));
    try { job = await lspFetch(jobUrl); pollErrors = 0; }
    catch (e) { if (++pollErrors > maxPollErrors) throw e; emit('reconnecting', { attempt: pollErrors, of: maxPollErrors }); }
  }
}

export default {
  initSeqln, seqlnConfigured, seqlnDeployed, seqlnState, onSeqlnStatus, seqlnAvailable,
  lnFinalityCopy, connectDevice, disconnectDevice, seqlnGetStatus, seqlnSwap,
  seqlnChannels, seqlnFunding, seqlnNodes, provisionNode, fundChannel, fundChannelDirect,
  deviceTransportPubkey, connectProvisioned, provisionAndConnect, provisionedState, disconnectProvisioned,
  nodeGetinfo, waitNodeReady,
};
