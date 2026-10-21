// How an asset's one figure is made up and shown: pure rules shared by the popup and
// the tests. The service worker's overview gives each row its parts (on-chain, leaves,
// Lightning and, for the Sequence token, staked); the figure is their sum in both modes.
//
// User mode shows that one figure, and a tap on the row opens its parts in plain words,
// only those it holds. Developer mode names every rail on one line under the row.

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

/// User mode's split, one tap away: the parts the row holds, or null when it holds
/// only one (the figure says it all).
export function userSplit(row, fmt) {
  const held = figureParts(row).filter(([, v]) => v > 0n);
  if (held.length < 2) return null;
  return held.map(([k, v]) => k + ' ' + fmt(v)).join(' · ');
}

/// Developer mode's line: every rail by name, and what is staked when there is any.
export function developerSplit(row, fmt) {
  let s = fmt(big(row.onchain)) + ' on-chain · ' + fmt(big(row.leaves)) + ' leaves · ' + fmt(big(row.ln)) + ' Lightning';
  if (big(row.staked) > 0n) s += ' · ' + fmt(big(row.staked)) + ' staked';
  return s;
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
