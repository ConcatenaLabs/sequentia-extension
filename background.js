// Background service worker: owns the wallet engine and routes every message.
//
// Three kinds of clients talk to it:
//  - the popup + approval pages (scope 'ui'), which also hold a long-lived
//    Port while open so the worker (and the wasm engine) stays warm;
//  - content scripts relaying website provider requests (scope 'dapp');
//  - chrome.alarms (auto-lock).
//
// All amounts cross this boundary as strings (BigInt does not survive
// extension messaging).

import './src/shim.js';
import * as engine from './src/engine.js';
import * as A from './src/assets.js';
import * as openamp from './src/openamp.js';
import * as staking from './src/staking.js';
import * as ln from './src/ln.js';
import * as dex from './src/dex.js';
import * as rewards from './src/rewards.js';
import { attributeStakingRewards, planRewardBatches, decideRewardConversion,
         sequentiaCoinbaseMaturity } from './pkg/lwk_wasm.js';
import { btc as btcLib } from './vendor/btc.js';
import * as perms from './src/permissions.js';
import * as router from './src/provider-router.js';
import {
  vaultExists, vaultCreate, vaultUnlock, vaultLock, sessionMnemonic,
  armAutoLock, touchAutoLock,
} from './src/vault.js';
import { stGet, stSet, parseAtoms } from './src/util.js';
import { EXPLORER_TX, EXPLORER_T4_TX } from './src/config.js';

// ---- crash breadcrumbs: record the worker's last breath so a death mid-
// operation is diagnosable from the next boot (read via the debug method).
self.addEventListener('error', (e) => {
  stSet('local', 'ext.lastError', { at: Date.now(), msg: String(e.message || e), src: String(e.filename || ''), line: e.lineno || 0 }).catch(() => {});
});
self.addEventListener('unhandledrejection', (e) => {
  stSet('local', 'ext.lastError', { at: Date.now(), msg: 'unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason) }).catch(() => {});
});
const bootAt = Date.now();
let hbTimer = null;
let hbStage = 'boot';
export function heartbeat(stage) {
  if (stage) hbStage = stage;
  stSet('local', 'ext.heartbeat', { at: Date.now(), bootAt, aliveSecs: Math.round((Date.now() - bootAt) / 1000), stage: hbStage }).catch(() => {});
  if (!hbTimer) hbTimer = setInterval(() => heartbeat(), 5000);
}
heartbeat('boot');

// ---- dapp event ports (content scripts subscribe after connect) ----
const dappPorts = new Map();   // origin -> Set<Port>
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'seq-dapp') {
    let origin = '';
    try { origin = new URL(port.sender.url).origin; } catch {}
    if (!origin) return;
    if (!dappPorts.has(origin)) dappPorts.set(origin, new Set());
    dappPorts.get(origin).add(port);
    // Long-lived request channel: sendMessage response callbacks die at
    // Chrome's ~5-minute cap, which killed multi-minute swaps mid-flight.
    // Port messages have no such cap; the content script prefers this path.
    port.onMessage.addListener((m) => {
      if (m && m.__ping) { try { port.postMessage({ __pong: 1 }); } catch {} return; }
      if (!m || m.__req == null) return;
      (async () => {
        try {
          const result = await router.handleDappRequest(origin, m.method, m.params || {});
          try { port.postMessage({ __res: m.__req, ok: true, result }); } catch {}
        } catch (e) {
          try { port.postMessage({ __res: m.__req, ok: false, error: String((e && e.message) ?? e) }); } catch {}
        }
      })();
    });
    port.onDisconnect.addListener(() => {
      const s = dappPorts.get(origin);
      if (s) { s.delete(port); if (!s.size) dappPorts.delete(origin); }
    });
  }
  // 'seq-ui' ports exist purely to keep the service worker alive while the
  // popup is open; no messages flow over them.
});

function emitToOrigin(origin, event, data) {
  const s = dappPorts.get(origin);
  if (!s) return;
  for (const p of s) { try { p.postMessage({ event, data }); } catch {} }
}
function emitToAll(event, data) {
  for (const origin of dappPorts.keys()) emitToOrigin(origin, event, data);
}

// ---- LN + DEX progress relayed to whichever UI page is listening ----
ln.setProgressSink((text) => {
  chrome.runtime.sendMessage({ scope: 'ui-event', event: 'ln-progress', text }).catch(() => {});
});
dex.setProgressSink((text) => {
  heartbeat(text);
  chrome.runtime.sendMessage({ scope: 'ui-event', event: 'ln-progress', text }).catch(() => {});
  emitToAll('dexProgress', { text });
});

// ---- unlock lifecycle ----
async function afterUnlock() {
  await engine.ensureOpen();
  await armAutoLock();
  // Non-blocking warm-up: registry, prices, fee rates, OpenAMP identity,
  // pending Lightning move resume, first sync.
  (async () => {
    await Promise.allSettled([A.loadRegistry(), A.loadPrices(), A.fetchFeeRates()]);
    await Promise.allSettled([openamp.oampInit()]);
    await Promise.allSettled([openamp.refreshBalances(), engine.sync()]);
    ln.resumePendingMove().catch(() => {});
  })().catch(() => {});
}

async function doLock() {
  await vaultLock();
  engine.closeWallet();
  emitToAll('accountsChanged', { accounts: [] });
  chrome.runtime.sendMessage({ scope: 'ui-event', event: 'locked' }).catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autolock') doLock().catch(() => {});
});

// Rebuild engine state silently if the worker restarted while unlocked — but
// do NOT rerun the heavy warm-up (full scan + cache-base scan): the worker
// cold-starts constantly, and a scan's synchronous wasm stretches starve the
// event loop enough to stall a concurrent Noise handshake past the hosted
// node's act-three deadline (seen live: the LN device signer could never
// attach right after a cold start). Requests pull their own freshness via
// syncIfStale; only a pending Lightning move (fund safety) resumes eagerly.
(async () => {
  if (await sessionMnemonic()) {
    await engine.ensureOpen().catch(() => {});
    if (await ln.pendingMove()) ln.resumePendingMove().catch(() => {});
  }
})();

// ---- overview composition for the popup ----
async function overview({ withLn = false } = {}) {
  await engine.ensureOpen();
  // Keep display data fresh without the unlock-time warm-up: refresh prices,
  // fee rates, and the registry in the background when they have gone stale.
  if (A.pricesStale()) {
    A.loadPrices().catch(() => {});
    A.fetchFeeRates().catch(() => {});
    A.loadRegistry().catch(() => {});
  }
  const settings = (await stGet('local', 'ext.settings')) || {};
  const ref = settings.refCcy || 'USD';
  const bal = await engine.balances();
  const heldSeq = Object.keys(bal.seq).filter((h) => BigInt(bal.seq[h] || 0) > 0n);
  // The cached Lightning summary blends into EVERY overview: withLn only
  // decides whether a LIVE refresh may run, never whether Lightning exists.
  // (The popup's fast first paint uses withLn:false — without the cache there
  // it rendered NO LN rows, so LN balances vanished on every popup open and
  // crawled back seconds later.) storage.local survives worker restarts and
  // extension reloads; a failed live read keeps serving the cache.
  let lnSum = { deployed: false, perKind: {} };
  const lnCached = await stGet('local', 'ext.lnSum').catch(() => null);
  if (lnCached) lnSum = lnCached.v;
  if (withLn && (!lnCached || Date.now() - lnCached.at >= 60_000)) {
    try {
      lnSum = await ln.summary(Object.keys(bal.seq));
      await stSet('local', 'ext.lnSum', { v: lnSum, at: Date.now() });
    } catch { /* keep the cache */ }
  }

  const rows = [];
  const push = (key, onchainAtoms, alwaysShow) => {
    const lnEntry = lnSum.perKind[key];
    const lnAtoms = lnEntry ? BigInt(lnEntry.units) : 0n;
    const total = BigInt(onchainAtoms) + lnAtoms;
    if (!alwaysShow && total <= 0n) return;
    const m = A.assetMeta(key);
    rows.push({
      key,
      ticker: m.ticker, name: m.name, precision: m.precision,
      onchain: String(onchainAtoms), ln: lnAtoms.toString(), lnChannels: lnEntry ? lnEntry.channels : 0,
      total: total.toString(),
      refStr: A.refValueStr(key, total, ref),
      refVal: (() => { const rv = A.refValue(key, total, ref); return rv ? rv.v : null; })(),
      verified: A.assetVerified(key), registered: A.assetRegistered(key), domain: A.assetDomain(key),
      restricted: key.startsWith('oamp:'),
      legend: key.startsWith('oamp:') ? openamp.composeLegend(key.slice(5)) : null,
      feePriced: (() => { try { return key !== 'BTC' && !key.startsWith('oamp:') && !!A.feeRateEntry(key); } catch { return false; } })(),
    });
  };

  // Dual-chain + equal standing: BTC (parent chain) always shows, even at 0;
  // every other asset only when its total is non-zero; nothing is pinned or
  // privileged beyond that. Headline = portfolio total in the reference currency.
  push('BTC', bal.btc, true);
  for (const h of Object.keys(bal.seq)) push(h, bal.seq[h], false);
  // LN-only balances: an asset can live ENTIRELY in Lightning channels (bought
  // on the LNDEX, zero on-chain trace) — it must show like any other holding.
  for (const k of Object.keys(lnSum.perKind)) {
    if (k === 'BTC' || (k in bal.seq)) continue;
    // alwaysShow: a live channel whose balance sits under the channel reserve
    // reads spendable 0, and hiding the row made real, settled funds invisible.
    push(k, 0n, true);
  }
  for (const [id, atoms] of Object.entries(openamp.balancesMap())) push('oamp:' + id, atoms, false);
  rows.sort((a, b) => (a.key === 'BTC' ? -1 : b.key === 'BTC' ? 1 : (b.refVal || 0) - (a.refVal || 0)));

  let totalRef = 0, anyPriced = false;
  for (const r of rows) if (r.refVal != null) { totalRef += r.refVal; anyPriced = true; }

  return {
    rows,
    ref, refOptions: A.refOptions(),
    totalRefStr: anyPriced ? A.fmtRef(totalRef, ref) : null,
    pricesStale: A.pricesStale(),
    scanned: bal.scanned,
    lnDeployed: lnSum.deployed,
    heldSeq,
    lnCapable: ln.capableKinds(heldSeq),
    oampAid: openamp.aid() || null,
    oampAssets: Object.values(openamp.assets()).map((a) => ({ id: a.id, ticker: a.ticker, name: a.name, precision: a.precision })),
    pendingMove: await ln.pendingMove(),
    policyHex: engine.getPolicyHex(),
    explorerTx: EXPLORER_TX, explorerT4Tx: EXPLORER_T4_TX,
  };
}

// ---- send routing (popup review flow) ----
async function prepareSend({ rows, feeAsset, feeRate }) {
  await engine.ensureOpen();
  if (!rows || !rows.length) throw new Error('add a recipient');
  const kinds = new Set(rows.map((r) => (r.asset === 'BTC' ? 'btc' : r.asset.startsWith('oamp:') ? 'oamp' : 'seq')));
  if (kinds.size > 1) throw new Error('BTC, Sequentia, and restricted-asset sends cannot be mixed in one transaction');
  const kind = [...kinds][0];
  if (kind === 'btc') {
    if (rows.length !== 1) throw new Error('one recipient per Bitcoin transaction');
    const r = await engine.prepareBtcSend(rows[0].addr, rows[0].amtS, feeRate);
    return { ...r, kind: 'btc' };
  }
  if (kind === 'oamp') {
    if (rows.length !== 1) throw new Error('one recipient per restricted-asset transfer');
    const row = rows[0];
    const meta = A.assetMeta(row.asset);
    const atoms = parseAtoms(row.amtS, meta.precision);
    const r = await openamp.prepareTransfer(row.asset.slice(5), row.addr.trim(), atoms.toString());
    return { ...r, kind: 'oamp' };
  }
  const r = await engine.prepareSeqSend(rows, feeAsset, feeRate);
  return { ...r, kind: 'seq' };
}

async function confirmSend({ id, kind }) {
  if (kind === 'oamp') return await openamp.completeTransfer(id);
  return await engine.confirmSend(id);
}

// ---- the UI method table ----
const uiMethods = {
  'state': async () => ({
    hasVault: await vaultExists(),
    unlocked: !!(await sessionMnemonic()),
    network: 'sequentia-testnet',
    pendingApproval: router.anyPendingApproval(),
  }),
  'generateMnemonic': async () => ({ mnemonic: await engine.randomMnemonic(12) }),
  'create': async ({ mnemonic, password }) => {
    await engine.validateMnemonic(mnemonic);
    await vaultCreate(mnemonic, password);
    await engine.openFromPhrase(mnemonic);
    await afterUnlock();
    return { ok: true };
  },
  'unlock': async ({ password }) => {
    const phrase = await vaultUnlock(password);
    await engine.openFromPhrase(phrase);
    await afterUnlock();
    return { ok: true };
  },
  'lock': async () => { await doLock(); return { ok: true }; },
  'revealMnemonic': async ({ password }) => ({ mnemonic: await vaultUnlock(password) }),
  'sync': async () => { await engine.ensureOpen(); await engine.sync(); await openamp.refreshBalances().catch(() => {}); return { ok: true }; },
  'overview': async (p) => overview(p || {}),
  'receive': async ({ confidential, fresh }) => {
    await engine.ensureOpen();
    const a = fresh ? engine.newAddress(!!confidential) : engine.currentAddress(!!confidential);
    return { ...a, qr: engine.qrFor(a.address) };
  },
  'oampReceive': async ({ assetId }) => {
    const address = await openamp.depositAddress(assetId);
    return { aid: openamp.aid(), address, qr: address ? engine.qrFor(address) : null, aidQr: engine.qrFor(openamp.aid()) };
  },
  // --- staking pools -------------------------------------------------------
  // Delegation only: lend the weight this wallet's staking key already carries,
  // move it, take it back. Registering a stake locks coins for an unbonding
  // period and running a pool means being online with the signing key on the
  // machine producing blocks, so neither is offered from a browser popup.
  'stakingOverview': async () => {
    await engine.ensureOpen();
    if (!staking.supported()) return { supported: false };
    // The board is advisory. Leaving must work whether or not it answers, so a
    // board failure is reported rather than allowed to fail the whole call.
    let board = null, boardError = null;
    try { board = await staking.fetchPools(); }
    catch (e) { boardError = String((e && e.message) ?? e); }
    const delegation = await staking.findDelegation(board).catch(() => null);
    return {
      supported: true,
      board,
      boardError,
      delegation: delegation && { ...delegation, atoms: delegation.atoms.toString() },
      warnings: staking.warnings(delegation, board),
      stakerKey: engine.getSigner().stakerPublicKey(),
    };
  },
  // --- staking rewards, and converting them --------------------------------
  // A staker is paid the fees of the blocks it earns from, in whichever assets
  // the payers chose. The two decisions that must not differ between wallets --
  // which coins are rewards, and which of them to sell -- are SWK's, reached
  // through the kit's wasm; everything here is this wallet's own rails.
  'rewardsOverview': async () => {
    await engine.ensureOpen();
    const ctx = rewardConvertContext();
    let report = null, error = null;
    try { report = await rewards.runAutoConvert(ctx, { dryRun: true }); }
    catch (e) { error = String((e && e.message) ?? e); }
    let totals = [];
    try {
      totals = rewards.totalsOf(ctx.engine.attributeStakingRewards(
        JSON.stringify(ctx.walletTxs()), JSON.stringify(ctx.stakingKeys()),
        Number(ctx.tipHeight() || 0), Number(sequentiaCoinbaseMaturity()))).map((t) => ({
          asset: t.asset, mature: t.mature.toString(), immature: t.immature.toString(),
          outputs: t.outputs, sources: t.sources,
        }));
    } catch (e) { if (!error) error = String((e && e.message) ?? e); }
    return {
      settings: await rewards.rewardSettings(),
      totals,
      considered: (report ? report.considered : []).map((r) => ({
        ...r,
        ticker: (A.assetMeta(r.batch.asset) || {}).ticker || r.batch.asset.slice(0, 8),
      })),
      recent: (await rewards.conversions()).filter((c) => c.state === 'done').slice(0, 5),
      error,
    };
  },
  'rewardsSetConvert': async (patch) => {
    const next = await rewards.setRewardSettings(patch || {});
    // Act on it now rather than at the next alarm: a staker who just switched
    // it on should not have to wonder whether anything is happening.
    if (next.enabled) runRewardPass().catch(() => {});
    return next;
  },

  'stakingDelegate': async ({ signer }) => {
    await engine.ensureOpen();
    // Two transactions: the wallet pays its staking key, then the record is
    // created from that coin. `txid` is the record's.
    return await staking.delegate(signer);
  },
  'stakingSpend': async ({ rotateTo }) => {
    await engine.ensureOpen();
    // Pass the board so a record created by a MOVE (which touches nothing this
    // wallet owns) is still found.
    let board = null;
    try { board = await staking.fetchPools(); } catch {}
    const record = await staking.findDelegation(board);
    const built = await staking.buildSpend(record, rotateTo || null);
    const { txid } = await engine.broadcastRaw({ hex: built.rawHex });
    return { txid, repointed: built.repointed, signing: built.signing };
  },
  'prepareSend': prepareSend,
  'confirmSend': confirmSend,
  'dropSend': async ({ id, kind }) => { kind === 'oamp' ? openamp.dropTransfer(id) : engine.dropPrepared(id); return { ok: true }; },
  'history': async () => {
    await engine.ensureOpen();
    const [seq, btc, oamp] = await Promise.all([
      Promise.resolve(engine.seqHistory()),
      engine.btcHistory().catch(() => []),
      openamp.transferHistory(),
    ]);
    // Attach display meta so the popup needs no asset table of its own.
    const withMeta = (list) => list.map((t) => ({
      ...t,
      display: Object.entries(t.deltas).map(([h, v]) => ({ ticker: A.assetMeta(h).ticker, precision: A.assetMeta(h).precision || (h === 'BTC' ? 8 : 0), atoms: v })),
    }));
    return { seq: withMeta(seq), btc: withMeta(btc), oamp };
  },
  'feeAssets': async () => {
    await engine.ensureOpen();
    const bal = await engine.balances();
    const held = Object.keys(bal.seq).filter((h) => BigInt(bal.seq[h] || 0) > 0n);
    const priced = A.feePricedAssets(held);
    const policy = engine.getPolicyHex();
    if (!priced.includes(policy) && (() => { try { A.feeRateFor(policy); return true; } catch { return false; } })()) priced.unshift(policy);
    return { assets: priced.map((h) => ({ hex: h, ticker: A.assetMeta(h).ticker })) };
  },
  'lnInvoice': async ({ kind, amount, memo }) => await ln.createInvoice({ kind, atoms: amount, memo }),
  'lnPay': async ({ kind, bolt11 }) => await ln.payInvoice({ kind, bolt11 }),
  'lnMove': async ({ kind, amount }) => await ln.moveToLightning({ kind, atoms: amount }),
  'lnClose': async ({ kind }) => await ln.closeToChain({ kind }),
  'getSettings': async () => ((await stGet('local', 'ext.settings')) || {}),
  'setSettings': async (p) => {
    const s = (await stGet('local', 'ext.settings')) || {};
    Object.assign(s, p || {});
    await stSet('local', 'ext.settings', s);
    return s;
  },
  'sites': async () => ({ sites: await perms.sites() }),
  'revokeSite': async ({ origin }) => {
    await perms.revoke(origin);
    emitToOrigin(origin, 'disconnect', {});
    return { ok: true };
  },
  'approval.get': async ({ id }) => {
    const p = id ? router.pendingApproval(id) : router.anyPendingApproval();
    return { approval: p, unlocked: !!(await sessionMnemonic()) };
  },
  'approval.unlock': async ({ password }) => {
    const phrase = await vaultUnlock(password);
    await engine.openFromPhrase(phrase);
    await afterUnlock();
    return { ok: true };
  },
  'approval.decide': async ({ id, approve }) => await router.decideApproval(id, !!approve),
};

// ---- message dispatch ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Offscreen-document job telemetry: relay progress to the dapp pages.
  if (msg && (msg.scope === 'oln-progress' || msg.scope === 'oln-done' || msg.scope === 'oln-ping' || msg.scope === 'oln-store')) {
    if (msg.scope === 'oln-progress') emitToAll('dexProgress', { text: msg.text, job: msg.job });
    if (msg.scope === 'oln-done') emitToAll('dexJobDone', { job: msg.job });
    // oln-ping wakes/extends this worker (a live worker retains the offscreen
    // page); stamp its arrival so a post-mortem can see the page was alive.
    if (msg.scope === 'oln-ping') stSet('local', 'ext.olnping.' + msg.job, Date.now()).catch(() => {});
    // oln-store: the offscreen page's ONLY route to storage — offscreen
    // documents get no chrome API beyond runtime messaging, so job records
    // are written here on its behalf (and the message wakes this worker).
    if (msg.scope === 'oln-store' && sender.id === chrome.runtime.id && typeof msg.key === 'string' && msg.key.startsWith('ext.oln')) {
      stSet('local', msg.key, msg.val)
        .then(() => sendResponse && sendResponse({ ok: true }))
        .catch(() => sendResponse && sendResponse({ ok: false }));
      return true;
    }
    sendResponse && sendResponse({ ok: true });
    return false;
  }
  (async () => {
    try {
      if (msg && msg.scope === 'ui') {
        // Only extension pages may use the ui scope.
        if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith('chrome-extension://'))) {
          throw new Error('forbidden');
        }
        const fn = uiMethods[msg.method];
        if (!fn) throw new Error('unknown ui method: ' + msg.method);
        await touchAutoLock();
        const result = await fn(msg.params || {});
        sendResponse({ ok: true, result });
        return;
      }
      if (msg && msg.scope === 'dapp') {
        let origin = '';
        try { origin = new URL(sender.url).origin; } catch {}
        const result = await router.handleDappRequest(origin, msg.method, msg.params || {});
        sendResponse({ ok: true, result });
        return;
      }
      sendResponse({ ok: false, error: 'unknown scope' });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) ?? e) });
    }
  })();
  return true;   // async response
});


// --- reward auto-conversion ------------------------------------------------
// The facts SWK's attribution needs, and the rails this wallet sells on.
function rewardConvertContext() {
  const wollet = engine.getWollet();
  const signer = engine.getSigner();
  return {
    engine: { attributeStakingRewards, planRewardBatches, decideRewardConversion,
              sequentiaCoinbaseMaturity },
    walletTxs: () => {
      let txs = [];
      try { txs = wollet.transactions(); } catch { return []; }
      const out = [];
      for (const t of txs) {
        const outputs = [];
        try {
          for (const o of (t.outputs() || [])) {
            const w = o && o.get ? o.get() : null;
            if (!w) continue;
            let u; try { u = w.unblinded(); } catch { continue; }
            outputs.push({
              vout: Number(w.outpoint().vout()),
              scriptPubkey: w.scriptPubkey().toString(),
              asset: u.asset().toString(),
              value: Number(u.value()),
              spent: (typeof w.isSpent === 'function') ? !!w.isSpent() : false,
            });
          }
        } catch { continue; }
        if (!outputs.length) continue;
        let isCoinbase = false;
        try { isCoinbase = (typeof t.isCoinbase === 'function') ? !!t.isCoinbase() : false; } catch {}
        out.push({
          txid: t.txid().toString(),
          height: t.height() ?? null,
          isCoinbase,
          // A coinbase is never anyone's to send; off that path, "we sent it"
          // is what excludes our own withdrawal or re-pointing, which pay back
          // to the very staking key a pool payout would.
          fromMe: !isCoinbase && t.txType() === 'outgoing',
          ownedOutputs: outputs,
        });
      }
      return out;
    },
    stakingKeys: () => {
      let pub;
      try { pub = signer.stakerPublicKey(); } catch { return []; }
      if (!pub) return [];
      // A reward is only a reward if it lands on the P2WPKH the coinbase (or a
      // pot claim) actually pays -- so the script has to be the real one.
      let scriptHex;
      try {
        const bytes = Uint8Array.from((pub.match(/../g) || []).map((h) => parseInt(h, 16)));
        scriptHex = [...btcLib.p2wpkh(bytes).script].map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch { scriptHex = null; }
      if (!scriptHex) return [];
      return [{ scriptPubkey: scriptHex, pubkey: pub, delegated: !!REWARD_DELEGATED }];
    },
    tipHeight: () => { try { return engine.getWollet().tip().height(); } catch { return 0; } },
    quoteFor: async ({ asset, atoms, target }) => {
      // Same-chain: what the covenant book pays. Cross-chain: what a maker
      // buying this asset for Bitcoin pays. Either way `null` means no market,
      // which is a WAIT and not an error.
      try {
        const quote = target === rewards.NATIVE_BTC ? 'BTC' : target;
        const mount = target === rewards.NATIVE_BTC ? 'pln' : 'chain';
        const o = await dex.fetchOffer(mount, asset, quote);
        if (!o) return null;
        // The rail rests WHOLE offers, so clamp to what staking paid rather
        // than taking the offer's size: selling more than was earned is the
        // one mistake this must not make.
        const offerAtoms = BigInt(o.want_amount ?? o.wantAmount ?? 0);
        const take = rewards.sliceForWholeHtlc(offerAtoms, BigInt(atoms));
        if (take <= 0n) return null;
        const q = dex.sameChainQuote(o, take);
        if (!q || !q.counterAtoms) return null;
        const whole = dex.sameChainQuote(o, BigInt(atoms));
        return {
          receives: Number(q.counterAtoms),
          reference: Number((whole && whole.counterAtoms) || q.counterAtoms),
        };
      } catch { return null; }
    },
    execute: async (plan) => {
      try {
        if (plan.target === rewards.NATIVE_BTC) {
          const job = await dex.prepareLnMarketOrder({
            base: plan.asset, quote: 'BTC', side: 'sell', baseAtoms: BigInt(plan.atoms),
          });
          return { ok: !!job, txid: job && (job.txid || job.jobId) };
        }
        const filled = await dex.prepareOnchainFill({
          mount: 'chain', base: plan.asset, quote: plan.target, takeBase: BigInt(plan.atoms),
        });
        return { ok: !!filled, txid: filled && filled.txid };
      } catch (e) {
        // Rethrow: the engine treats a throw as AMBIGUOUS and keeps the coins
        // claimed, which is the right answer when we cannot tell whether the
        // sale happened.
        throw e;
      }
    },
  };
}

let REWARD_DELEGATED = false;
let rewardPassBusy = false;

async function runRewardPass() {
  if (rewardPassBusy) return;
  rewardPassBusy = true;
  try {
    if (!(await rewards.rewardSettings()).enabled) return;
    await engine.ensureOpen();
    try {
      const d = await staking.findDelegation(await staking.fetchPools().catch(() => null));
      REWARD_DELEGATED = !!(d && d.signer);
    } catch { /* the board is advisory */ }
    await rewards.runAutoConvert(rewardConvertContext());
  } catch (e) {
    console.warn('[rewards] conversion pass failed:', (e && e.message) ?? e);
  } finally {
    rewardPassBusy = false;
  }
}

// Rewards arrive at block pace at best, and every pass reads the book, so
// looking more often would only cost requests. The alarm survives the service
// worker being unloaded, which a setInterval would not.
try {
  chrome.alarms.create('rewardConvert', { periodInMinutes: 15 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a && a.name === 'rewardConvert') runRewardPass().catch(() => {});
  });
} catch { /* alarms unavailable in this context */ }
