// How an asset's one figure is made up and shown: pure rules shared by the popup and
// the tests. The service worker's overview gives each row its parts (on-chain, leaves,
// Lightning and, for the Sequence token, staked); the figure is their sum in both modes.
//
// User mode shows that one figure, and a tap on the row opens what is staked of it, when
// part of it is. Developer mode names every rail on one line under the row.

const big = (v) => BigInt(v || 0);

/// The parts of a row's figure, in plain words, in this order.
export function figureParts(row) {
  return [
    ['On-chain', big(row.onchain)],
    ['Off-chain', big(row.leaves)],
    ['Lightning', big(row.ln)],
    ['Staked', big(row.staked)],
  ];
}

/// The figure: every part added up.
export function figureOf(row) {
  return figureParts(row).reduce((a, [, v]) => a + v, 0n);
}

/// User mode's details, one tap away: only what a person may act on (docs/DEFAULT_MODE.md
/// in the web wallet). Where an asset is held is never said; what is staked is, when the
/// figure holds more than the stake. What is arriving is said under the figure itself.
export function userSplit(row, fmt) {
  const staked = big(row.staked);
  if (staked <= 0n) return null;
  const total = row.total != null ? big(row.total) : figureOf(row);
  if (total <= staked) return null;
  return 'Staked ' + fmt(staked);
}

/// Developer mode's line: every rail by name, and what is staked when there is any.
export function developerSplit(row, fmt) {
  let s = fmt(big(row.onchain)) + ' on-chain · ' + fmt(big(row.leaves)) + ' leaves · ' + fmt(big(row.ln)) + ' Lightning';
  if (big(row.staked) > 0n) s += ' · ' + fmt(big(row.staked)) + ' staked';
  return s;
}

/// What of each asset the wallet holds as leaves, for its figure, as the leaf wallet
/// counts it (`balance.held`, leaves and its on-chain coins together, less
/// `sequentia_onchain`): a leaf whose exit's claim is out is counted once, as the claim's
/// output on the chain (which the main wallet's own scan counts), and a leaf received
/// under a hash whose preimage the wallet does not hold yet is counted nowhere. A library
/// that gives no `held` is read by its `arca` states. -> { asset: atoms string }
export function leafPerAsset(balance) {
  const out = {};
  const held = balance && balance.held;
  if (held && typeof held === 'object') {
    const onchain = (balance && balance.sequentia_onchain) || {};
    for (const [a, v] of Object.entries(held)) {
      const leaves = big(v) - big(onchain[a]);
      if (leaves > 0n) out[a] = leaves.toString();
    }
    return out;
  }
  for (const [a, states] of Object.entries((balance && balance.arca) || {})) {
    let t = 0n;
    for (const v of Object.values(states || {})) t += big(v);
    if (t > 0n) out[a] = t.toString();
  }
  return out;
}

/// The words user mode never shows: how value is held and moved off the chain is
/// developer mode's.
export const DEVELOPER_WORDS = ['leaf', 'leaves', 'round', 'plan', 'claim', 'distribution', 'expiry', 'operator',
  'forfeit', 'covenant', 'anchor', 'atoms', 'unroll', 'refresh', 'CSV'];
/// The developer words a text carries, as whole words, case aside.
export function developerWordsIn(text) {
  const t = String(text || '');
  return DEVELOPER_WORDS.filter((w) => new RegExp('\\b' + w + 's?\\b', 'i').test(t));
}
