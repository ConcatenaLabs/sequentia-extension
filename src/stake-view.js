// What a stake of this wallet's key counts and how its lock reads: pure rules
// over stake-records.js's answers, shared by src/staking.js and the tests.

import { isTimeCsv, csvSeconds } from '../vendor/stake-records.js';

/// The states in which a stake is no longer the holder's at the staking key: a
/// stake claimed back (or being claimed) is in the wallet and counted there once,
/// and one spent another way or not on the chain is not the holder's.
export const NOT_HELD = new Set(['claimed', 'claiming', 'left', 'unknown']);

/// The value of a stake that is still the holder's, in atoms (0n once it is
/// not): a stake not yet confirmed, bonded or unbondable counts its bond, an
/// unbonding one its unbonding output (the bond less the unbond's fee). With no
/// state read yet, what the bond was.
export function heldAtoms(entry, state) {
  if (!state) return BigInt(entry.atoms || 0);
  if (NOT_HELD.has(state.state)) return 0n;
  return BigInt((state.unbonding && state.unbonding.value) || (state.stake && state.stake.value) || entry.atoms || 0);
}

/// A stake's lock, in the words the popup shows.
export function lockWords(csv) {
  return isTimeCsv(csv)
    ? `a time lock of about ${Math.round(csvSeconds(csv) / 86400)} days`
    : `a lock of ${Number(csv).toLocaleString('en-US')} blocks`;
}
