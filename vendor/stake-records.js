// STAKE RECORDS: joining, moving and leaving a staking pool, and unbonding a
// stake, as the chain accepts them.
//
// Every one of these is a transaction over a bare script of the wallet's
// staking key (m/2/0, `Signer.stakerPublicKey()`): the delegation record, the
// staking output and the unbonding output. The wallet's PSET signer does not
// touch them; SWK builds and signs them (`buildDelegationCreateTx`,
// `buildDelegationSpendTx`, `buildUnbondTx`, `buildUnbondClaimTx`). Two rules
// of the chain shape everything here:
//
//  * A delegation record is created by a transaction that spends a coin of its
//    controller. The wallet first pays its own staking key's P2WPKH the
//    record's value and fee (`TxBuilder.addRecordAuthorization`), and the
//    record's transaction spends that coin. Both are broadcast together and
//    mined together. A record paid for by ordinary wallet coins is refused.
//  * A spend of a stake record is signed for the block it will enter, which
//    the chain decides by height (`pos_records_v2_height` in the node's
//    chainparams). So every spend is built against the chain tip, and a spend
//    built without a tip is refused here rather than signed the wrong way.
//
// Since the record's transaction spends the staking key's coin and not the
// wallet's, the wallet's own history never contains it. Records are found
// through the staking key's P2WPKH history, through the explorer's unspent
// outputs at the record script for every known pool, through the join this
// browser has in flight, and, for a record paid for by wallet coins before the
// chain required the staking key's coin, through the wallet's own history.
//
// Everything is injected, so the same code runs in the page and under Node
// against a regtest node (tooling/stake-records-regtest.mjs).
//
// ctx:
//   lwk                 the SWK wasm bindings
//   network             the lwk Network
//   mnemonic()          the seed; throws when the wallet has none
//   stakerPublicKey()   33-byte hex, m/2/0
//   stakerScript()      hex of the P2WPKH of that key
//   esplora(path)       GET on the explorer API, a fetch Response
//   broadcast(hex)      -> txid; throws with the node's reason on refusal
//   signAuthorization(pubkey, atoms)
//                       -> { hex, txid }: the wallet's own PSET paying `atoms`
//                          of the Sequence token to the key's P2WPKH, signed
//                          and finalized, NOT broadcast
//   tipHeight()         -> the chain tip, 0 when it cannot be read
//   recordsV2Height     the height record spends sign the second-generation way
//                       from (undefined: SWK's value for the network)
//   feeRate             atoms of the Sequence token per 1000 vbytes
//   walletTxs()         -> [{ txid, hex, height }] the wallet's own transactions
//   hints()             -> groups of pool signer keys worth probing for a
//                          record, tried in order: [[...], [...]]
//   anchorHeightOf(blockHash)  -> the Bitcoin height a Sequentia block anchors to, or null
//   spendAnchorHeight() -> the anchor a claim broadcast now is judged against:
//                          the Bitcoin anchor of the chain tip (the node's
//                          PosUnbondingFailsNextBlock), or null
//   unbondDepth         Bitcoin blocks an unbonding output waits before its claim
//   store               localStorage-alike
//   stakesKey           the store key of the wallet's bonded stakes
//   now()               optional clock

export const PENDING_JOIN_KEY = 'swk.sequentia.pendingDelegation';

// The record's own value. It has to clear the dust floor and then pay the fee
// each time it is re-pointed, so it is sized for a handful of moves rather than
// exactly one. It all comes back when the delegation is reclaimed.
export const RECORD_ATOMS = 100000n;   // 0.001 tSEQ

// Sizes of the transactions SWK builds (vbytes), measured on a regtest node
// (create 247, move 291, leave 234, unbond of one stake 259, claim 235) and
// rounded up for the spread of signature lengths:
// a record's creation (one P2WPKH input, the record, the fee), a re-point (one
// record input, the new record, the fee), a reclaim (one record input, one
// wallet output, the fee), an unbond of one stake, and its claim. Each fee is
// the size at the wallet's rate, so it moves with that rate instead of drifting.
export const VBYTES = Object.freeze({ create: 260, move: 300, leave: 250, unbond: 270, claim: 250 });

// How long a transaction this wallet broadcast may be unknown to the explorer
// before the wallet stops waiting for it (it was never relayed, or was evicted).
export const GRACE_MS = 10 * 60 * 1000;

const now = (ctx) => (ctx.now ? ctx.now() : Date.now());

export function feeFor(ctx, kind){
  const vb = BigInt(VBYTES[kind]);
  const atoms = (vb * BigInt(ctx.feeRate) + 999n) / 1000n;
  return atoms > 0n ? atoms : 1n;
}

// Which wasm entry points each feature needs. A wallet deployed against an
// older pkg/ has some of them and not others; offering "join a pool" without
// "leave a pool" would be a one-way door.
export function delegationSupported(lwk){
  return typeof lwk.findDelegationRecords === 'function'
      && typeof lwk.buildDelegationCreateTx === 'function'
      && typeof lwk.buildDelegationSpendTx === 'function'
      && typeof lwk.stakeRecordSigning === 'function';
}
export function unbondingSupported(lwk){
  return typeof lwk.buildUnbondTx === 'function'
      && typeof lwk.buildUnbondClaimTx === 'function'
      && typeof lwk.sequentiaUnbondScript === 'function'
      && typeof lwk.sequentiaStakeScript === 'function'
      && typeof lwk.unbondFeeCap === 'function'
      && typeof lwk.stakeRecordSigning === 'function';
}

// The chain tip a record spend is built against. Unknown is refused: the
// signature a record spend needs depends on the height of the block it enters,
// and guessing it wrong produces a transaction no block will take.
export async function chainTip(ctx){
  let tip = 0;
  try { tip = Number(await ctx.tipHeight()) || 0; } catch { tip = 0; }
  if (!Number.isInteger(tip) || tip <= 0)
    throw new Error('could not read the chain tip, and a staking transaction is signed for the height it enters at; try again in a moment');
  return tip;
}

// The signature the next block wants, in SWK's words ("legacy" | "segwitV0").
export function signingFor(ctx, tip){
  return ctx.lwk.stakeRecordSigning(ctx.network, tip, ctx.recordsV2Height ?? undefined);
}

// Build a record spend for the next block and make sure it still is: the tip
// is read again after building, and if a block arrived that moved the chain
// across the height where the signature changes, it is built again. A spend
// built for one side of that height is refused on the other.
export async function signedForNextBlock(ctx, build){
  for (let attempt = 0; attempt < 3; attempt++){
    const tip = await chainTip(ctx);
    const built = build(tip);
    const want = signingFor(ctx, tip);
    if (built.signing !== want)
      throw new Error(`the wallet built a ${built.signing} signature where the chain wants ${want}; refusing to broadcast it`);
    const after = await chainTip(ctx);
    if (signingFor(ctx, after) === built.signing) return built;
  }
  throw new Error('the chain is crossing the height where staking signatures change; try again in a minute');
}

async function json(ctx, path){
  const r = await ctx.esplora(path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`explorer ${path}: HTTP ${r.status}`);
  return r.json();
}
async function text(ctx, path){
  const r = await ctx.esplora(path);
  if (!r.ok) throw new Error(`explorer ${path}: HTTP ${r.status}`);
  return (await r.text()).trim();
}

function readStore(ctx, key, fallback){
  try { const s = ctx.store.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function writeStore(ctx, key, value){
  if (value == null) ctx.store.removeItem(key);
  else ctx.store.setItem(key, JSON.stringify(value));
}

// The Electrum-style scripthash this explorer indexes by: the FORWARD sha256 of
// the scriptPubKey. Verified against the deployed esplora rather than assumed:
// the reversed form is the more common convention and returns an empty list
// here, which would look exactly like "you are not delegating", the worst
// possible wrong answer for a feature whose whole promise is that you can
// always leave.
export async function scriptHash(scriptHex){
  const bytes = Uint8Array.from(scriptHex.match(/../g).map(b => parseInt(b, 16)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- finding

// Up to this many pages (25 confirmed transactions each) of the staking key's
// P2WPKH history are read. That script also receives every block reward a solo
// staker earns, so the history can be long; a record created within the last
// couple of hundred transactions there is found by this pass, and an older one
// by the explorer probe.
const KEY_HISTORY_PAGES = 8;

// Records created by spending a coin of the staking key: every transaction in
// that key's P2WPKH history that spends from it, read for record outputs.
async function recordsFromKeyHistory(ctx, mine){
  const spk = ctx.stakerScript();
  const sh = await scriptHash(spk);
  const out = [];
  let path = `/scripthash/${sh}/txs`, lastConfirmed = null;
  for (let page = 0; page < KEY_HISTORY_PAGES; page++){
    const txs = await json(ctx, path);
    if (!Array.isArray(txs) || !txs.length) break;
    for (const t of txs){
      const spends = (t.vin || []).some(v => !v.is_coinbase && v.prevout && v.prevout.scriptpubkey === spk);
      if (!spends) continue;
      let hex; try { hex = await text(ctx, `/tx/${t.txid}/hex`); } catch { continue; }
      let found; try { found = ctx.lwk.findDelegationRecords(hex, mine); } catch { continue; }
      for (const f of found || [])
        out.push({ txid: t.txid, vout: f.vout, signer: f.signer, atoms: BigInt(f.value),
                   height: t.status && t.status.confirmed ? t.status.block_height : null });
    }
    const confirmed = txs.filter(t => t.status && t.status.confirmed);
    if (confirmed.length < 25) break;
    lastConfirmed = confirmed[confirmed.length - 1].txid;
    path = `/scripthash/${sh}/txs/chain/${lastConfirmed}`;
  }
  return out;
}

// Find this wallet's live delegation record: { txid, vout, atoms, signer,
// confirmed } or null. Every source is a candidate; the explorer decides which
// one is unspent and most recent.
export async function findDelegation(ctx){
  let mine;
  try { mine = ctx.stakerPublicKey(); } catch { return null; }
  const byOutpoint = new Map();
  const add = (c) => byOutpoint.set(c.txid + ':' + c.vout, { ...byOutpoint.get(c.txid + ':' + c.vout), ...c });

  // The join in flight in this browser, before any explorer has indexed it.
  const pending = readStore(ctx, PENDING_JOIN_KEY, null);
  if (pending && pending.createHex){
    try {
      for (const f of ctx.lwk.findDelegationRecords(pending.createHex, mine) || [])
        add({ txid: pending.createTxid, vout: f.vout, signer: f.signer, atoms: BigInt(f.value), height: null });
    } catch {}
  }

  try { for (const c of await recordsFromKeyHistory(ctx, mine)) add(c); }
  catch { /* an unreadable history must not stop the probe below */ }

  // A record paid for by the wallet's own coins, as records were made before
  // the chain required the staking key's coin. It stays live until moved or
  // reclaimed, so it is looked for whatever pool it names.
  try {
    for (const t of (ctx.walletTxs ? ctx.walletTxs() : [])) {
      let found; try { found = ctx.lwk.findDelegationRecords(t.hex, mine); } catch { continue; }
      for (const f of found || [])
        add({ txid: t.txid, vout: f.vout, signer: f.signer, atoms: BigInt(f.value), height: t.height ?? null });
    }
  } catch { /* an unreadable history must not stop the probe below */ }

  // The explorer's unspent outputs at the record script for each known signer.
  // This finds a record whatever created it, including a re-point (which
  // spends only the old record) and a record from before the staking key's
  // coin was required, and survives a restore onto a browser that remembers
  // nothing. Signers come first from this browser's hints, then the board.
  let probed = 0;
  for (const group of ctx.hints()){
    if (probed) break;
    for (const sg of group){
      let spk; try { spk = ctx.lwk.sequentiaDelegationScript(mine, sg); } catch { continue; }
      try {
        const utxos = await json(ctx, `/scripthash/${await scriptHash(spk)}/utxo`);
        for (const u of utxos || []){
          add({ txid: u.txid, vout: u.vout, signer: sg, atoms: BigInt(u.value),
                height: (u.status && u.status.confirmed) ? u.status.block_height : null, unspent: true });
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
  for (const c of candidates){
    try {
      if (!c.unspent){
        const j = await json(ctx, `/tx/${c.txid}/outspend/${c.vout}`);
        if (j && j.spent) continue;                 // superseded, or already reclaimed
      }
      const st = await json(ctx, `/tx/${c.txid}/status`);
      if (!st) continue;                            // not on chain nor in the mempool
      c.confirmed = !!st.confirmed;
      return c;
    } catch { /* transient: try the next candidate */ }
  }
  return null;
}

// ---------------------------------------------------------------- stakes

// The two locks a Sequentia wallet bonds with, both the network's shortest: a
// height-based CSV of 43,200 blocks (this wallet and the extension), which
// consensus counts in 30-second slots, and a time-based CSV of 2,532 units of
// 512 seconds (Ambra), ceil(43,200 × 30 / 512). A stake of this wallet's key
// under either is found, shown and unbonded here, whichever wallet made it.
export const HEIGHT_CSV = 43200;
export const TIME_CSV = (1 << 22) | 2532;
export const STAKE_CSVS = [HEIGHT_CSV, TIME_CSV];
const CSV_TIME_FLAG = 1 << 22;
const CSV_MASK = 0xffff;
export const isTimeCsv = (csv) => (Number(csv) & CSV_TIME_FLAG) !== 0;
/// What a time-based lock waits, in seconds.
export const csvSeconds = (csv) => (Number(csv) & CSV_MASK) * 512;

// The stakes of this wallet's key that the chain holds, for a browser that remembers none
// of them: a restore from the phrase, or the same phrase in another browser. The page
// keeps its stakes in its own storage, which a restore starts without, so its Stake tab
// said "No stakes yet" with the coins locked. They are the explorer's unspent outputs at
// the staking script of the wallet's key and `csv`, and at the key's unbonding script, an
// unbonding output leading back through its transaction to the stake it came from.
// Answers entries in the shape the page keeps ({ pubkey, csv, txid, atoms, time }, txid
// the bond's). A stake already claimed back is not found: nothing is left to do with it.
export async function findStakes(ctx, csv){
  let mine;
  try { mine = ctx.stakerPublicKey(); } catch { return []; }
  const at = (st) => (st && st.confirmed && st.block_time) ? st.block_time * 1000 : Date.now();
  const out = new Map();
  const stakeSpk = ctx.lwk.sequentiaStakeScript(mine, csv);
  for (const u of (await json(ctx, `/scripthash/${await scriptHash(stakeSpk)}/utxo`)) || [])
    if (!out.has(u.txid)) out.set(u.txid, { pubkey: mine, csv, txid: u.txid, atoms: String(u.value), time: at(u.status) });
  const unbondSpk = ctx.lwk.sequentiaUnbondScript(mine);
  for (const u of (await json(ctx, `/scripthash/${await scriptHash(unbondSpk)}/utxo`)) || []){
    const tx = await json(ctx, `/tx/${u.txid}`);
    const vin = ((tx && tx.vin) || []).find(v => v.prevout && v.prevout.scriptpubkey === stakeSpk);
    if (!vin || out.has(vin.txid)) continue;
    const bond = await json(ctx, `/tx/${vin.txid}/status`);
    out.set(vin.txid, { pubkey: mine, csv, txid: vin.txid, atoms: String(vin.prevout.value), time: at(bond) });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- joining

// Build both transactions of a join, broadcasting nothing: the payment from
// the wallet to its own staking key, and the record's transaction spending it.
export async function prepareJoin(ctx, target){
  target = String(target || '').trim().toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(target)) throw new Error('pick a pool above, or paste its 66-character signer key');
  const controller = ctx.stakerPublicKey();
  if (target === controller) throw new Error('that is your own staking key; delegating to yourself is what already happens with no pool at all');
  const tip = await chainTip(ctx);
  const createFee = feeFor(ctx, 'create');
  // Exactly the record and its fee, so the record's transaction has no change.
  const auth = await ctx.signAuthorization(controller, RECORD_ATOMS + createFee);
  const create = ctx.lwk.buildDelegationCreateTx({
    mnemonic: ctx.mnemonic(),
    coinTxHex: auth.hex,
    signer: target,
    recordValue: RECORD_ATOMS.toString(),
    feeAtoms: createFee.toString(),
    locktime: tip,
  }, ctx.network);
  if (create.changeValue !== '0') throw new Error('the payment to the staking key holds more than the record and its fee');
  return { signer: target, authHex: auth.hex, authTxid: auth.txid, authFee: auth.fee ?? null,
           createHex: create.rawHex, createTxid: create.txid, recordAtoms: RECORD_ATOMS, createFee };
}

// Persist both, then broadcast both. The payment leaves a coin at the staking
// key's P2WPKH, which this wallet's coin scan does not watch; with both
// transactions stored first, a crash or a closed tab between the two
// broadcasts is finished by resumeJoin on the next load instead of leaving
// that coin where nothing looks.
export async function commitJoin(ctx, p){
  writeStore(ctx, PENDING_JOIN_KEY, { signer: p.signer, authHex: p.authHex, authTxid: p.authTxid,
                                      createHex: p.createHex, createTxid: p.createTxid, time: now(ctx) });
  const authTxid = await ctx.broadcast(p.authHex);
  const createTxid = await ctx.broadcast(p.createHex);
  return { authTxid, createTxid };
}

// Finish or retire the join this browser has in flight. Returns what it did.
export async function resumeJoin(ctx){
  const p = readStore(ctx, PENDING_JOIN_KEY, null);
  if (!p) return 'none';
  const created = await json(ctx, `/tx/${p.createTxid}/status`);
  if (created && created.confirmed){ writeStore(ctx, PENDING_JOIN_KEY, null); return 'confirmed'; }
  if (created) return 'waiting';                   // in the mempool
  const authed = await json(ctx, `/tx/${p.authTxid}/status`);
  try {
    if (!authed) await ctx.broadcast(p.authHex);
    await ctx.broadcast(p.createHex);
    return 'rebroadcast';
  } catch (e) {
    // Past the grace window and still refused: the payment's inputs went
    // elsewhere, so neither transaction can ever be mined. Nothing was lost.
    if (!authed && now(ctx) - (p.time || 0) > GRACE_MS){ writeStore(ctx, PENDING_JOIN_KEY, null); return 'abandoned'; }
    throw e;
  }
}

// ---------------------------------------------------------------- moving and leaving

function spendRecipe(ctx, deleg, tip){
  return {
    mnemonic: ctx.mnemonic(),
    recordTxid: deleg.txid, recordVout: deleg.vout,
    recordValue: deleg.atoms.toString(),
    currentSigner: deleg.signer,
    locktime: tip,
    tipHeight: tip,
    ...(ctx.recordsV2Height != null ? { recordsV2Height: ctx.recordsV2Height } : {}),
  };
}

// Re-point the record at another pool: one transaction spending the old record
// and creating the new one. Consensus allows one live record per staking key,
// so two separate transactions could be mined in an order a block refuses.
export async function buildMove(ctx, deleg, target){
  target = String(target || '').trim().toLowerCase();
  if (deleg.signer === target) throw new Error('you are already delegating to that pool');
  if (!deleg.confirmed) throw new Error('your last delegation change has not confirmed yet; wait for it');
  const fee = feeFor(ctx, 'move');
  return signedForNextBlock(ctx, (tip) => ctx.lwk.buildDelegationSpendTx(
    { ...spendRecipe(ctx, deleg, tip), rotateTo: target, feeAtoms: fee.toString() }, ctx.network));
}

// Reclaim the record to `address` (an unblinded address of the wallet).
export async function buildLeave(ctx, deleg, address){
  if (!deleg.confirmed) throw new Error('your last delegation change has not confirmed yet; wait for it');
  const fee = feeFor(ctx, 'leave');
  return signedForNextBlock(ctx, (tip) => ctx.lwk.buildDelegationSpendTx(
    { ...spendRecipe(ctx, deleg, tip), reclaimAddress: address, feeAtoms: fee.toString() }, ctx.network));
}

// ---------------------------------------------------------------- unbonding

// Where a bonded stake stands, read from the chain each time (never sticky: a
// Bitcoin reorg can take any of it back). `entry` is one of the wallet's
// stored stakes ({ pubkey, csv, atoms, txid, time, unbond?, claim? }).
//
//   state: 'unknown'      the bond is not on chain nor in the mempool
//          'pending'      the bond is not confirmed yet
//          'bonded'       locked until block `maturesAt`
//          'unbondable'   its lock has passed: it can be unbonded
//          'unbonding'    unbonded; claimable once the chain tip is anchored at
//                         Bitcoin block `claimableAt` (null while the unbond is
//                         unconfirmed or its anchor unread)
//          'claimable'    the unbonding output can be claimed
//          'claiming'     the claim is broadcast, not yet confirmed
//          'claimed'      the claim is confirmed: the coins are back in the wallet
//          'left'         the stake was spent some other way
export async function stakeState(ctx, entry, tip){
  const tx = await json(ctx, `/tx/${entry.txid}`);
  if (!tx) return { state: 'unknown' };
  const script = ctx.lwk.sequentiaStakeScript(entry.pubkey, entry.csv);
  const vout = (tx.vout || []).findIndex(o => o.scriptpubkey === script);
  if (vout < 0) return { state: 'unknown' };
  const value = String(tx.vout[vout].value);
  const stake = { txid: entry.txid, vout, value, script };
  if (!tx.status || !tx.status.confirmed) return { state: 'pending', stake };

  const spent = await json(ctx, `/tx/${entry.txid}/outspend/${vout}`);
  if (!spent || !spent.spent){
    if (isTimeCsv(entry.csv)){
      // A time lock (BIP68): a spend is valid in the next block once the
      // tip's median time is at least the median time of the block before
      // the bond's, plus the lock.
      const bondBlock = await json(ctx, `/block/${tx.status.block_hash}`);
      const before = bondBlock && bondBlock.previousblockhash ? await json(ctx, `/block/${bondBlock.previousblockhash}`) : null;
      const tipHash = await text(ctx, '/blocks/tip/hash');
      const tipBlock = await json(ctx, `/block/${tipHash}`);
      if (!before || before.mediantime == null || !tipBlock || tipBlock.mediantime == null) return { state: 'bonded', stake, maturesAtTime: null };
      const maturesAtTime = Number(before.mediantime) + csvSeconds(entry.csv);
      return { state: Number(tipBlock.mediantime) >= maturesAtTime ? 'unbondable' : 'bonded', stake, maturesAtTime, tipTime: Number(tipBlock.mediantime) };
    }
    // A spend locked to the bond's relative height enters a block at least
    // `csv` blocks after the bond's own.
    const maturesAt = tx.status.block_height + Number(entry.csv);
    return { state: tip + 1 >= maturesAt ? 'unbondable' : 'bonded', stake, maturesAt };
  }

  const unbondScript = ctx.lwk.sequentiaUnbondScript(entry.pubkey);
  const ub = await json(ctx, `/tx/${spent.txid}`);
  if (!ub) return { state: 'unbonding', stake, claimableAt: null };
  const out0 = (ub.vout || [])[0];
  if (!out0 || out0.scriptpubkey !== unbondScript) return { state: 'left', stake, spender: spent.txid };
  const unbonding = { txid: spent.txid, vout: 0, value: String(out0.value) };
  if (!ub.status || !ub.status.confirmed) return { state: 'unbonding', stake, unbonding, claimableAt: null };

  const claimed = await json(ctx, `/tx/${spent.txid}/outspend/0`);
  if (claimed && claimed.spent){
    const confirmed = !!(claimed.status && claimed.status.confirmed);
    return { state: confirmed ? 'claimed' : 'claiming', stake, unbonding, claim: claimed.txid };
  }
  // The claim is valid once the anchor it is judged against is at least the
  // unbond's own anchor plus the depth. The node judges a claim in its mempool
  // against the tip's anchor, and a block against its own, so the tip's
  // anchor is the one to wait for: Bitcoin's own tip runs a little ahead.
  let anchor = null, spendAnchor = null;
  try { anchor = await ctx.anchorHeightOf(ub.status.block_hash); } catch {}
  try { spendAnchor = await ctx.spendAnchorHeight(); } catch {}
  if (anchor == null || !(anchor >= 0)) return { state: 'unbonding', stake, unbonding, claimableAt: null };
  const claimableAt = Number(anchor) + Number(ctx.unbondDepth);
  const ready = spendAnchor != null && Number(spendAnchor) >= claimableAt;
  return { state: ready ? 'claimable' : 'unbonding', stake, unbonding, claimableAt, spendAnchor };
}

// Unbonding, step 1: the stake into its unbonding output. The fee comes out of
// the stake and may not exceed the chain's cap of 1% of it.
export async function buildUnbond(ctx, s){
  if (s.state !== 'unbondable') throw new Error('this stake cannot be unbonded yet');
  let fee = feeFor(ctx, 'unbond');
  const cap = BigInt(ctx.lwk.unbondFeeCap(s.stake.value));
  if (fee > cap) fee = cap;
  return signedForNextBlock(ctx, (tip) => ctx.lwk.buildUnbondTx({
    mnemonic: ctx.mnemonic(),
    stakes: [{ txid: s.stake.txid, vout: s.stake.vout, value: s.stake.value, script: s.stake.script }],
    feeAtoms: fee.toString(),
    locktime: tip, tipHeight: tip,
    ...(ctx.recordsV2Height != null ? { recordsV2Height: ctx.recordsV2Height } : {}),
  }, ctx.network));
}

// Unbonding, step 2: the unbonding output to `address`, an unblinded address
// of the wallet.
export async function buildClaim(ctx, s, address){
  if (s.state !== 'claimable') throw new Error('this stake cannot be claimed yet');
  const fee = feeFor(ctx, 'claim');
  return signedForNextBlock(ctx, (tip) => ctx.lwk.buildUnbondClaimTx({
    mnemonic: ctx.mnemonic(),
    unbonding: [s.unbonding],
    address,
    feeAtoms: fee.toString(),
    locktime: tip, tipHeight: tip,
    ...(ctx.recordsV2Height != null ? { recordsV2Height: ctx.recordsV2Height } : {}),
  }, ctx.network));
}

// Record a built unbond or claim on its stake entry, then broadcast it. The
// coins never leave the staking key's scripts until the claim pays the wallet,
// so what is stored is a note for the page, not reclaim material: the state is
// always re-read from the chain.
export async function broadcastStep(ctx, entryTxid, step, built){
  const stakes = readStore(ctx, ctx.stakesKey, []);
  const e = stakes.find(x => x.txid === entryTxid);
  if (e){ e[step] = { txid: built.txid, time: now(ctx) }; writeStore(ctx, ctx.stakesKey, stakes); }
  return ctx.broadcast(built.rawHex);
}

export const __test__ = { recordsFromKeyHistory, spendRecipe };
