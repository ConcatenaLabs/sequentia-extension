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
import * as A from './assets.js';
import { sessionMnemonic } from './vault.js';
import { checkSigningRequest } from './tagpolicy.js';
import { stGet } from './util.js';
import * as contracts from './contracts.js';
import * as leaves from './leaves.js';
import { readRequest, planSend, leafBalancesAnswer } from './leaf-request.js';

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
          'getUtxos', 'lnChannels', 'lnRequestInbound', 'dexFillOnchain', 'dexSwapLn', 'dexJobResult', 'dexMarketOrder', 'dexPlaceLimit', 'getBtcPublicKey', 'getBtcAddress', 'signBtcTaproot', 'prepareBtcSend',
          'openampGetIdentity', 'openampSignTagged', 'openampSignSpend', 'openampSignSupervision',
          'signContractSpend', 'getWalletMode', 'getLeafBalances', 'requestLeafReceive', 'sendLeaves'],
        // What this build can do beyond the method names, for sites that have
        // to know before they build something: 'pset-site-built' means
        // signPset fills in this wallet's key origins itself, so a PSET a site
        // composed (with only the outputs it spends) can be signed here.
        // 'contract-spend' means signContractSpend runs the kit's contract engine.
        // 'leaves' means the leaf methods (getLeafBalances, requestLeafReceive,
        // sendLeaves) and their events are served, in developer mode.
        features: ['pset-site-built', 'contract-spend', 'leaves'],
        events: ['accountsChanged', 'disconnect', 'modeChanged', 'leafArrived', 'leafSyncDue'],
      };

    case 'getNetwork':
      return { network: engine.getNetworkName() };

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
      return { assets: b.seq, btc: b.btc, openamp: oamp };
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
