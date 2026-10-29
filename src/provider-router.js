// Website provider request router.
//
// Handles window.sequentia requests relayed by the content script. The
// protocol is documented in doc/PROVIDER.md — keep the two in sync. Sensitive
// methods run through an approval window (one per request); `connect` is
// approved once per origin and persists until revoked in Settings.

import * as engine from './engine.js';
import * as perms from './permissions.js';
import * as openamp from './openamp.js';
import * as ln from './ln.js';
import * as dex from './dex.js';
import * as market from './market.js';
import * as A from './assets.js';
import { sessionMnemonic } from './vault.js';
import { checkSigningRequest } from './tagpolicy.js';
import { stGet } from './util.js';
import * as contracts from './contracts.js';
import * as leaves from './leaves.js';
import { readRequest, planSend, leafBalancesAnswer } from './leaf-request.js';
import * as leafTrade from './leaf-trade.js';
import * as leafSwap from './leaf-swap.js';
import * as leafResting from './leaf-resting.js';
import * as siteTrade from './site-trade.js';
import { ORDER_FEATURES } from './market-plan.js';

// ---- pending approvals ----
const pending = new Map();
let reqSeq = 0;

function newRequestId() { return 'req' + (++reqSeq) + '.' + Date.now(); }

export function pendingApproval(id) {
  const p = pending.get(id);
  if (!p) return null;
  return { id, origin: p.origin, method: p.method, display: p.display };
}
export function anyPendingApproval() {
  const first = pending.keys().next();
  return first.done ? null : pendingApproval(first.value);
}

// Approvals open as a regular TAB, not a floating popup window: on tiling /
// Wayland window managers (seen live on COSMIC) a popup created by a freshly
// reloaded service worker can land invisible, and an approval the user cannot
// see times out. A tab is always reachable from the tab strip.
async function openApprovalWindow(id) {
  await chrome.tabs.create({
    url: chrome.runtime.getURL('approval/approval.html') + '?id=' + encodeURIComponent(id),
    active: true,
  });
}

// Ask the user. `display` is the serializable summary the approval page renders.
function requestApproval(origin, method, display, exec) {
  // `exec(shown)` receives what the approval page says it showed (`decideApproval`).
  return new Promise((resolve, reject) => {
    const id = newRequestId();
    pending.set(id, { origin, method, display, exec, resolve, reject, at: Date.now() });
    // Expire abandoned approvals after 5 minutes.
    setTimeout(() => {
      const p = pending.get(id);
      if (p) { pending.delete(id); p.reject(new Error('approval timed out')); }
    }, 300000);
    openApprovalWindow(id).catch((e) => {
      pending.delete(id);
      reject(new Error('could not open the approval window: ' + (e?.message ?? e)));
    });
  });
}

// The approval page decided. On approve the operation runs asynchronously:
// the approval tab closes immediately (no "Working…" purgatory, and its own
// message channel cannot outlive Chrome's cap anyway); the outcome flows to
// the requesting page over the port channel.
export async function decideApproval(id, approve, shown = null) {
  const p = pending.get(id);
  if (!p) throw new Error('this request has expired');
  pending.delete(id);
  if (!approve) {
    p.reject(new Error('the user rejected the request'));
    return { done: true };
  }
  (async () => {
    try { p.resolve(await p.exec(shown)); }
    catch (e) { p.reject(e instanceof Error ? e : new Error(String(e))); }
  })();
  return { done: true };
}

// ---- account info ----
async function accountInfo() {
  const addr = engine.currentAddress(false);
  return {
    network: engine.getNetworkName(),
    address: addr.address,            // shared tb1: receives Sequentia assets AND parent-chain BTC
    openampAid: openamp.aid() || null,
  };
}

async function requireUnlockedAndConnected(origin) {
  if (!(await sessionMnemonic())) throw new Error('the wallet is locked');
  await engine.ensureOpen();
  if (!(await perms.isConnected(origin))) throw new Error('this site is not connected; call connect first');
}

// For approval-gated methods: only the connection is checked up front. A
// locked wallet is handled by the approval window itself (it shows its unlock
// card first), so the request never dies with a bare 'locked' error.
async function requireConnected(origin) {
  if (!(await perms.isConnected(origin))) throw new Error('this site is not connected; call connect first');
}
async function ensureOpenOrThrow() {
  if (!(await engine.ensureOpen())) throw new Error('the wallet is locked');
}

// An asset and an amount of it, as the leaf approvals show them.
function leafAsset(hex) {
  const m = A.assetMeta(hex);
  return m.ticker && m.ticker !== '?' ? m.ticker + ' (' + hex + ')' : hex;
}
function leafAmount(atoms, hex) {
  if (atoms == null || !hex) return String(atoms ?? '');
  const m = A.assetMeta(hex);
  const t = m.ticker && m.ticker !== '?' ? m.ticker : hex.slice(0, 12) + '\u2026';
  return engine.fmt(String(atoms), hex) + ' ' + t + ' (' + atoms + ' atoms)';
}

// A site's orders go to the user composer's engine in user mode, once the wallet has joined the
// operator its user mode runs on.
async function userTrades() {
  return (await leaves.mode()) === 'user' && !!(await leaves.config().catch(() => null));
}

// ---- the method table ----
export async function handleDappRequest(origin, method, params = {}) {
  if (!origin || !/^https?:\/\//.test(origin)) throw new Error('bad origin');

  switch (method) {
    case 'getCapabilities':
      return {
        provider: 'sequentia-wallet-extension',
        version: chrome.runtime.getManifest().version,
        network: engine.getNetworkName(),
        methods: ['connect', 'getAccounts', 'getNetwork', 'getBalances', 'getAddress',
          'signPset', 'signMessage', 'signStakerMessage', 'getStakerPublicKey',
          'broadcast', 'createInvoice', 'payInvoice',
          'getUtxos', 'lnChannels', 'lnRequestInbound', 'dexFillOnchain', 'dexSwapLn', 'dexJobResult', 'dexMarketOrder', 'dexPlaceLimit', 'placeOrder', 'getOrders', 'cancelOrder', 'getBtcPublicKey', 'getBtcAddress', 'signBtcTaproot', 'prepareBtcSend',
          'openampGetIdentity', 'openampSignTagged', 'openampSignSpend', 'openampSignSupervision',
          'signContractSpend', 'getContractKey', 'signContractStatement', 'getWalletMode', 'getLeafBalances', 'getLeafAddress', 'requestLeafReceive', 'sendLeaves',
          'boardLeaves', 'exitLeaf', 'getLeafOperator', 'takeOrder', 'getLeafTakes', 'placeOrderFromLeaves', 'getLeafOrders',
          'leafSwapOffer', 'leafSwapAccept', 'leafSwapComplete', 'getLeafSwaps', 'leafSwapCancel',
          'restOrder', 'fillRestingOrder', 'cancelRestingOrder', 'getRestingOrders'],
        // What this build can do beyond the method names, for sites that have
        // to know before they build something: 'pset-site-built' means
        // signPset fills in this wallet's key origins itself, so a PSET a site
        // composed (with only the outputs it spends) can be signed here.
        // 'contract-spend' means signContractSpend runs the kit's contract engine.
        // 'leaves' means the leaf methods (getLeafBalances, getLeafAddress,
        // requestLeafReceive, sendLeaves, boardLeaves, exitLeaf) and their events are
        // served, in developer mode; 'leaf-orders' the methods that fill an on-chain
        // order from leaves and place one from them (getLeafOperator, takeOrder,
        // getLeafTakes, placeOrderFromLeaves, getLeafOrders) and the leafTake event;
        // 'leaf-swaps' the in-tree swap between two wallets holding leaves
        // (leafSwapOffer, leafSwapAccept, leafSwapComplete, getLeafSwaps, leafSwapCancel).
        // 'resting-orders' the orders resting as leaves in the operator's tree, filled
        // there with their makers away (restOrder, fillRestingOrder, cancelRestingOrder,
        // getRestingOrders).
        // 'orders' means the market and limit orders the wallet settles its own way
        // (placeOrder, getOrders, cancelOrder), in either mode. 'balances-total' means
        // getBalances answers `total` and `arriving` (and `by_place` in developer mode).
        // ORDER_FEATURES name placeOrder's limit options (post only, rest: false, min_fill,
        // take_back_after), served in either mode.
        features: ['pset-site-built', 'contract-spend', 'leaves', 'leaf-orders', 'leaf-swaps', 'resting-orders', 'orders', 'balances-total', ...ORDER_FEATURES],
        events: ['accountsChanged', 'disconnect', 'modeChanged', 'leafArrived', 'leafSyncDue', 'leafTake'],
      };

    case 'getNetwork':
      // The genesis hash names the chain a contract instance must be for.
      return { network: engine.getNetworkName(), genesis: engine.getNetwork().genesisBlockHash() };

    case 'debugState': {
      // Diagnostic read (no secrets): last crash breadcrumb + heartbeat.
      return {
        lastError: await stGet('local', 'ext.lastError'),
        heartbeat: await stGet('local', 'ext.heartbeat'),
      };
    }

    case 'getAccounts': {
      // Silent: never prompts. Empty until connected AND unlocked.
      if (!(await perms.isConnected(origin))) return { accounts: [] };
      if (!(await sessionMnemonic())) return { accounts: [] };
      await engine.ensureOpen();
      return { accounts: [await accountInfo()] };
    }

    case 'connect': {
      if (await perms.isConnected(origin)) {
        if (!(await sessionMnemonic())) {
          // Connected but locked: the approval window doubles as an unlock prompt.
          return requestApproval(origin, 'unlock', { text: 'Unlock your wallet to continue with ' + origin }, async () => {
            await engine.ensureOpen();
            return await accountInfo();
          });
        }
        await engine.ensureOpen();
        return await accountInfo();
      }
      return requestApproval(origin, 'connect', {
        text: origin + ' wants to connect to your wallet. It will see your address, balances, and activity, and may request signatures (each shown for approval).',
      }, async () => {
        await engine.ensureOpen();
        await perms.grant(origin);
        return await accountInfo();
      });
    }

    case 'getBalances': {
      await requireUnlockedAndConnected(origin);
      await engine.syncIfStale();
      const b = await engine.balances();
      const oamp = {};
      for (const [id, atoms] of Object.entries(openamp.balancesMap())) oamp['oamp:' + id] = atoms;
      // What is held as leaves and spendable now, in either mode: in user mode the wallet's
      // coins are boarded within a minute, so this is most of what it can trade.
      const fig = await siteTrade.figures(b, (await leaves.mode()) === 'developer').catch(() => ({}));
      const spendable = (await leaves.config().catch(() => null)) ? await siteTrade.spendable().catch(() => ({})) : {};
      return { assets: b.seq, btc: b.btc, openamp: oamp, leaves: await siteTrade.leafBalances(), spendable, ...fig };
    }

    case 'getUtxos': {
      // Silent read: the DEX composes swap PSETs from these and returns them
      // through signPset, where the user approves the actual spend.
      await requireUnlockedAndConnected(origin);
      await engine.syncIfStale();
      let utxos = engine.utxosSerialized();
      if (params.asset) utxos = utxos.filter((u) => u.asset === params.asset);
      return { utxos };
    }

    case 'lnChannels': {
      // Silent read: per-asset Lightning capacity (the LNDEX prerequisite).
      await requireUnlockedAndConnected(origin);
      const b = await engine.balances();
      return await ln.channelsSerialized(Object.keys(b.seq));
    }

    case 'dexFillOnchain': {
      // Fill a resting same-chain (or confidential-book) order. The wallet
      // re-fetches the offer from the relay and recomputes every amount; the
      // site only names the offer and the take size.
      await requireConnected(origin);
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      const prep = await dex.prepareOnchainFill({
        mount: params.mount === 'conf' ? 'conf' : 'chain',
        base: String(params.base || ''), quote: String(params.quote || ''),
        offerId: String(params.offerId || ''),
        takeBase: String(params.takeBase || '0'),
        confidential: params.mount === 'conf',
      });
      return requestApproval(origin, 'dexFillOnchain', { ...prep.display, text: origin + ' · ' + prep.display.text }, prep.exec);
    }

    case 'dexMarketOrder': {
      await requireConnected(origin);
      const { room = 'ln', base, quote, side, baseAtoms } = params || {};
      if (room !== 'ln') throw new Error("only room 'ln' supports market orders so far");
      if (!/^[0-9a-f]{64}$/i.test(String(base || ''))) throw new Error('base must be a 32-byte hex asset id');
      const prep = await dex.prepareLnMarketOrder({ base: String(base).toLowerCase(), quote, side, baseAtoms });
      return requestApproval(origin, 'dexMarketOrder', { ...prep.display, text: origin + ' · ' + prep.display.text }, prep.exec);
    }
    case 'dexPlaceLimit': {
      await requireConnected(origin);
      const { room = 'ln', base, quote, side, baseAtoms, limitQuoteAtoms } = params || {};
      if (room !== 'ln') throw new Error("only room 'ln' supports wallet-served limit orders so far");
      if (!/^[0-9a-f]{64}$/i.test(String(base || ''))) throw new Error('base must be a 32-byte hex asset id');
      const prep = await dex.prepareLnLimitOrder({ base: String(base).toLowerCase(), quote, side, baseAtoms, limitQuoteAtoms });
      return requestApproval(origin, 'dexPlaceLimit', { ...prep.display, text: origin + ' · ' + prep.display.text }, prep.exec);
    }
    case 'placeOrder': {
      // A market or limit order on one market; the wallet reads the book, chooses how
      // the trade settles and shows one approval (src/market.js). Either mode.
      await requireConnected(origin);
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      // User mode trades as the popup's Trade tab does, from the wallet's leaves (src/site-trade.js).
      if (await userTrades()) {
        const q = await siteTrade.quote(params || {}, origin);
        try { return await requestApproval(origin, 'placeOrder', q.display, () => siteTrade.confirm(q.id, origin)); }
        catch (e) { siteTrade.drop(q.id); throw e; }
      }
      const prep = await market.prepareOrder(origin, params || {});
      return requestApproval(origin, 'placeOrder', prep.display, prep.exec);
    }
    case 'getOrders': {
      // Silent: this site's resting orders and trades, and where each stands.
      await requireUnlockedAndConnected(origin);
      if (await userTrades()) {
        // Both: orders a site placed in developer mode keep being followed in user mode.
        const [a, b] = await Promise.all([siteTrade.orders(origin), market.ordersFor(origin).catch(() => ({ orders: [], trades: [] }))]);
        return { orders: [...a.orders, ...(b.orders || [])], trades: [...a.trades, ...(b.trades || [])] };
      }
      return await market.ordersFor(origin);
    }
    case 'cancelOrder': {
      await requireConnected(origin);
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      if (await userTrades()) {
        let q = null;
        try { q = await siteTrade.quoteCancel(params || {}, origin); } catch (e) { if (!/no such order of this site/.test(String(e && e.message))) throw e; }
        if (q) return requestApproval(origin, 'cancelOrder', q.display, () => siteTrade.confirmCancel(q.id));
      }
      const prep = await market.prepareCancel(origin, params || {});
      return requestApproval(origin, 'cancelOrder', prep.display, prep.exec);
    }
    case 'dexSwapLn': {
      // LNDEX taker swap: both legs over the user's own Lightning channels.
      await requireConnected(origin);
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      const prep = await dex.prepareLnSwap({
        base: String(params.base || ''),
        quote: String(params.quote || 'BTC'),
        offerId: String(params.offerId || ''),
        takeAtoms: params.takeAtoms != null ? String(params.takeAtoms) : undefined,
      });
      return requestApproval(origin, 'dexSwapLn', { ...prep.display, text: origin + ' · ' + prep.display.text }, prep.exec);
    }

    case 'dexJobResult': {
      // Silent poll for a dispatched Lightning-swap job's outcome. Without a
      // jobId, returns the newest job (recovery after a worker restart).
      await requireConnected(origin);
      return await dex.jobResult(params.jobId ? String(params.jobId) : null);
    }

    case 'lnRequestInbound': {
      await requireConnected(origin);
      const kind = params.asset && params.asset !== 'BTC' ? String(params.asset) : 'BTC';
      const atoms = String(params.amount ?? '');
      if (!/^\d+$/.test(atoms) || BigInt(atoms) <= 0n) throw new Error('amount (atoms) is required');
      const ticker = kind === 'BTC' ? 'BTC' : A.assetMeta(kind).ticker;
      return requestApproval(origin, 'lnRequestInbound', {
        text: origin + ' asks your wallet to request inbound Lightning capacity.',
        detail: 'Inbound capacity to receive up to ' + engine.fmt(atoms, kind === 'BTC' ? 'BTC' : kind) + ' ' + ticker + ' over Lightning. This may open or extend a channel to your hosted node.',
      }, async () => { await ensureOpenOrThrow(); return await ln.requestInbound({ kind, atoms }); });
    }

    case 'getAddress': {
      await requireUnlockedAndConnected(origin);
      const a = engine.currentAddress(!!params.confidential);
      return { address: a.address, index: a.index };
    }

    case 'signMessage': {
      await requireConnected(origin);
      const message = String(params.message ?? '');
      if (!message) throw new Error('message is required');
      return requestApproval(origin, 'signMessage', {
        text: origin + ' asks you to sign a message.',
        message,
      }, async () => { await ensureOpenOrThrow(); return { signature: engine.signMessage(message) }; });
    }

    case 'getStakerPublicKey': {
      await requireUnlockedAndConnected(origin);
      return { staker_pubkey: engine.stakerPublicKey() };
    }

    case 'signStakerMessage': {
      // A signature under the STAKING key (m/2/0), in the same base64 form
      // `signMessage` returns. It proves control of the key a stake is bonded
      // to, which a master-key signature cannot. It authorises no payment and
      // cannot move a stake: only a transaction can do either.
      await requireConnected(origin);
      const message = String(params.message ?? '');
      if (!message) throw new Error('message is required');
      return requestApproval(origin, 'signStakerMessage', {
        text: origin + ' asks you to prove you control your staking key.',
        message,
      }, async () => {
        await ensureOpenOrThrow();
        return {
          signature: engine.signStakerMessage(message),
          staker_pubkey: engine.stakerPublicKey(),
        };
      });
    }

    // ---- OpenAMP enclave identity ----
    //
    // The same m/5/0 account this wallet already holds restricted assets in, so
    // a site that builds on it (an issuance platform, a transfer agent) works
    // against the account the user can see in their wallet rather than a second
    // identity of its own. What a site may ask for is deliberately narrow:
    // the public identity, a domain-TAGGED statement, and a co-signature on a
    // transaction it supplies in full. There is no method that signs a digest
    // the site chose, and there must never be one: the enclave key is one half
    // of the 2-of-2 restricted assets live in, and a digest signer over it is a
    // signing oracle that drains the account.

    case 'openampGetIdentity': {
      // Silent read of public identity: the x-only enclave key and the account
      // id derived from it. Needs an unlocked wallet because the key is derived,
      // not stored.
      await requireUnlockedAndConnected(origin);
      return await openamp.ensureIdentity();
    }

    case 'openampSignTagged': {
      await requireConnected(origin);
      // Validate before prompting: a request that will be refused should never
      // reach the user as a decision to make.
      const req = checkSigningRequest(params);
      const display = {
        text: origin + ' asks you to sign a statement with your OpenAMP account key.',
        rows: [['Domain tag', req.tag]],
      };
      if (req.kind === 'statement') {
        display.message = String(params.statement);
      } else {
        display.rows.push(['Document hash', req.messageHex]);
        if (params.label) display.rows.push(['Named by the site', String(params.label).slice(0, 120)]);
        display.warning = 'This signs a document hash. Only the site can tell you what document it is; check it there before approving.';
      }
      return requestApproval(origin, 'openampSignTagged', display, async () => {
        await ensureOpenOrThrow();
        return openamp.signTagged(req.tag, req.messageHex);
      });
    }

    case 'openampSignSpend': {
      // Co-sign an enclave spend the SITE's backend built and will complete.
      // The site supplies the transaction, never a sighash: every digest signed
      // is recomputed here from the explorer's prevouts and this wallet's own
      // enclave leaf, and the decoded effects below are what the user approves.
      // Unlocked is required up front because the review has to be built before
      // there is anything to show.
      await requireUnlockedAndConnected(origin);
      const { id, review } = await openamp.prepareSpend(params);
      const rows = [];
      if (review.recipientAid) {
        rows.push(['Recipient account', review.recipientAid]);
        rows.push(['Recipient checked', review.paysRecipient === true
          ? 'yes — an output pays this account'
          : review.paysRecipient === false
            ? 'NO — no output pays this account'
            : 'could not be checked']);
      }
      rows.push(['Asset', review.ticker || 'restricted asset']);
      rows.push(['Inputs you sign', String(review.inputs)]);
      const claw = review.leaf === 'claw';
      if (claw) rows.unshift(['Swept from', review.fromAid]);
      const display = {
        text: claw
          ? origin + ' asks you to authorize a clawback: a disclosed seizure of another holder\u2019s' +
            ' balance in this asset, which you can only do as its issuer.'
          : origin + ' asks you to co-sign a restricted-asset transfer out of your OpenAMP account.',
        rows,
        // An enclave spend can carry outputs in another asset (a converted fee),
        // so resolve each one on its own: as a restricted asset first, then as
        // an ordinary Sequentia asset.
        deltas: claw
          ? []
          : review.leaving.map((o) => {
              let m = A.assetMeta('oamp:' + (o.asset || ''));
              if (m.ticker === '?') m = A.assetMeta(o.asset || '');
              return { ticker: m.ticker, atoms: '-' + (o.value ?? '0'), precision: m.precision || 0 };
            }),
      };
      if (review.paysRecipient === false) {
        display.warning = 'No output of this transaction pays the account the site named. Do not approve unless you know why.';
      } else if (review.anyConfidential) {
        display.warning = 'Part of this transaction is confidential and could not be read. Only approve it if you trust this site.';
      }
      return requestApproval(origin, 'openampSignSpend', display, async () => {
        await ensureOpenOrThrow();
        return openamp.completeSpend(id);
      });
    }

    case 'openampSignSupervision': {
      // Authorize a freeze, a pause or a lift on a supervised asset this wallet
      // is the operational key for. As everywhere else, the site does not choose
      // the bytes: the wallet rebuilds the node's message from the asset, the
      // address and the outpoint below, and signs its own reconstruction. A site
      // that misdescribes any of them produces a signature the network rejects
      // rather than a freeze the issuer did not intend.
      await requireUnlockedAndConnected(origin);
      const { id, review } = openamp.prepareSupervision(params);
      const verb = review.kind === 'freeze' ? 'freeze a holder of'
        : review.kind === 'pause' ? 'PAUSE every holding of'
        : 'lift the freeze on a holder of';
      const rows = [
        ['Action', review.kind === 'freeze' ? 'Freeze' : review.kind === 'pause' ? 'Pause the whole asset' : 'Lift a freeze'],
        ['Asset', (review.ticker || 'supervised asset') + ' (' + review.asset.slice(0, 12) + '…)'],
      ];
      if (review.address) rows.push(['Address', review.address]);
      rows.push([review.kind === 'unfreeze' ? 'Freeze record' : 'Bound to input', review.outpoint]);
      const display = {
        text: origin + ' asks you to ' + verb + ' this asset, as its issuer. The network enforces it.',
        rows,
      };
      if (review.kind === 'pause') {
        display.warning = 'A pause stops EVERY single-owner holding of this asset at once, not one address.';
      }
      return requestApproval(origin, 'openampSignSupervision', display, async () => {
        await ensureOpenOrThrow();
        return openamp.completeSupervision(id);
      });
    }

    case 'signPset': {
      await requireConnected(origin);
      const psetB64 = String(params.pset ?? '');
      if (!psetB64) throw new Error('pset is required');
      const effect = engine.describePset(psetB64);
      const display = { text: origin + ' asks you to sign a Sequentia transaction (PSET).', pset: psetB64.slice(0, 120) + '…' };
      if (effect && effect.deltas) {
        display.deltas = Object.entries(effect.deltas).map(([h, v]) => ({
          ticker: A.assetMeta(h).ticker, atoms: v, precision: A.assetMeta(h).precision || 0,
        }));
        if (effect.fee != null) display.fee = effect.fee;
      } else {
        display.warning = 'The wallet could not fully decode this PSET; only sign it if you trust this site.';
      }
      return requestApproval(origin, 'signPset', display, async () => { await ensureOpenOrThrow(); return { pset: await engine.signPset(psetB64) }; });
    }

    case 'getContractKey': {
      // The wallet's contract key: the x-only key a capped sale lists as a buyer's,
      // or an escrow names as its issuer's. Public; signContractSpend signs with it
      // only through the five-point approval.
      await requireUnlockedAndConnected(origin);
      return contracts.contractKey();
    }

    case 'signContractStatement': {
      // A statement signed with the contract key, to prove it to a platform that
      // names it in a contract (an escrow's release key). Tagged, under the same
      // policy as the OpenAMP signer: no consensus tag, nothing that cannot be shown.
      await requireConnected(origin);
      const req = checkSigningRequest(params);
      const display = {
        text: origin + ' asks you to sign a statement with your contract key, the key your contracts name.',
        rows: [['Domain tag', req.tag]],
        warning: 'This proves you hold your contract key. It moves no coin: a spend is signed only on the approval of that spend.',
      };
      if (req.kind === 'statement') display.message = String(params.statement);
      else {
        display.rows.push(['Document hash', req.messageHex]);
        if (params.label) display.rows.push(['Named by the site', String(params.label).slice(0, 120)]);
      }
      return requestApproval(origin, 'signContractStatement', display, async () => {
        await ensureOpenOrThrow();
        return contracts.signStatement(req.tag, req.messageHex);
      });
    }

    case 'signContractSpend': {
      // A spend of a contract (a sequentia-contracts template), under the five-point
      // rule: the engine refuses what it cannot account for before any approval opens,
      // and the approval signs only the digest of the summary it showed.
      await requireConnected(origin);
      await ensureOpenOrThrow();
      const prepared = await contracts.prepareForSite(params);
      return requestApproval(origin, 'signContractSpend', contracts.display(origin, prepared.summary),
        async (shown) => { await ensureOpenOrThrow(); return contracts.signShown(prepared, shown, { broadcastIt: params.broadcast !== false }); });
    }

    case 'broadcast': {
      // Relaying an ALREADY-SIGNED transaction to the network; signing itself
      // was the approved step, so no extra prompt here.
      await requireUnlockedAndConnected(origin);
      return engine.broadcastRaw({ chain: params.chain, hex: params.hex, psetB64: params.pset });
    }

    case 'createInvoice': {
      await requireConnected(origin);
      const kind = params.asset && params.asset !== 'BTC' ? String(params.asset) : 'BTC';
      const atoms = String(params.amount ?? '');
      if (!/^\d+$/.test(atoms) || BigInt(atoms) <= 0n) throw new Error('amount (atoms) is required');
      const ticker = kind === 'BTC' ? 'BTC' : A.assetMeta(kind).ticker;
      return requestApproval(origin, 'createInvoice', {
        text: origin + ' asks your wallet to create a Lightning invoice.',
        detail: 'Receive ' + engine.fmt(atoms, kind === 'BTC' ? 'BTC' : kind) + ' ' + ticker + ' over Lightning.',
      }, async () => { await ensureOpenOrThrow(); return await ln.createInvoice({ kind, atoms, memo: params.memo ? String(params.memo).slice(0, 90) : undefined }); });
    }

    case 'payInvoice': {
      await requireConnected(origin);
      const bolt11 = String(params.bolt11 ?? '');
      if (!bolt11) throw new Error('bolt11 is required');
      const kind = params.asset && params.asset !== 'BTC' ? String(params.asset) : 'BTC';
      const ticker = kind === 'BTC' ? 'BTC' : A.assetMeta(kind).ticker;
      return requestApproval(origin, 'payInvoice', {
        text: origin + ' asks you to pay a Lightning invoice from your ' + ticker + ' balance.',
        bolt11: bolt11.slice(0, 90) + (bolt11.length > 90 ? '…' : ''),
      }, async () => { await ensureOpenOrThrow(); return await ln.payInvoice({ kind, bolt11 }); });
    }

    // ---- the wallet's mode, and leaves (developer mode) ----
    //
    // The leaf wallet is the operator wallet library in the offscreen document
    // (src/leaves.js, offscreen-leaves.js): every answer and refusal is the library's,
    // passed on in its words.

    case 'getWalletMode':
      // Silent and needs no connection: a site chooses its layout before it connects.
      return { mode: await leaves.mode() };

    case 'getLeafBalances': {
      await requireUnlockedAndConnected(origin);
      await leaves.requireLeaves();
      const balance = await leaves.run('balance');
      const schedule = await leaves.run('schedule').catch(() => null);
      return leafBalancesAnswer(balance, schedule);
    }

    case 'requestLeafReceive': {
      await requireConnected(origin);
      const asset = params.asset != null && params.asset !== '' ? String(params.asset).toLowerCase() : null;
      if (asset && !/^[0-9a-f]{64}$/.test(asset)) throw new Error('asset must be a 64-hex asset id');
      const amount = params.amount != null && params.amount !== '' ? String(params.amount) : null;
      if (amount != null && (!/^\d+$/.test(amount) || BigInt(amount) <= 0n)) throw new Error('amount must be a positive number of atoms');
      // Mode and operator are checked before the window opens: a request that will be
      // refused should never reach the user as a decision to make.
      if ((await leaves.mode()) !== 'developer') throw new Error(leaves.NOT_DEVELOPER);
      if (!(await leaves.config())) throw new Error(leaves.NOT_JOINED);
      const m = asset ? A.assetMeta(asset) : null;
      return requestApproval(origin, 'requestLeafReceive', {
        text: origin + ' asks your wallet for a receive request for leaves: a single-use request a payer pays out of round, with no transaction.',
        rows: [
          ['Asset', asset ? (m.ticker && m.ticker !== '?' ? m.ticker + ' (' + asset.slice(0, 12) + '…)' : asset) : 'any (the payer names it)'],
          ['Amount', amount != null ? (asset ? engine.fmt(amount, asset) + ' ' + (m.ticker || '') : amount + ' atoms') : 'any (the payer names it)'],
        ],
        detail: 'The payment arrives in your wallet’s mailbox, which the wallet reads while it runs. The request lapses after a while; nobody can pay it after that.',
      }, async () => {
        await ensureOpenOrThrow();
        await leaves.requireLeaves();
        const args = {};
        if (asset) args.asset = asset;
        if (amount != null) args.amount = amount;
        return await leaves.run('receive', args);
      });
    }

    case 'sendLeaves': {
      await requireConnected(origin);
      const text = String(params.request ?? '');
      if (!text) throw new Error('request is required');
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      // Read the request to SHOW it; the library pays it, handed the asset and the
      // amount shown, and refuses whatever does not match the request.
      const req = readRequest(text);
      const info = await leaves.run('info');
      const plan = planSend(req, { asset: params.asset, amount: params.amount }, info);
      const m = A.assetMeta(plan.asset);
      const ticker = m.ticker && m.ticker !== '?' ? m.ticker : plan.asset.slice(0, 12) + '…';
      const rows = [
        ['Asset', ticker + ' (' + plan.asset + ')'],
        ['Receiver’s leaf key', plan.owner],
        ['Receiver’s mailbox', plan.mailbox],
      ];
      if (plan.until != null) rows.push(['Request lapses', new Date(plan.until * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') + ' (median time)']);
      return requestApproval(origin, 'sendLeaves', {
        text: origin + ' asks you to pay a receive request from your leaves, out of round: no transaction, and nothing paid to the operator. The coins spent keep a margin of the same asset for the fees of taking them on-chain.',
        deltas: [{ ticker, atoms: '-' + plan.amount, precision: m.precision || 0 }],
        rows,
      }, async () => {
        await ensureOpenOrThrow();
        return await leaves.run('send', { request: text, asset: plan.asset, amount: plan.amount });
      });
    }

    case 'getLeafAddress': {
      await requireUnlockedAndConnected(origin);
      return await leaves.address();
    }

    // A board and an exit: the library quotes the fee first, the window shows it, and
    // the library goes ahead only on the fee shown (it refuses if the fee changed).
    case 'boardLeaves': {
      await requireConnected(origin);
      const asset = String(params.asset ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(asset)) throw new Error('asset must be a 64-hex asset id');
      const amount = String(params.amount ?? '');
      if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error('amount must be a positive number of atoms');
      const feeAsset = params.fee_asset != null && params.fee_asset !== '' ? String(params.fee_asset).toLowerCase() : null;
      if (feeAsset && !/^[0-9a-f]{64}$/.test(feeAsset)) throw new Error('fee_asset must be a 64-hex asset id');
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      const args = { asset, amount };
      if (feeAsset) args.fee_asset = feeAsset;
      const quote = await leaves.run('board_quote', args);
      const fee = quote.fee || {};
      return requestApproval(origin, 'boardLeaves', {
        text: origin + ' asks you to board an on-chain coin into your leaves: one transaction from your leaf wallet\u2019s on-chain coins to the operator\u2019s tree. The coin is a leaf once the transaction is final.',
        rows: [
          ['Asset', leafAsset(asset)],
          ['Amount boarded', leafAmount(amount, asset)],
          ['Fee', leafAmount(fee.amount, fee.asset) + ' (the node\u2019s floor now, in the fee asset\u2019s own atoms)'],
          ['Transaction', quote.vsize + ' vB, spending ' + quote.inputs + ' coin(s)'],
        ],
        detail: 'The board goes ahead only on the fee shown. If it has changed by the time the wallet signs, nothing is signed and the site hears why.',
      }, async () => {
        await ensureOpenOrThrow();
        return await leaves.run('board', { ...args, shown: fee });
      });
    }

    case 'exitLeaf': {
      await requireConnected(origin);
      const leafId = String(params.leaf_id ?? '');
      if (!leafId) throw new Error('leaf_id is required');
      const feeAsset = params.fee_asset != null && params.fee_asset !== '' ? String(params.fee_asset).toLowerCase() : null;
      if (feeAsset && !/^[0-9a-f]{64}$/.test(feeAsset)) throw new Error('fee_asset must be a 64-hex asset id');
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      const args = { leaf_id: leafId };
      if (feeAsset) args.fee_asset = feeAsset;
      const quote = await leaves.run('exit_quote', args);
      const rows = [
        ['Leaf', leafId],
        ['Coin', leafAmount(quote.value, quote.asset)],
      ];
      (quote.steps || []).forEach((st, i) => {
        const fees = (st.fee || []).map((f) => leafAmount(f.amount, f.asset)).join(' + ') || 'none';
        rows.push(['Transaction ' + (i + 1), st.vsize + ' vB, fee ' + fees + ', paid from ' + st.paid_by]);
      });
      if (!(quote.steps || []).length) rows.push(['Now', 'nothing to broadcast before the claim']);
      const claim = quote.claim || {};
      rows.push(['Claim, later', claim.error ? claim.error
        : 'fee about ' + ((claim.fee || []).map((f) => leafAmount(f.amount, f.asset)).join(' + ') || 'none') + ' at the floor when it is made'
          + (claim.pays ? ', paying ' + leafAmount(claim.pays, quote.asset) + ' to this wallet' : '')]);
      if (quote.exit_delay_seconds != null) rows.push(['Exit delay', Math.round(quote.exit_delay_seconds / 3600 * 10) / 10 + ' h after the leaf\u2019s transaction is in a block']);
      return requestApproval(origin, 'exitLeaf', {
        text: origin + ' asks you to take a leaf home on-chain by yourself, without the operator: the transactions of its path now, then, once its exit delay has run, the claim to one of your addresses. The wallet carries the exit on by itself until the claim is final.',
        rows,
        detail: 'Fees are each asset\u2019s own atoms at the node\u2019s floor now. The path is broadcast only on the fees shown; if they have changed, nothing is broadcast and the site hears why.',
      }, async () => {
        await ensureOpenOrThrow();
        const run = { leaf_id: leafId, shown: quote.unroll || {} };
        if (quote.fee_asset) run.fee_asset = quote.fee_asset;
        return await leaves.run('exit', run);
      });
    }

    // ---- on-chain orders filled from leaves and placed from them ----

    case 'getLeafOperator': {
      await requireUnlockedAndConnected(origin);
      await leaves.requireLeaves();
      return await leafTrade.operator();
    }

    // A take: the library reads the order on its own node (its script from the terms,
    // unspent, final) and prices the fill by the covenant's arithmetic; the window shows
    // that quote, and the take goes ahead only on the fill, price and fee shown.
    case 'takeOrder': {
      await requireConnected(origin);
      const served = params.order;
      if (!served || typeof served !== 'object' || !(served.covenant || served.covenant_txid)) {
        throw new Error('order must be the relay’s offer of an on-chain order (its covenant terms)');
      }
      const amount = params.amount != null && params.amount !== '' ? String(params.amount) : null;
      if (amount != null && (!/^\d+$/.test(amount) || BigInt(amount) <= 0n)) throw new Error('amount must be a positive number of atoms');
      const maxFee = params.max_fee_ppm != null && params.max_fee_ppm !== '' ? String(params.max_fee_ppm) : null;
      if (maxFee != null && !/^\d+$/.test(maxFee)) throw new Error('max_fee_ppm must be a whole number');
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      const args = { order: served };
      if (amount != null) args.amount = amount;
      if (maxFee != null) args.max_fee_ppm = maxFee;
      const quote = await leaves.run('take_quote', args);
      const op = await leafTrade.operator();
      const win = op.forfeit_window_seconds;
      const a = quote.asset_a, b = quote.asset_b;
      const tick = (h) => { const m = A.assetMeta(h); return m.ticker && m.ticker !== '?' ? m.ticker : h.slice(0, 12) + '…'; };
      const rows = [
        ['Order', quote.order + ' (on the chain; the wallet found it on its own node, unspent and final)'],
        ['You get', leafAmount(quote.filled, a) + ' as a leaf, in the round’s batch, once the round is final'],
        ['You give', leafAmount(quote.gives, b) + ': the price and the operator’s fee, from your leaves'],
        ['Price', leafAmount(quote.price, b) + ', paid on the chain to the order’s maker'],
        ['Operator’s fee', leafAmount(quote.fee, b) + ' (its schedule for this asset)'],
        ['Order after the fill', BigInt(quote.remainder) > 0n ? leafAmount(quote.remainder, a) + ' rests again on the chain, under the same terms' : 'filled whole'],
        ['Operator', op.operator || '?'],
      ];
      if (quote.pays_itself_first) rows.push(['First', 'no single leaf holds exactly ' + leafAmount(quote.gives, b) + ': the wallet first pays itself one out of round, with nothing paid to the operator']);
      rows.push(['Your part', 'Once the operator builds the round, this wallet hands over the forfeit of the coin it gives, within '
        + (win != null ? Math.round(win / 60) + ' minutes' : 'the operator’s window') + '. Keep the browser running with the wallet unlocked until then; closing this window or the popup is fine. If the forfeits do not come in time, the take is voided and your coins are yours again.']);
      return requestApproval(origin, 'takeOrder', {
        text: origin + ' asks you to fill an on-chain order from your leaves, through the operator’s round: the round spends the order, pays its maker on the chain and pays you a leaf.',
        deltas: [{ ticker: tick(b), atoms: '-' + quote.gives, precision: A.assetMeta(b).precision || 0 },
          { ticker: tick(a), atoms: String(quote.filled), precision: A.assetMeta(a).precision || 0 }],
        rows,
        detail: 'The fill is final once the round’s block is certified and its Bitcoin anchor buried. If Bitcoin reorganises below it, so does Sequentia, and the fill is undone until the round is mined again. The take goes ahead only on the fill, price and fee shown.',
      }, async () => {
        await ensureOpenOrThrow();
        return await leafTrade.take(origin, served, args, quote, win);
      });
    }

    case 'getLeafTakes': {
      await requireUnlockedAndConnected(origin);
      await leaves.requireLeaves();
      return { takes: await leafTrade.takesFor(origin) };
    }

    // An order placed from leaves: an offboard of exactly its amount into the address
    // its terms make, through the operator's round; the wallet lists it on the relay
    // once it rests there. The library quotes the placement first; the window shows the
    // quote, and the order is placed only on the fee shown.
    case 'placeOrderFromLeaves': {
      await requireConnected(origin);
      const hex64 = (v, name) => { const x = String(v ?? '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(x)) throw new Error(name + ' must be a 64-hex asset id'); return x; };
      const pos = (v, name) => { const x = String(v ?? ''); if (!/^\d+$/.test(x) || BigInt(x) <= 0n) throw new Error(name + ' must be a positive whole number'); return x; };
      const args = {
        sell: hex64(params.sell, 'sell'), want: hex64(params.want, 'want'),
        amount: pos(params.amount, 'amount'), rate_num: pos(params.rate_num, 'rate_num'), rate_den: pos(params.rate_den, 'rate_den'),
      };
      if (args.sell === args.want) throw new Error('an order sells one asset for another');
      if (params.min_lot != null && params.min_lot !== '') args.min_lot = pos(params.min_lot, 'min_lot');
      if (params.max_fee_ppm != null && params.max_fee_ppm !== '') args.max_fee_ppm = pos(params.max_fee_ppm, 'max_fee_ppm');
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      if (params.expiry != null && params.expiry !== '') args.expiry = pos(params.expiry, 'expiry');
      else {
        // A day ahead of the chain's median time unless the site names when the order may be refunded.
        const sch = await leaves.run('schedule');
        args.expiry = String(Number(sch.now) + 86400);
      }
      const quote = await leaves.run('order_quote', args);
      const fee = quote.fee || {};
      const refundAt = new Date(Number(quote.expiry_locktime ?? args.expiry) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
      return requestApproval(origin, 'placeOrderFromLeaves', {
        text: origin + ' asks you to place an order on the chain from your leaves: the operator’s round pays exactly the order’s amount into the order’s own address, where it rests with you offline until someone fills it, and the wallet lists it on the order book.',
        deltas: [{ ticker: (A.assetMeta(args.sell).ticker || args.sell.slice(0, 12)), atoms: '-' + args.amount, precision: A.assetMeta(args.sell).precision || 0 }],
        rows: [
          ['Sell', leafAmount(args.amount, args.sell)],
          ['For', leafAmount(quote.full_price, args.want) + ' if filled whole; ' + args.rate_num + ' of it for every ' + args.rate_den + ' sold, each fill rounded up'],
          ['Smallest fill', leafAmount(quote.min_lot ?? args.min_lot ?? args.amount, args.sell)],
          ['Paid to', String(quote.credits_to || 'the order’s own key')],
          ['Fee', leafAmount(fee.amount, fee.asset || args.sell) + ' (the coins’ refresh ' + (fee.refresh ?? '?') + ', the offboard ' + (fee.offboard ?? '?') + ', the unlock margin ' + (fee.unlock_margin ?? '?') + ')'],
          ['Change', quote.change && BigInt(quote.change) > 0n ? leafAmount(quote.change, args.sell) + ' back as a leaf' : 'none'],
          ['Refund', 'what rests unfilled can be taken back from ' + refundAt + ' (median time), and not before: the order cannot be cancelled earlier'],
          ['Listed at', leafTrade.RELAY],
        ],
        detail: 'The order rests once the round is final and the offboard unlocked into its address; the wallet then lists it at the relay and keeps it listed while it rests. The order is placed only on the fee shown.',
      }, async () => {
        await ensureOpenOrThrow();
        return await leafTrade.place(origin, args, quote);
      });
    }

    // An in-tree swap (src/leaf-swap.js). The maker's offer holds its coins and signs
    // nothing; the window shows what the library says it gives, gets and pays, and a
    // rejected offer is cancelled at once, so its coins are free again.
    case 'leafSwapOffer': {
      await requireConnected(origin);
      const hex64 = (v, name) => { const x = String(v ?? '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(x)) throw new Error(name + ' must be a 64-hex asset id'); return x; };
      const pos = (v, name) => { const x = String(v ?? ''); if (!/^\d+$/.test(x) || BigInt(x) <= 0n) throw new Error(name + ' must be a positive number of atoms'); return x; };
      const args = { give_asset: hex64(params.give_asset, 'give_asset'), give: pos(params.give, 'give'),
        want_asset: hex64(params.want_asset, 'want_asset'), want: pos(params.want, 'want') };
      if (args.give_asset === args.want_asset) throw new Error('a swap exchanges two assets');
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      const o = await leaves.run('swap_offer', args);
      try {
        return await requestApproval(origin, 'leafSwapOffer', {
          text: origin + ' asks you to offer a swap to another wallet that holds leaves of your operator: one reassignment in the tree moves both assets at once, once the other wallet accepts and you complete it.',
          deltas: [{ ticker: (A.assetMeta(o.gives.asset).ticker || o.gives.asset.slice(0, 12)), atoms: '-' + o.gives.value, precision: A.assetMeta(o.gives.asset).precision || 0 },
            { ticker: (A.assetMeta(o.gets.asset).ticker || o.gets.asset.slice(0, 12)), atoms: String(o.gets.value), precision: A.assetMeta(o.gets.asset).precision || 0 }],
          rows: leafSwap.offerRows(o, leafAmount),
          detail: 'Approving hands the offer to the site, which passes it to the other wallet. Nothing is signed until you complete the swap with its acceptance; rejecting cancels the offer and frees your coins.',
        }, async () => {
          await leafSwap.remember(o.swap, { origin, role: 'maker', swap: o.swap, gives: o.gives, gets: o.gets, pays: o.pays, at: Date.now() });
          return { swap: o.swap, offer: o.offer, gives: o.gives, gets: o.gets, pays: o.pays };
        });
      } catch (e) {
        await leaves.run('swap_cancel', { swap: o.swap }).catch(() => {});
        throw e;
      }
    }

    // The taker's side: the library reads the offer (signing, holding and storing
    // nothing); the window shows that; the acceptance is signed only on those terms.
    case 'leafSwapAccept': {
      await requireConnected(origin);
      const offer = String(params.offer ?? '').trim();
      if (!offer) throw new Error('offer is required: the other wallet\u2019s offer text');
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      const r = await leaves.run('swap_read', { offer });
      return requestApproval(origin, 'leafSwapAccept', {
        text: origin + ' asks you to accept another wallet\u2019s swap: one reassignment in the tree, which you sign now and the other wallet completes.',
        deltas: [{ ticker: (A.assetMeta(r.gives.asset).ticker || r.gives.asset.slice(0, 12)), atoms: '-' + r.gives.value, precision: A.assetMeta(r.gives.asset).precision || 0 },
          { ticker: (A.assetMeta(r.gets.asset).ticker || r.gets.asset.slice(0, 12)), atoms: String(r.gets.value), precision: A.assetMeta(r.gets.asset).precision || 0 }],
        rows: leafSwap.readRows(r, leafAmount),
        detail: 'Your signature covers this swap\u2019s whole set of outputs and nothing else, and is given only on the terms shown. Until the other wallet completes it, the swap can be cancelled: your coins then move to a fresh leaf of your own.',
      }, async () => {
        await ensureOpenOrThrow();
        const a = await leaves.run('swap_accept', { offer, shown: r });
        await leafSwap.remember(a.swap, { origin, role: 'taker', swap: a.swap, gives: r.gives, gets: r.gets, pays: r.pays, at: Date.now() });
        return { swap: a.swap, accept: a.accept, gets: a.gets, gives: a.gives, pays: a.pays };
      });
    }

    // The maker's completion: the window shows the offer this acceptance names, as the
    // library answered it when it was made; the library checks that the acceptance keeps
    // it exactly, then signs and has the operator co-sign.
    case 'leafSwapComplete': {
      await requireConnected(origin);
      const accept = String(params.accept ?? '').trim();
      if (!accept) throw new Error('accept is required: the other wallet\u2019s acceptance text');
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      const id = leafSwap.textSwapId(accept);
      const rec = id ? (await leafSwap.records())[id] : null;
      if (!rec || rec.origin !== origin || rec.role !== 'maker') throw new Error('this acceptance names no swap this site offered from this wallet');
      return requestApproval(origin, 'leafSwapComplete', {
        text: origin + ' asks you to complete your swap with the other wallet\u2019s acceptance: you sign your side of the reassignment and the operator co-signs it.',
        deltas: [{ ticker: (A.assetMeta(rec.gives.asset).ticker || rec.gives.asset.slice(0, 12)), atoms: '-' + rec.gives.value, precision: A.assetMeta(rec.gives.asset).precision || 0 },
          { ticker: (A.assetMeta(rec.gets.asset).ticker || rec.gets.asset.slice(0, 12)), atoms: String(rec.gets.value), precision: A.assetMeta(rec.gets.asset).precision || 0 }],
        rows: leafSwap.completeRows(rec, leafAmount),
        detail: 'The wallet signs only if the acceptance keeps your coins and outputs exactly as offered. Final once a round settles it, its block certified and its Bitcoin anchor buried.',
      }, async () => {
        await ensureOpenOrThrow();
        const d = await leaves.run('swap_complete', { accept });
        return { swap: d.swap, done: true };
      });
    }

    case 'getLeafSwaps': {
      await requireUnlockedAndConnected(origin);
      await leaves.requireLeaves();
      return { swaps: leafSwap.forOrigin(await leaves.run('swaps'), await leafSwap.records(), origin) };
    }

    case 'leafSwapCancel': {
      await requireConnected(origin);
      const swap = String(params.swap ?? '');
      if (!/^[0-9a-f]{64}$/.test(swap)) throw new Error('swap must be a swap id');
      await leaves.requireLeaves();
      const rec = (await leafSwap.records())[swap];
      if (!rec || rec.origin !== origin) throw new Error('this site started no swap ' + swap);
      return requestApproval(origin, 'leafSwapCancel', {
        text: origin + ' asks you to cancel a swap: an offer frees its coins; an accepted swap moves your coins to a fresh leaf of your own, so the acceptance can never complete.',
        rows: leafSwap.completeRows(rec, leafAmount),
      }, async () => {
        await ensureOpenOrThrow();
        return await leaves.run('swap_cancel', { swap });
      });
    }

    // An order resting as a leaf in the operator's tree (src/leaf-resting.js): the
    // library quotes the rest (the coins given up, their refresh fees, the change); the
    // window shows the quote and the order rests only on it. Once its round is final and
    // the wallet has handed over its forfeits, the library publishes it to the operator,
    // the wallet lists it on the relay, and the browser may close.
    case 'restOrder': {
      await requireConnected(origin);
      const hex64 = (v, name) => { const x = String(v ?? '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(x)) throw new Error(name + ' must be a 64-hex asset id'); return x; };
      const pos = (v, name) => { const x = String(v ?? ''); if (!/^\d+$/.test(x) || BigInt(x) <= 0n) throw new Error(name + ' must be a positive whole number'); return x; };
      const args = {
        sell: hex64(params.sell, 'sell'), want: hex64(params.want, 'want'),
        amount: pos(params.amount, 'amount'), rate_num: pos(params.rate_num, 'rate_num'), rate_den: pos(params.rate_den, 'rate_den'),
      };
      if (args.sell === args.want) throw new Error('an order sells one asset for another');
      if (params.min_lot != null && params.min_lot !== '') args.min_lot = pos(params.min_lot, 'min_lot');
      if (params.max_fee_ppm != null && params.max_fee_ppm !== '') args.max_fee_ppm = pos(params.max_fee_ppm, 'max_fee_ppm');
      const whole = leafResting.wholePrice(args.amount, args.rate_num, args.rate_den);
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      if (params.expiry != null && params.expiry !== '') args.expiry = pos(params.expiry, 'expiry');
      else {
        // A week ahead of the chain's median time unless the site names when the
        // order, once landed on the chain, may be refunded.
        const sch = await leaves.run('schedule');
        args.expiry = String(Number(sch.now) + 7 * 86400);
      }
      const quote = await leaves.run('order_rest_quote', args);
      const fee = quote.fee || {};
      const op = await leafTrade.operator();
      const refundAt = new Date(Number(args.expiry) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
      return requestApproval(origin, 'restOrder', {
        text: origin + ' asks you to rest an order in the operator’s tree: the next round makes a leaf of exactly the order’s amount, which takers fill there while you are away, the operator co-signing each fill under the order’s own terms.',
        deltas: [{ ticker: (A.assetMeta(args.sell).ticker || args.sell.slice(0, 12)), atoms: '-' + (BigInt(args.amount) + BigInt(fee.amount || 0)), precision: A.assetMeta(args.sell).precision || 0 }],
        rows: [
          ['You give', leafAmount(args.amount, args.sell) + ' into the order, and the fee below, from your leaves'],
          ['You get', leafAmount(whole.toString(), args.want) + ' if filled whole; ' + args.rate_num + ' of it for every ' + args.rate_den + ' sold, each fill rounded up, paid to you as leaves'],
          ['Smallest fill', leafAmount(quote.min_lot ?? args.min_lot ?? args.amount, args.sell)],
          ['Fee', leafAmount(fee.amount, fee.asset || args.sell) + ' (the refresh fee of the coins given up)'],
          ['Change', quote.change && BigInt(quote.change) > 0n ? leafAmount(quote.change, args.sell) + ' back as a leaf' : 'none'],
          ['Cancel', 'what rests can be taken back with the operator at any time, while the wallet is open'],
          ['Landing', 'if the leaf is ever taken on the chain, it becomes an on-chain order for the same terms, refundable from ' + refundAt + ' (median time)'],
          ['Operator', op.operator || '?'],
          ['Listed at', leafResting.RELAY],
        ],
        detail: 'Keep the wallet open, unlocked, until the round that makes the order is final and the wallet has handed over its forfeits: the order is then published to the operator and listed, and the browser may close. Each fill’s credit is yours at the wallet’s next sync. The order rests only on the fee shown.',
      }, async () => {
        await ensureOpenOrThrow();
        return await leafResting.rest(origin, args, quote);
      });
    }

    // A fill of an order resting in the operator's tree, as a relay served it: the
    // library quotes the fill from the operator's own view of the order, the window
    // shows it, and the fill goes ahead only on it (src/leaf-resting.js).
    case 'fillRestingOrder': {
      await requireConnected(origin);
      const served = leafResting.servedOrder(params.order);
      const amount = params.amount != null && params.amount !== '' ? String(params.amount) : null;
      if (amount != null && (!/^\d+$/.test(amount) || BigInt(amount) <= 0n)) throw new Error('amount must be a positive number of atoms');
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      const op = await leafTrade.operator();
      if (served.operator_key && op.operator && served.operator_key !== String(op.operator).toLowerCase()) {
        throw new Error('this order rests in the tree of operator ' + served.operator_key + ', not of the operator this wallet joined (' + op.operator + ')');
      }
      const quote = await leafResting.fillQuote(served, amount);
      const a = quote.gets.asset, b = quote.fee.asset;
      const tick = (h) => { const m = A.assetMeta(h); return m.ticker && m.ticker !== '?' ? m.ticker : h.slice(0, 12) + '…'; };
      const gives = (BigInt(quote.paid) + BigInt(quote.fee.amount)).toString();
      return requestApproval(origin, 'fillRestingOrder', {
        text: origin + ' asks you to fill an order resting in the operator’s tree, from your leaves: one transfer in the tree, which the operator co-signs, pays the order’s maker and pays you a leaf at once.',
        deltas: [{ ticker: tick(b), atoms: '-' + gives, precision: A.assetMeta(b).precision || 0 },
          { ticker: tick(a), atoms: String(quote.filled), precision: A.assetMeta(a).precision || 0 }],
        rows: [
          ['You get', leafAmount(quote.filled, a) + ' as a leaf, as soon as the operator co-signs the fill'],
          ['You give', leafAmount(gives, b) + ': the price and the fee, from your leaves'],
          ['Price', leafAmount(quote.paid, b) + ', paid to the order’s maker in the tree'],
          ['Fee', leafAmount(quote.fee.amount, b) + ' (the fill transaction’s margin)'],
          ['Change', quote.change && BigInt(quote.change) > 0n ? leafAmount(quote.change, b) + ' back as a leaf' : 'none'],
          ['Order after the fill', quote.remainder != null ? leafAmount(quote.remainder, a) + ' rests again in the tree, under the same terms' : 'filled whole'],
          ['Order', served.order + ', resting at ' + quote.coin + (served.coin && served.coin !== quote.coin ? ' (the operator’s view; the relay listed it at ' + served.coin + ')' : '')],
          ['Operator', op.operator || '?'],
        ],
        detail: 'The leaf you get is operator-confirmed, as any coin paid to you in the tree, and final once the round its order rests on is final, its block certified and its Bitcoin anchor buried. The fill goes ahead only on the amount, price and fee shown: if another taker fills the order first, the wallet fills it where it then rests only for the same amount and price and no higher fee.',
      }, async () => {
        await ensureOpenOrThrow();
        return await leafResting.fill(served, amount, quote);
      });
    }

    // A cancel of an order this site rested from this wallet: what rests comes back to a
    // leaf of the wallet's own, less the transfer's margin; the library quotes it first.
    case 'cancelRestingOrder': {
      await requireConnected(origin);
      const order = String(params.order ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(order)) throw new Error('order must be the order’s id (64 hex)');
      if (!(await sessionMnemonic())) throw new Error('the wallet is locked; open the wallet popup and unlock first');
      await leaves.requireLeaves();
      const rec = await leafResting.recordFor(origin, order);
      const quote = await leaves.run('order_cancel_resting_quote', { order: rec.order || rec.rested_by });
      const a = quote.gets.asset;
      return requestApproval(origin, 'cancelRestingOrder', {
        text: origin + ' asks you to cancel an order resting in the operator’s tree: the coin it rests at moves to a leaf of your own, so no taker can fill it any more.',
        deltas: [{ ticker: (A.assetMeta(a).ticker || a.slice(0, 12)), atoms: '-' + quote.fee.amount, precision: A.assetMeta(a).precision || 0 }],
        rows: [
          ['You give', 'the order’s coin ' + quote.coin + ', holding ' + leafAmount(quote.holds, a)],
          ['You get', leafAmount(quote.gets.amount, a) + ' as a leaf of your own'],
          ['Fee', leafAmount(quote.fee.amount, a) + ' (the transfer’s margin)'],
          ['Order', order],
        ],
        detail: 'Fills made before the cancel stand, and their credits are yours. The relay delists the order. The cancel goes ahead only on the coin and fee shown.',
      }, async () => {
        await ensureOpenOrThrow();
        return await leafResting.cancel(rec, quote);
      });
    }

    case 'getRestingOrders': {
      await requireUnlockedAndConnected(origin);
      await leaves.requireLeaves();
      return { orders: await leafResting.forOrigin(origin) };
    }

    case 'getLeafOrders': {
      await requireUnlockedAndConnected(origin);
      await leaves.requireLeaves();
      return { orders: await leafTrade.ordersFor(origin) };
    }

    case 'getBtcAddress': {
      await requireUnlockedAndConnected(origin);
      return engine.btcReceiveAddress(params.index ?? null);
    }
    case 'getBtcPublicKey': {
      await requireUnlockedAndConnected(origin);
      return { pubkey_x: await engine.pignusBtcPubkey() };
    }
    case 'prepareBtcSend': {
      await requireConnected(origin);
      const address = String(params.address || '');
      const amount = String(params.amount || '');
      if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error('amount (sats) required');
      return requestApproval(origin, 'prepareBtcSend', {
        text: origin + ' asks to fund a Bitcoin collateral output.',
        detail: 'Prepare ' + (Number(amount) / 1e8) + ' BTC to ' + address + '. It is broadcast only after the loan\u2019s release is verified.',
      }, async () => { await ensureOpenOrThrow(); return await engine.pignusPrepareBtcFunding(address, amount); });
    }
    case 'signBtcTaproot': {
      await requireConnected(origin);
      const sighash = String(params.sighash || '');
      if (!/^[0-9a-f]{64}$/i.test(sighash)) throw new Error('sighash must be 32-byte hex');
      const d = params.display || {};
      return requestApproval(origin, 'signBtcTaproot', {
        text: origin + ' asks you to sign the Bitcoin side of a collateral loan.',
        detail: d.detail || 'This signature cannot move funds on its own; it only completes a loan script you agreed to.',
        sighash,
      }, async () => { await ensureOpenOrThrow(); return { signature: await engine.pignusBtcSignTaproot(sighash) }; });
    }
    default:
      throw new Error('unknown method: ' + method);
  }
}
