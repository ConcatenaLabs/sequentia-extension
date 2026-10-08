// Contract spends a website asks for (provider method `signContractSpend`).
//
// A site names a template (one the kit carries, by hash; a template the site supplies
// is read, but it is never on this wallet's list, so the engine refuses to sign for
// it), an instance, and either a drip of the faucet drip covenant or a spend request.
// The kit's contract engine builds the spend, checks the chain's locks, runs the
// program against the final transaction, and checks the five-point rule; a spend it
// refuses, an output it cannot account for among them, is refused to the site with the
// engine's reason before any approval opens. The approval page shows the engine's
// summary (vendor/contracts.js approvalSections); approving signs the digest of what
// the page showed, nothing else.

import * as lwk from '../pkg/lwk_wasm.js';
import * as engine from './engine.js';
import * as A from './assets.js';
import { BASE, ESPLORA } from './config.js';
import { prepare, prepareDrip, sign, broadcast, approvalSections } from '../vendor/contracts.js';

// The wallet's list of templates is the kit's: a site cannot add one.
const noStore = { getItem: () => null, setItem() {}, removeItem() {} };

function hexOf(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }

export function context() {
  return {
    lwk,
    network: () => engine.getNetwork(),
    signer: () => engine.getSigner(),
    esploraFetch: (path, opts) => fetch(ESPLORA + path, opts),
    registryFetch: (path) => fetch(BASE + '/registry' + path, { cache: 'no-store' }),
    walletScripts: () => {
      const w = engine.getWollet();
      let next = 0;
      try { next = w.address(undefined).index(); } catch {}
      const out = [];
      for (let i = 0; i <= next + 1; i++) {
        const a = w.address(i).address();
        out.push(hexOf((a.toUnconfidential ? a.toUnconfidential() : a).scriptPubkey().bytes()));
      }
      return out;
    },
    receiveAddress: () => engine.currentAddress(false).address,
    assetMeta: (h) => A.assetMeta(h),
    store: noStore,
  };
}

function template(params) {
  if (params.templateHash) return lwk.ContractTemplate.known(String(params.templateHash));
  if (params.descriptor) {
    const d = typeof params.descriptor === 'string' ? params.descriptor : JSON.stringify(params.descriptor);
    return new lwk.ContractTemplate(d, JSON.stringify(params.sources || {}));
  }
  throw new Error('templateHash (a template the wallet carries) or descriptor and sources is required');
}

const errText = (e) => (e && (e.message || (typeof e.toString === 'function' && e.toString()))) || String(e);

// The engine's approval of what the site asked, or its refusal.
export async function prepareForSite(params) {
  if (!lwk.ContractApproval) throw new Error('this wallet build has no contract engine');
  const ctx = context();
  try {
    const t = template(params);
    const instanceJson = typeof params.instance === 'string' ? params.instance : JSON.stringify(params.instance || null);
    if (params.drip) {
      const d = params.drip;
      return { ctx, ...(await prepareDrip(ctx, { template: t, instanceJson, coin: d.coin, to: d.to || ctx.receiveAddress(), amount: String(d.amount), ratePerKvb: String(d.ratePerKvb ?? 1000) })) };
    }
    if (!params.request) throw new Error('request (or drip) is required');
    return { ctx, ...(await prepare(ctx, { template: t, instanceJson, request: params.request })) };
  } catch (e) {
    throw new Error(errText(e));
  }
}

// What the approval page renders.
export function display(origin, summary) {
  return {
    text: origin + ' asks you to sign a spend of a contract.',
    sections: approvalSections(summary),
    digest: summary.digest,
  };
}

// Signs what the page showed and, unless the site asked otherwise, broadcasts it.
export async function signShown(prepared, shownDigest, { broadcastIt = true } = {}) {
  if (shownDigest !== prepared.summary.digest) throw new Error('the approval shown is not this spend; nothing was signed');
  const hex = sign(prepared.ctx, prepared.approval, { digest: shownDigest });
  if (!broadcastIt) return { hex };
  const txid = await broadcast(prepared.ctx, hex);
  return { txid, hex };
}
