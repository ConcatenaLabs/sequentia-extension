// Credit a hosted node's provider owes the user, signed while the user's device was away.
//
// On a credit channel (the SeqLN fork's `option_seq_credit`) the side that opened the channel,
// the provider, can be paid for the user while the user's device cannot sign, and owes the user
// what it was paid: it signs a note, "the user is owed c atoms of the channel's asset in all",
// tied to the payment it was paid. A later note states the whole amount and supersedes the
// earlier ones. Every commitment of the channel pays the provider's balance to a script from
// which the note, with its payment's preimage, pays the user, whoever brings it, and a mutual
// close pays it too; the provider cannot move its balance below it.
//
// The device signer learns each note when it returns (the SDK's `onCredit`, `creditNotes()`):
// this module keeps, per node, the latest note of each channel, so the wallet holds what a
// claim needs (the note, the provider's signature and the preimage) even if the device's store
// or the hosted node is lost. A note is never dropped: a channel the device forgets once it is
// closed keeps its last note here. Pure apart from the storage handed in.

export const CREDIT_KEY = 'swk.ln.credit';            // { [label]: { [channelId]: note } }

// A note as the device reports it: { peerId, dbid, channelId, fundingTxid (display order),
// fundingOutnum, credit (atoms, a number or a decimal string), paymentHash, signature,
// preimage (null until known) }.
function creditOf(n) {
  try { return BigInt(String(n && n.credit)); } catch { return -1n; }
}

// Whether `n` replaces `have`: a higher credit, or the same note with its preimage now known.
export function supersedes(n, have) {
  if (!have) return true;
  const a = creditOf(n), b = creditOf(have);
  if (a !== b) return a > b;
  return !have.preimage && !!n.preimage && n.paymentHash === have.paymentHash;
}

export function makeCreditStore(storage) {
  const read = () => {
    try { const v = JSON.parse(storage.getItem(CREDIT_KEY) || 'null'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  };
  const write = (v) => { try { storage.setItem(CREDIT_KEY, JSON.stringify(v)); } catch {} };
  return {
    // Record what the device reports for node `label`. Returns whether anything changed.
    record(label, notes) {
      const all = read();
      const mine = (all[label] && typeof all[label] === 'object') ? all[label] : {};
      let changed = false;
      for (const n of notes || []) {
        if (!n || !n.channelId || creditOf(n) < 0n) continue;
        if (!supersedes(n, mine[n.channelId])) continue;
        mine[n.channelId] = {
          peerId: n.peerId, dbid: n.dbid, channelId: n.channelId, fundingTxid: n.fundingTxid,
          fundingOutnum: n.fundingOutnum, credit: String(creditOf(n)), paymentHash: n.paymentHash,
          signature: n.signature, preimage: n.preimage || null,
        };
        changed = true;
      }
      if (changed) { all[label] = mine; write(all); }
      return changed;
    },
    // { [label]: [note, ...] }: the latest note of each channel of each node.
    notes() {
      const out = {};
      for (const [label, byChannel] of Object.entries(read())) {
        const list = Object.values(byChannel || {});
        if (list.length) out[label] = list;
      }
      return out;
    },
  };
}

// What the wallet says about node `label`'s notes, `amountText(atoms)` formatting an amount of
// the node's asset and `ticker` naming it: one line per channel, null when there is nothing.
export function creditLines({ notes, ticker, amountText }) {
  const lines = [];
  for (const n of notes || []) {
    const atoms = creditOf(n);
    if (atoms <= 0n) continue;
    const amount = (amountText ? amountText(atoms) : String(atoms)) + (ticker ? ' ' + ticker : '');
    lines.push(n.preimage
      ? `Your node's provider owes you ${amount}, paid to you while your device was away. `
        + 'It has signed for it: closing the channel pays it to you, and it cannot take it back.'
      : `Your node's provider has signed for ${amount} it is to pay you. It becomes yours once `
        + 'the payment it was made for is complete.');
  }
  return lines.length ? lines : null;
}
