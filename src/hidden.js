// Assets a person hid from the balance list and the pickers' first rows, kept for each wallet
// (by its tag, as the mode is). A hidden asset still counts in the total, still trades, and is
// still found by a picker's search (the web wallet's docs/DEFAULT_MODE.md, Balance). BTC is the
// parent chain: never hidden.
import { stGet, stSet } from './util.js';
import { walletTag } from './mode.js';

const KEY = 'ext.hidden';   // { [walletTag]: [assetHex] }

export async function hiddenAssets() {
  const tag = await walletTag();
  const all = (await stGet('local', KEY)) || {};
  return (tag && Array.isArray(all[tag])) ? all[tag] : [];
}

export async function setHidden(hex, on) {
  if (!hex || hex === 'BTC') return await hiddenAssets();
  const tag = await walletTag();
  if (!tag) throw new Error('open the wallet first');
  const all = (await stGet('local', KEY)) || {};
  const s = new Set(Array.isArray(all[tag]) ? all[tag] : []);
  if (on) s.add(hex); else s.delete(hex);
  all[tag] = [...s];
  await stSet('local', KEY, all);
  return all[tag];
}

// The rows of a balance list split into those shown and those folded under "Hidden assets (N)".
// BTC always shows; a hidden asset with nothing held appears in neither.
export function partitionHidden(rows, hidden) {
  const h = new Set(hidden || []);
  const shown = [], folded = [];
  for (const r of rows || []) {
    if (r.key !== 'BTC' && h.has(r.key)) { if (BigInt(r.total || 0) > 0n) folded.push(r); }
    else shown.push(r);
  }
  return { shown, folded };
}
