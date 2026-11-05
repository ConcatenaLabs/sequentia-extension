// What default mode keeps in the Bitcoin ark, and the Lightning limit on one payment: the web
// wallet's rules (vendor/ark-limits.js, vendor/asset-lightning.js, its docs/DEFAULT_MODE.md),
// applied to the figures the service worker holds. Pure: every input is passed in.
//
//   - The ark rests at `board` (1,500 USD): BTC confirmed at the wallet's address moves in by
//     itself only while the ark holds less than a quarter of it, in one move back up to it
//     (`boardCap`); a trade that needs more BTC there gets what it asks.
//   - Once it holds `hold` (3,000 USD), everything above `board` moves to the wallet's own address
//     in one move (`moveDown`).
//   - One payment of `direct` (1,500 USD) or more goes to the address, never into the ark: a receive
//     code for such an amount carries neither the ark's address nor an invoice, and a payer here
//     pays the code's address (`direct`).
//   - One payment over Lightning is held to the limit the operator publishes (`max_payment`), per
//     direction; when it publishes none, to LN_FALLBACK_USD (`lnFits`).
//
// No price for BTC yet holds every move into the ark back until there is one. Sequentia's Ark has
// no figures. The figures may be set for a test (`ext.arkLimits` in the extension's local storage,
// the shape of the web wallet's window.SEQ_ARK_LIMITS); the popup offers no way to.

import { arkLimits, boardRoom, moveOutAtoms, directUsd, goesToAddress, usdAtoms } from '../vendor/ark-limits.js';
import { lnMaxPayment, fitsMax } from '../vendor/asset-lightning.js';

// When the operator publishes no limit, one payment over Lightning is worth at most this, in USD:
// the same figure as the largest payment the Bitcoin ark takes. Never no limit at all.
export const LN_FALLBACK_USD = 1500;

const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

// BTC's figures: { board, hold, direct } in USD, with its price and precision.
export function btcBand(override, price) {
  const l = arkLimits(override).btc;
  return { board: l.board, hold: l.hold, direct: l.direct, price, precision: 8 };
}

// The most a board carries now, the ark holding `held` sats: 0n when nothing goes in (it holds a
// quarter of `board` or more, or no price is known), null for no limit; at least `wanted` (a trade
// asking for that much BTC there) whenever a board is due or asked.
export function boardCap({ held, override, price, wanted = 0n }) {
  const l = btcBand(override, price);
  let cap;
  if (l.board != null && !(price > 0)) cap = 0n;
  else cap = boardRoom({ held, limitUsd: l.board, price, precision: 8 });
  if (cap != null && big(wanted) > cap) cap = big(wanted);
  return cap;
}

// What moves out of the ark to the wallet's own address now, holding `held` sats. -> sats.
export function moveDown({ held, override, price }) {
  if (!(price > 0)) return 0n;
  return moveOutAtoms({ held, ...btcBand(override, price) });
}

// The USD from which one payment of `sats` goes to the address rather than the ark, when it does;
// null when it goes as usual.
export function direct({ sats, override, price }) {
  const l = btcBand(override, price);
  if (!(big(sats) > 0n) || !(price > 0)) return null;
  return goesToAddress({ atoms: big(sats), ...l }) ? directUsd(l) : null;
}

// Whether one payment of `atoms` of `kind` ('BTC' or an asset) fits the operator's limit over
// Lightning in direction `dir` ('in' received, 'out' paid), as its `info` publishes it; else, when
// it publishes none or is not read, whether it is worth at most LN_FALLBACK_USD. An amount with no
// price is not held to the fallback.
export function lnFits({ info, kind, dir, atoms, price, precision = 8 }) {
  if (atoms == null) return true;
  const max = info ? lnMaxPayment(info, kind, dir) : null;
  if (max != null) return fitsMax(big(atoms), max);
  const at = usdAtoms(LN_FALLBACK_USD, price, precision);
  return at == null || big(atoms) <= at;
}
