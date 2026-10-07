// SEQUENTIA staking pools, from the extension.
//
// What this offers is DELEGATION only: lend the stake weight this wallet's
// staking key already carries to a pool, move it between pools, and take it
// back. It does not offer staking itself, and it does not offer running a pool.
//
// The line is not arbitrary. Registering a stake locks coins for an unbonding
// period, and announcing a payout policy binds every block a key ever produces
// and needs that key online on the machine producing them; neither belongs to a
// browser popup that is closed most of the time. Delegating asks nothing of the
// device afterwards: the record sits on-chain lending weight whether or not this
// extension is ever opened again.
//
// The safety properties that make that reasonable, all enforced by the chain:
//   * the pool's key appears nowhere in the staking output's spending
//     condition, so a pool can never spend a delegator's coins;
//   * delegating moves no staked coins at all, and neither does leaving: the
//     record is a separate small output (RECORD_ATOMS) that comes back, less
//     the fees of the transactions that spent it, on leaving;
//   * only this wallet's staking key can spend the delegation record, so
//     leaving needs nobody's cooperation and has no notice period.
//
// The network accepts a delegation record only from a transaction that spends
// a coin of its controller, the wallet's staking key (m/2/0), and every spend
// of a record carries the signature the chain wants at the block it enters.
// Joining is therefore two transactions, mined together: an ordinary wallet
// payment to the staking key's P2WPKH (the authorization), then the record,
// funded by that coin alone.
//
// Because of that last one, "leave" must always work. This module therefore
// never gates leaving on the pool board being reachable, and reports its own
// unavailability rather than silently disabling the button.

import * as lwk from '../pkg/lwk_wasm.js';
import { btc } from '../vendor/btc.js';
import { BASE, ESPLORA, RECORDS_V2_HEIGHT } from './config.js';
import {
  getSigner, getWollet, getMnemonic, getNetwork, getPolicyHex, withWollet, signPset, broadcastRaw,
} from './engine.js';
// Kept in its own module, free of the wasm engine, so the copy that IS the
// delegator's protection can be unit-tested.
export { delegationWarnings as warnings } from './staking-warnings.js';

export const POOLS_URL = BASE + '/pools/pools.json';

/// The record's own value: enough to clear the relay floor and to pay the fee
/// each time it is spent, with room for several moves between pools. All of it
/// comes back when the delegation is reclaimed.
const RECORD_ATOMS = 100000n;   // 0.001 tSEQ

/// Both record transactions have a fixed shape, priced at the rate the rest of
/// the wallet uses. A spend is one bare input, one output and the fee output;
/// creating a record is one P2WPKH input, the record and the fee output.
/// Measured sizes are in test/regtest/stake-records.mjs, which fails if a
/// transaction outgrows its allowance.
export const SPEND_VBYTES = 300n;
export const CREATE_VBYTES = 260n;
const FEE_RATE_SAT_KVB = 2000n;
const feeFor = (vbytes) => (vbytes * FEE_RATE_SAT_KVB + 999n) / 1000n;
const spendFee = () => feeFor(SPEND_VBYTES);
export const createFee = () => feeFor(CREATE_VBYTES);

/// A record spend signed for the next block is refused from the block where
/// the network changes how records are signed, and a node evicts it from its
/// mempool there. Unless the spend has the next block and this many after it to
/// confirm in before the change, it is not built at all.
const SIGNING_MARGIN = 3;

/// Whether the vendored wasm build can create a record the way the network
/// requires and SPEND one. Shipping "join a pool" without "leave a pool" would
/// be a one-way door, so the whole feature reports itself unavailable rather
/// than offering half of it.
export function supported() {
  return typeof lwk.findDelegationRecords === 'function'
      && typeof lwk.buildDelegationSpendTx === 'function'
      && typeof lwk.buildDelegationCreateTx === 'function'
      && typeof lwk.stakeRecordSigning === 'function'
      && typeof lwk.TxBuilder === 'function'
      && typeof lwk.TxBuilder.prototype.addRecordAuthorization === 'function';
}

const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/// The scriptPubKey of the staking key's P2WPKH: where the authorization pays,
/// and the coin a record is created from.
export function stakerScript(controller) {
  const bytes = Uint8Array.from(controller.match(/../g).map((b) => parseInt(b, 16)));
  return hexOf(btc.p2wpkh(bytes).script);
}

/// The public pool board's feed. Read-only and advisory: everything here is
/// about CHOOSING a pool, never about leaving one.
export async function fetchPools() {
  const r = await fetch(POOLS_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error('pool board returned ' + r.status);
  const j = await r.json();
  if (!j || !Array.isArray(j.pools)) throw new Error('unexpected pool board response');
  return j;
}

/// Signers worth probing for a record of ours, beyond whatever the wallet's own
/// history turns up: every pool on the board, plus any signer this device has
/// delegated to before.
///
/// The remembered set is a HINT, never a source of truth. It exists because a
/// pool that commands no weight and has announced no policy does not appear on
/// the board at all, and a wallet that pasted such a key would otherwise have no
/// way to name it again.
const HINT_KEY = 'seq.staking.signerHints';

async function loadHints() {
  try { return (await chrome.storage.local.get(HINT_KEY))[HINT_KEY] || []; }
  catch { return []; }
}

async function rememberSigner(signer) {
  try {
    const seen = await loadHints();
    if (seen.includes(signer)) return;
    // Bounded: this is a lookup hint, not a history.
    await chrome.storage.local.set({ [HINT_KEY]: [signer, ...seen].slice(0, 20) });
  } catch { /* a hint that cannot be stored simply is not used */ }
}

/// Two groups, tried in order: the signers this device has used, then the rest
/// of the board.
///
/// The first group is one or two keys and hits immediately in the ordinary case,
/// where the whole sweep would cost one request per pool on every refresh. The
/// second exists for the case the first cannot cover: a seed restored onto a
/// device that remembers nothing.
async function probeGroups(board) {
  const hints = await loadHints();
  const seen = new Set(hints);
  const rest = [];
  for (const p of (board && board.pools) || []) {
    if (!seen.has(p.signer)) { seen.add(p.signer); rest.push(p.signer); }
  }
  return [hints, rest];
}

/// The Electrum-style scripthash this explorer indexes by.
///
/// It is the FORWARD sha256 of the scriptPubKey, verified against the deployed
/// esplora rather than assumed: the reversed form is the more common convention
/// and returns an empty list here, which would look exactly like "you are not
/// delegating" -- the worst possible wrong answer for a feature whose whole
/// promise is that you can always leave.
async function scriptHash(scriptHex) {
  const bytes = Uint8Array.from(scriptHex.match(/../g).map((b) => parseInt(b, 16)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/// Records naming `controller` in transactions that spend a coin of the
/// staking key's P2WPKH, from that script's history on the explorer, newest
/// first. The explorer pages confirmed history 25 at a time; the walk is
/// bounded, and the newest pages are the ones that matter.
const HISTORY_PAGES = 40;
async function recordsFromStakerScript(controller) {
  const found = [];
  let spk;
  try { spk = stakerScript(controller); } catch { return found; }
  let url = `${ESPLORA}/scripthash/${await scriptHash(spk)}/txs`;
  const h = url.slice(0, -'/txs'.length);
  for (let page = 0; page < HISTORY_PAGES && url; page++) {
    let txs;
    try {
      const r = await fetch(url);
      if (!r.ok) break;
      txs = await r.json();
    } catch { break; }
    if (!Array.isArray(txs) || !txs.length) break;
    for (const t of txs) {
      const spends = (t.vin || []).some((i) => i && i.prevout && i.prevout.scriptpubkey === spk);
      if (!spends) continue;
      (t.vout || []).forEach((o, vout) => {
        let parsed = null;
        try { parsed = lwk.parseDelegationScript(o.scriptpubkey || ''); } catch {}
        if (!parsed || parsed.controller !== controller || o.value == null) return;
        found.push({ txid: t.txid, vout, signer: parsed.signer, atoms: BigInt(o.value),
                     height: t.status && t.status.confirmed ? t.status.block_height : null,
                     fromHistory: true });
      });
    }
    const confirmed = txs.filter((t) => t.status && t.status.confirmed);
    url = confirmed.length >= 25 ? `${h}/txs/chain/${confirmed[confirmed.length - 1].txid}` : null;
  }
  return found;
}

/// This wallet's live delegation record, or null.
///
/// Three ways of looking, because no one of them is enough:
///
///  * the history of the staking key's P2WPKH finds the record a JOIN created:
///    that transaction spends the authorization coin at that script and
///    nothing of the wallet's, so the wallet's own scan never downloads it;
///  * the wallet's own history finds a record funded straight from its coins,
///    which is how records were created before the network required the
///    controller's coin;
///  * asking the explorer for unspent outputs at the record script for each
///    candidate signer finds one created by a MOVE (which spends only the old
///    bare record and pays only the new one), and survives a restore onto a
///    device that has never seen any of this.
///
/// The record is a bare script, so the wallet cannot answer any of these by
/// itself.
export async function findDelegation(board) {
  if (!supported()) return null;
  const controller = getSigner().stakerPublicKey();
  const byOutpoint = new Map();
  const key = (c) => `${c.txid}:${c.vout}`;

  // 1) What a join created: a transaction spending a coin of the staking
  //    key's P2WPKH. Only those are read; the same script also receives
  //    payouts, and they create no record.
  for (const c of await recordsFromStakerScript(controller)) byOutpoint.set(key(c), c);

  // 2) What this wallet funded itself.
  try {
    for (const wtx of getWollet().transactions()) {
      let hex;
      try { hex = wtx.tx().toString(); } catch { continue; }
      let found;
      try { found = lwk.findDelegationRecords(hex, controller); } catch { continue; }
      for (const f of found || []) {
        const c = { txid: wtx.txid().toString(), vout: f.vout, signer: f.signer,
                    atoms: BigInt(f.value), height: wtx.height(), fromHistory: true };
        byOutpoint.set(key(c), c);
      }
    }
  } catch { /* an unreadable history must not stop the explorer probe */ }

  // 3) What is out there under our controller, whoever created it. These come
  //    back already filtered to UNSPENT, which is the question that matters.
  //    The second group is only swept when the first found nothing, so the
  //    ordinary case costs one request rather than one per pool.
  let probed = 0;
  for (const group of await probeGroups(board)) {
    // Skip the wider sweep only when an EARLIER PROBE found something. Keying
    // this off byOutpoint would skip it whenever the history pass found the
    // record this wallet funded -- exactly the record a later move has spent.
    if (probed) break;
    for (const signer of group) {
      let spk;
      try { spk = lwk.sequentiaDelegationScript(controller, signer); } catch { continue; }
      try {
        const h = await scriptHash(spk);
        const r = await fetch(`${ESPLORA}/scripthash/${h}/utxo`);
        if (!r.ok) continue;
        for (const u of await r.json()) {
          const c = { txid: u.txid, vout: u.vout, signer, atoms: BigInt(u.value),
                      height: u.status && u.status.confirmed ? u.status.block_height : null,
                      unspent: true };
          byOutpoint.set(key(c), c);
          probed++;
        }
      } catch { /* transient: the other signers still get their turn */ }
    }
  }

  const candidates = [...byOutpoint.values()];
  if (!candidates.length) return null;
  // Unconfirmed first (it is the most recent thing that happened), then by
  // height descending: a move spends the old record and creates a new one, so
  // the most recent unspent record is the one in force.
  candidates.sort((a, b) => {
    const au = a.height == null, bu = b.height == null;
    if (au !== bu) return au ? -1 : 1;
    if (au) return 0;
    return b.height - a.height;
  });
  for (const c of candidates) {
    try {
      if (!c.unspent) {
        const r = await fetch(`${ESPLORA}/tx/${c.txid}/outspend/${c.vout}`);
        if (!r.ok) continue;
        if ((await r.json())?.spent) continue;   // superseded, or already reclaimed
      }
      if (c.height == null) {
        const st = await fetch(`${ESPLORA}/tx/${c.txid}/status`);
        c.confirmed = st.ok ? !!(await st.json()).confirmed : false;
      } else {
        c.confirmed = true;
      }
      return c;
    } catch { /* transient: try the next candidate */ }
  }
  return null;
}

/// The chain tip. A record spend is signed for the block after it, and every
/// transaction here uses it as nLockTime (anti fee-sniping). 0 means unknown:
/// a record spend refuses to be built on it.
async function tipHeight() {
  try {
    const r = await fetch(`${ESPLORA}/blocks/tip/height`);
    if (r.ok) {
      const h = parseInt((await r.text()).trim(), 10);
      if (Number.isFinite(h) && h >= 0) return h;
    }
  } catch {}
  return 0;
}

function requireSupport() {
  if (!supported()) {
    throw new Error('this build cannot spend a delegation record, so it will not create one either; update the extension');
  }
}

function checkSigner(signerPubkey) {
  const target = String(signerPubkey || '').trim().toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(target)) throw new Error('a pool signer key is 66 hex characters');
  return target;
}

/// A transaction of this wallet's history, as hex. A broadcast applies the
/// transaction to the wallet at once; the explorer is the fallback.
async function ownTxHex(txid) {
  const hex = await withWollet(async () => {
    for (const wtx of getWollet().transactions()) {
      if (wtx.txid().toString() === txid) return wtx.tx().toString();
    }
    return null;
  });
  if (hex) return hex;
  const r = await fetch(`${ESPLORA}/tx/${txid}/hex`);
  if (!r.ok) throw new Error('could not read transaction ' + txid);
  return (await r.text()).trim();
}

/// An authorization this wallet paid that no record has spent yet: what is
/// left when a join's second transaction was refused. Joining again reuses it
/// rather than paying the staking key a second time. Only a coin of exactly
/// the amount a join pays, in a transaction this wallet sent, counts: the same
/// script receives payouts, and those are not this wallet's to put in a record.
async function unspentAuthorization(controller, atoms) {
  let utxos;
  try {
    const r = await fetch(`${ESPLORA}/scripthash/${await scriptHash(stakerScript(controller))}/utxo`);
    if (!r.ok) return null;
    utxos = await r.json();
  } catch { return null; }
  const policy = getPolicyHex();
  for (const u of utxos || []) {
    if (u.value == null || BigInt(u.value) !== atoms) continue;
    if (u.asset && u.asset !== policy) continue;
    const sent = await withWollet(async () => {
      for (const wtx of getWollet().transactions()) {
        if (wtx.txid().toString() === u.txid) return wtx.txType() === 'outgoing';
      }
      return false;
    });
    if (!sent) continue;
    try { return { txid: u.txid, vout: u.vout, hex: await ownTxHex(u.txid) }; } catch {}
  }
  return null;
}

/// Join a pool: pay the staking key's P2WPKH the record's value and the
/// second transaction's fee (an ordinary wallet payment), then create the
/// record from that coin alone. Both are broadcast at once and mined together.
/// Returns `{ txid, authorizationTxid, recordAtoms }`, amounts as strings.
export async function delegate(signerPubkey) {
  requireSupport();
  const controller = getSigner().stakerPublicKey();
  const target = checkSigner(signerPubkey);
  if (target === controller) {
    throw new Error('that is this wallet\'s own staking key; delegating to yourself is what already happens with no pool at all');
  }
  await rememberSigner(target);
  const fee = createFee();
  const coinAtoms = RECORD_ATOMS + fee;

  let coin = await unspentAuthorization(controller, coinAtoms);
  if (!coin) {
    const pset = await withWollet(async () => getNetwork().txBuilder()
      .addRecordAuthorization(controller, coinAtoms)
      .feeRate(Number(FEE_RATE_SAT_KVB))
      .finish(getWollet())
      .toString());
    const { txid } = await broadcastRaw({ psetB64: await signPset(pset) });
    coin = { txid, vout: undefined, hex: await ownTxHex(txid) };
  }

  const built = lwk.buildDelegationCreateTx({
    mnemonic: getMnemonic(),
    coinTxHex: coin.hex,
    coinVout: coin.vout,
    signer: target,
    recordValue: RECORD_ATOMS.toString(),
    feeAtoms: fee.toString(),
    locktime: await tipHeight(),
  }, getNetwork());
  try {
    const { txid } = await broadcastRaw({ hex: built.rawHex });
    return { txid, authorizationTxid: coin.txid, recordAtoms: built.recordValue };
  } catch (e) {
    throw new Error(`the payment to this wallet's staking key went through (${coin.txid}) but the record was refused: `
      + `${(e && e.message) ?? e}. Delegating again reuses that payment.`);
  }
}

/// Move to another pool, or leave. `rotateTo` null means leave.
///
/// Moving spends the old record and creates the new one in ONE transaction:
/// consensus permits at most one live record per staking key, so leaving and
/// re-joining as two loose transactions could be mined in the order that leaves
/// two live records, which invalidates the block carrying the second.
///
/// The spend is signed for the block after the tip, the way the network signs
/// stake records there; without a tip it is not built at all.
export async function buildSpend(record, rotateTo) {
  requireSupport();
  if (!record) throw new Error('this wallet is not delegating');
  if (!record.confirmed) throw new Error('the last delegation change has not confirmed yet; wait for it');
  const target = rotateTo ? checkSigner(rotateTo) : null;
  if (target && target === record.signer) throw new Error('you are already delegating to that pool');

  const tip = await tipHeight();
  if (!tip) throw new Error('could not read the chain height, which decides how this must be signed; try again');
  const network = getNetwork();
  const v2 = RECORDS_V2_HEIGHT ?? undefined;
  const signing = lwk.stakeRecordSigning(network, tip, v2);
  for (let k = 1; k <= SIGNING_MARGIN; k++) {
    if (lwk.stakeRecordSigning(network, tip + k, v2) !== signing) {
      const change = tip + k + 1;   // the first block signed the other way
      throw new Error(`block ${change} changes how the network signs stake records, and a spend signed now `
        + `could miss the blocks before it; try again once block ${change - 1} is mined`);
    }
  }

  // Leaving needs somewhere to put the record's coins: a fresh address of this
  // wallet, unblinded, because the record spend creates an explicit output.
  const reclaim = target ? undefined
    : getWollet().address(undefined).address().toUnconfidential().toString();
  if (target) await rememberSigner(target);
  const built = lwk.buildDelegationSpendTx({
    mnemonic: getMnemonic(),
    recordTxid: record.txid,
    recordVout: record.vout,
    recordValue: record.atoms.toString(),
    currentSigner: record.signer,
    rotateTo: target || undefined,
    reclaimAddress: reclaim,
    feeAtoms: spendFee().toString(),
    locktime: tip,
    tipHeight: tip,
    recordsV2Height: v2,
  }, network);
  if (built.signing !== signing) {
    throw new Error(`the kit signed this spend "${built.signing}" where block ${tip + 1} needs "${signing}"; not broadcasting it`);
  }
  return built;   // { rawHex, txid, outValue, repointed, signing }
}
