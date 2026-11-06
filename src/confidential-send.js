// A payment to a confidential address (`tsqb1…`, a confidential receive code) in default mode,
// from what the wallet holds for instant payments.
//
// Those coins are never confidential (the operator publishes every coin of a round with its asset
// and value), and the leaf library pays out of them only to a plain address ("an offboard pays an
// explicit output"). So the payment is made on the chain, blinded: the amount and a margin for its
// fee are first moved out to the wallet's own address, a round amount rather than the payment's
// own, the person is told so in the contract's words ("Moving <amount> <TICKER> out of the Ark so
// it can be sent confidentially…"), and the payment is then reviewed and made on the chain with a
// second blinded output to the wallet's own confidential address, so its amount is hidden. It is
// the web wallet's `confidentialReview` (its index.html, docs/DEFAULT_MODE.md "Send"), split so the popup can be closed
// and opened again while the coins move: each Review asks again, a move already under way is
// waited for and never asked twice, and the review comes once the coins are there.
//
// How much moves, and the wallet's own confidential output beside the payment that hides its
// amount, are the web wallet's own arithmetic (vendor/confidential-pay.js). This module holds what
// the extension adds to it: following a move across popup openings. src/default-mode.js runs both.

const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

// How long a move is waited for before the wallet says it has not arrived; how long its coins are
// kept off the wallet's upkeep (which would otherwise move them back) after that; and after how
// long a move still waiting for the network is said to wait. The web wallet's figures.
export const MOVE_WAIT_MS = 45 * 60_000;
export const KEEP_ON_CHAIN_MS = 15 * 60_000;
export const MOVE_SLOW_MS = 3 * 60_000;

// The states of the library's `offboards` in which a move has not reached the wallet's address.
export const UNDER_WAY = Object.freeze(['waiting', 'in_round', 'unlocking']);

// What of `asset` the moves this wallet asked for are still bringing to its address: the records
// it kept of them (`records`: [{ id, asset, atoms, at }]), read against the library's `offboards`.
// A move paid on the chain counts until that payout is final and the wallet's own reading shows it
// (`seen(txid)`), so the coins are never asked for twice while the reading catches up.
export function movesComing(asset, records, offboards, seen = () => false) {
  const byId = new Map((Array.isArray(offboards) ? offboards : []).filter((o) => o && o.offboard).map((o) => [o.offboard, o]));
  let atoms = 0n;
  const open = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || r.asset !== asset) continue;
    const o = byId.get(r.id);
    if (!o) continue;
    // Paid on the chain, it counts until the payout is final and the wallet's reading shows it.
    const coming = UNDER_WAY.includes(o.state) || (o.state === 'paid' && (!o.final || (o.txid && !seen(o.txid))));
    if (!coming) continue;
    atoms += big(o.amount ?? r.atoms);
    open.push({ ...r, state: o.state });
  }
  return { atoms, open };
}

// Whether a move under way has waited for the network longer than MOVE_SLOW_MS (the wallet then
// says it goes ahead as soon as it can), and whether the wait has run past MOVE_WAIT_MS.
export function moveWaits(open, now = Date.now()) {
  const list = Array.isArray(open) ? open : [];
  return {
    slow: list.some((r) => r.state === 'waiting' && now - Number(r.at || 0) > MOVE_SLOW_MS),
    over: list.length > 0 && list.every((r) => now - Number(r.at || 0) > MOVE_WAIT_MS),
  };
}
