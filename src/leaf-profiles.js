// What an operator's profiles mean for what the wallet shows: pure rules over the leaf
// wallet library's answers, shared by the offscreen host, the service worker, the popup
// and the tests. The web wallet's leaves.js holds the same rules and the same words; the
// words a person reads are the same in the web wallet, Ambra and this extension, so change
// them in all three together. Nothing here decides anything about a coin: the library
// holds a supervised asset's coins as landing-1 leaves, checks them, and refuses.

const big = (v) => { try { return BigInt(v || 0); } catch { return 0n; } };

// The states in which a coin is still the wallet's (held, or on its way somewhere).
const HELD = new Set(['pending', 'live', 'offered', 'sending', 'given', 'forfeited', 'exiting']);

const servedAssets = (info) => ((info && info.server_info && Array.isArray(info.server_info.assets)) ? info.server_info.assets : []);

// The assets the operator serves under the supervised profile (`info`'s `supervised`
// entry): a coin of one is held only as a landing-1 leaf, landing in the wallet's own key.
export function supervisedAssets(info) {
  return servedAssets(info).filter((a) => a && a.supervised && typeof a.asset === 'string').map((a) => a.asset);
}

// Default mode's pairs (user-mode/pairs.json) as the operator serves them: a pair with a
// supervised asset keeps only the in-tree swap with a live maker, since the operator serves no
// take, no resting order and no Lightning payment in such an asset (the web wallet's servedPairs).
export function servedPairs(pairs, supervised) {
  const sup = new Set(supervised || []);
  if (!pairs || !pairs.chains || !sup.size) return pairs;
  const chains = {};
  for (const [g, c] of Object.entries(pairs.chains)) {
    chains[g] = { ...c, pairs: (c.pairs || []).map((p) => (sup.has(p.pay) || sup.has(p.receive))
      ? { ...p, sources: (p.sources || []).filter((x) => x === 'leaf-maker') } : p) };
  }
  return { ...pairs, chains };
}

// The assets the operator serves issuer-operated (`info`'s `issuer` entry): their batches'
// sweeps can only burn, and the issuer mints each round's float through a mint limiter.
export function issuerAssets(info) {
  return servedAssets(info).filter((a) => a && a.issuer && typeof a.asset === 'string').map((a) => a.asset);
}

// A leaf's batch profile, for developer mode: what its batch's sweep may do.
export function batchLine(profile) {
  if (!profile) return null;
  return profile === 'issuer-operated' ? 'issuer-operated: its sweep can only burn' : profile + ': its sweep pays the operator';
}

// What of each asset its issuer has frozen for this wallet: every held leaf whose landing
// the node shows frozen (or the asset paused), and every on-chain coin the leaf wallet
// counts frozen (a leaf taken home by its landing stays frozen there).
// -> Map(asset -> BigInt atoms)
export function frozenAtoms(coins, balance) {
  const out = new Map();
  const add = (a, v) => { if (!a) return; out.set(a, (out.get(a) || 0n) + big(v)); };
  for (const c of coins || []) {
    if (!HELD.has(c.state) || !c.frozen) continue;
    if (c.frozen.frozen || c.frozen.paused) add(c.asset, c.value);
  }
  for (const [a, v] of Object.entries((balance && balance.sequentia_onchain_frozen) || {})) add(a, v);
  for (const [a, v] of [...out]) if (v <= 0n) out.delete(a);
  return out;
}

// The one plain sentence a frozen holding gets, in either mode, under its asset's figure.
export function frozenSentence(amount, ticker) {
  return `${amount} ${ticker} is frozen by its issuer: it can't be sent until the issuer lifts the freeze.`;
}

export const FROZEN_REFUSAL = 'This asset is frozen by its issuer for this wallet: nothing was sent.';

// Whether a refusal says a coin is frozen or its asset paused (the operator's `frozen`
// code, the library's words, or the node's `bad-txns-asset-frozen`).
export function frozenRefusal(e) {
  const m = String((e && e.message) || e || '');
  return !!(e && e.code === 'frozen') || /\bfrozen\b|\bpaused\b/i.test(m);
}

// A refusal of the operator's equivocation bond (missing, in notice, or worth less than
// what the wallet would hold out of round on it): the library's gate on a receive and a
// swap, whose words always name the bond.
export function bondRefusal(e) {
  return /\bbond\b/i.test(String((e && e.message) || e || ''));
}
export const BOND_WORDS = Object.freeze({
  refused: 'Not accepted: the security deposit that backs these instant payments is missing or being withdrawn, so this wallet takes no payment that rests on it. Nothing was signed.',
});

// A payment the operator's signer refuses for what it asks, which it would refuse again
// however often it were asked (the server's `declined`): the library has put the coins back.
export const DECLINED_REFUSAL = 'This payment was declined; nothing was sent.';

// A refusal for user mode: one the operator declines, the bond's and a frozen coin's said
// plainly; every other refusal as it is.
export function plainRefusal(e) {
  if (e && e.code === 'declined') return withMessage(e, DECLINED_REFUSAL);
  if (bondRefusal(e)) return withMessage(e, BOND_WORDS.refused);
  if (frozenRefusal(e)) return withMessage(e, FROZEN_REFUSAL);
  return e;
}

function withMessage(e, message) {
  const out = new Error(message);
  if (e && e.kind) out.kind = e.kind;
  if (e && e.code) out.code = e.code;
  if (e && e.status) out.status = e.status;
  return out;
}
