// LIGHTNING TO THE ARK, in the service worker: a wallet made before default mode held its coins in
// the Ark keeps balances in its own Lightning channels; in default mode they move by themselves,
// the BTC channel paying an invoice of the wallet's own Bitcoin ark (offscreen-ark.js), each asset
// channel a Lightning receive of its leaf wallet (offscreen-leaves.js), while the figure stays whole
// and says "Moving <amount> <TICKER> so it can be sent in seconds." The move itself, its limits and
// its words are the web wallet's (vendor/lightning-to-ark.js, copied unchanged); this module gives it
// the extension's channels, nodes, ark and leaf wallet. The service worker runs it on the
// `leafHost` alarm; what is on its way is kept in storage, so a worker that slept carries it on.

import { mountLightningToArk, allowanceAtoms, CLOSE_UNILATERAL_S } from '../vendor/lightning-to-ark.js';
import * as ln from './ln.js';
import * as leaves from './leaves.js';
import * as dm from './default-mode.js';
import * as A from './assets.js';
import * as engine from './engine.js';
import { mode, walletTag } from './mode.js';
import { sessionMnemonic } from './vault.js';

const SIGNER_DEFAULT_ATOMS = 10_000_000n;

// The tag the move keys its record by, read before each pass (the shim's storage is synchronous).
let tagNow = 'default';
// When a person last asked the wallet for something (a popup or a site): the move waits twenty
// seconds after it.
let personAt = 0;
export function notePerson() { personAt = Date.now(); }

// What closing a channel of `kind` costs this side, as an estimate: a cooperative close of about
// 200 vB at 2 reference atoms a vByte, in the channel's own atoms (the web wallet's estimate).
function closeFee(kind) {
  if (kind === 'BTC') return 400n;
  const e = A.feeRateEntry(kind), r = e && e.rate;
  if (!(r > 0)) return null;
  return (400n * 100_000_000n + BigInt(r) - 1n) / BigInt(r);
}
const move = mountLightningToArk({
  dev: async () => (await mode()) === 'developer',
  personBusy: () => Date.now() - personAt < 20_000,
  channels: () => ln.ownChannels(),
  kindOf: (c) => ln.channelKind(c),
  refreshChannels: async () => { await ln.refreshStatus(); },
  connect: (kind) => ln.readyNode(kind),
  pay: (p) => ln.nodePay(p),
  payStatus: (p) => ln.nodePayStatus(p),
  ark: {
    isOpen: () => dm.arkIsOpen(),
    invoice: (sats, description) => dm.arkInvoice(sats, description),
    received: (hash) => dm.invoiceReceived(hash),
    refresh: async () => {},
  },
  leaves: {
    isOpen: async () => { try { return !!(await leaves.status()).open; } catch { return false; } },
    info: () => leaves.runAny('info'),
    coins: () => leaves.runAny('coins'),
    run: (command, args) => leaves.runAny(command, args),
  },
  // The extension sets no Lightning payment limit, so its signer's own default holds every
  // payment: 10,000,000 atoms of each asset a day (vendor/lightning/seqln-signer-sdk.js).
  allowance: async (kind) => allowanceAtoms({ default: SIGNER_DEFAULT_ATOMS }, kind),
  closeFee: async (kind) => closeFee(kind),
  close: ({ kind, channel }) => ln.closeToWallet({ kind, scid: channel.short_channel_id, node_key: channel.node_key, unilateraltimeout: CLOSE_UNILATERAL_S }),
  // What a close of an emptied asset channel pays stays in the figure until the wallet holds the
  // close's transaction; a BTC close is not held (its scan is not this worker's to ask).
  seen: async (kind, txid) => kind === 'BTC' || engine.hasSeqTx(txid),
  seenNow: (kind, txid) => (kind === 'BTC' ? true : engine.hasSeqTx(txid)),
  store: localStorage, tag: () => tagNow,
  log: (...a) => console.log(...a),
});

// One pass of both moves, while the wallet is unlocked and in default mode.
export async function tick() {
  if (!(await sessionMnemonic())) return;
  if ((await mode()) !== 'user') return;
  tagNow = (await walletTag()) || 'default';
  try { await ln.refreshStatus(); } catch {}
  await Promise.allSettled([move.tick(), move.tickAssets()]);
}

// For the overview: the channels' part of `kind`'s figure, `read` as last read; what is moving.
export function channelPart(kind, read) { return move.channelPart(kind, read); }
export function moving(kind) { return move.moving(kind); }
export function ownHashes() { return move.ownHashes(); }
export function setTag(t) { if (t) tagNow = t; }
