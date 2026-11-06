// The stock of receive codes a wallet leaves with its payment name (lnaddr.js): which addresses
// they use, so that a payer who looks the name up while the wallet is closed gets a new code, and a
// wallet restored from its phrase still finds every payment made to any of them.
//
// Each code in the stock is a full receive code (pay-code.js) at an address of its own, signed by
// the name's key. The name service hands each one out once. The wallet tops the stock up to
// `STOCK_SIZE` whenever it is open, and replaces a code whose single-use Sequentia part lapses
// within `STOCK_MARGIN_S`.
//
// Every address a stocked code uses is inside the window receive-index.js keeps New code in: from
// the first address neither chain has seen paid (`nextUnused`) through the `gap` after it. A scan
// from the phrase alone reads `gap` addresses past the last one paid, so a payment to any code ever
// stocked is found. The window only moves forward (an address paid moves `nextUnused` past it), so
// an address inside it when its code was made stays inside what a restore reads. When the window
// holds no address the stock and the screen are not already using, the stock reuses the address
// handed out longest ago: an address is used twice before the stock ever walks past the gap.
//
// No DOM: it runs under Node (name-stock.test.mjs). The browser extension copies this file into its
// vendor/ and Ambra mobile holds the same rule (app/lib/src/data/name_stock.dart): change all three
// together.
import { RECEIVE_GAP } from './receive-index.js';

// How many codes a wallet leaves with the service.
export const STOCK_SIZE = 10;
// A stocked code whose Sequentia part lapses within this is replaced; the service stops handing
// one out a little before (`SERVE_MARGIN_S` in tooling/lsp/lnaddr.mjs).
export const STOCK_MARGIN_S = 12 * 3600;
// How many indices handed out the wallet remembers, most recent last.
export const HANDED_KEEP = 64;

// The indices for `count` new codes: inside [nextUnused, nextUnused + gap), none of `held` (the
// indices of codes still in the stock, and the one on the screen), those never handed out first
// in order, then the ones handed out longest ago (`handed`, oldest first). Fewer than `count` when
// the window has no more room. -> [index]
export function pickStockIndices (count, { nextUnused = 0, held = [], handed = [], gap = RECEIVE_GAP } = {}) {
  const first = Math.max(0, Number(nextUnused) || 0);
  const busy = new Set(held.map(Number));
  const window = [];
  for (let i = first; i < first + gap; i++) if (!busy.has(i)) window.push(i);
  // The last time each index was handed out (its position in `handed`), -1 for never.
  const last = new Map();
  handed.forEach((i, at) => last.set(Number(i), at));
  window.sort((a, b) => (last.get(a) ?? -1) - (last.get(b) ?? -1) || a - b);
  return window.slice(0, Math.max(0, count));
}

// What a top-up does, from the stock the wallet made (`mine`: id -> { index, until }), what the
// service still holds of it (`held`: ids), and the time: which codes were handed out since (`served`,
// their indices to remember), which to take back (`drop`: a code still held whose Sequentia part
// lapses within the margin), and how many to make (`make`). `held` ids the wallet did not make (a
// copy of the wallet open elsewhere) count toward the stock and are left alone.
export function planTopUp ({ mine = {}, held = [], nowS = Date.now() / 1000, size = STOCK_SIZE, margin = STOCK_MARGIN_S } = {}) {
  const at = new Set(held);
  const served = [], drop = [], keep = [];
  for (const [id, c] of Object.entries(mine)) {
    if (!at.has(id)) { served.push(id); continue; }
    if (c && c.until != null && Number(c.until) - nowS < margin) drop.push(id); else keep.push(id);
  }
  const others = held.filter((id) => !(id in mine)).length;
  return { served, drop, keep, make: Math.max(0, size - keep.length - others) };
}
