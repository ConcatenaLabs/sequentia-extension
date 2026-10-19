// The note about a hosted Lightning node's coins outside its channels, and about the channels
// its device found in an older device's store.
//
// A device that comes off a store written by a device that validated nothing signs no step of
// that store's channels: they are not carried over. The device reports them (the SDK's
// `onPredating`); this module keeps that report per node, minus what the user dismissed, and
// builds what the wallet says from what the node itself reports (`GET /node/onchain`: whether it
// is up, its channels by funding outpoint and state, and what it holds on chain). A channel is
// called closed only when the node reports it on chain or no longer lists it; any other channel
// is described as it is; while the node does not answer, nothing is said about it.
//
// The device moves a node's coins only to the node's own addresses or into a channel the node
// opens, so the money a close paid stays at the node's own address until the user opens a new
// channel with it. Nothing here opens one on its own.
//
// Pure apart from the storage handed in: index.html renders the model and wires the buttons.

export const PREDATING_KEY = 'swk.ln.predating';                 // { [label]: [channel, ...] }
export const DISMISSED_KEY = 'swk.ln.predating.dismissed';       // { channels: [outpoint], idle: { [label]: onchain_msat } }

// A channel as the device reports it: { peerId, dbid, fundingTxid (display order), fundingOutnum, fundingSats }.
export function outpointOf(c) {
  return String((c && c.fundingTxid) || '').toLowerCase() + ':' + Number(c && c.fundingOutnum);
}

export function makeNoteStore(storage) {
  const read = (k, fallback) => {
    try { const v = JSON.parse(storage.getItem(k) || 'null'); return v == null ? fallback : v; } catch { return fallback; }
  };
  const write = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); } catch {} };
  const dismissed = () => {
    const d = read(DISMISSED_KEY, {});
    return { channels: new Set(Array.isArray(d.channels) ? d.channels : []), idle: (d.idle && typeof d.idle === 'object') ? d.idle : {} };
  };
  const saveDismissed = (d) => write(DISMISSED_KEY, { channels: [...d.channels], idle: d.idle });
  return {
    // Record what the device reported for the node `label`. What the user dismissed is left out,
    // so a report the SDK repeats after every store restore never brings a dismissed note back.
    // Returns whether anything new was recorded.
    record(label, channels) {
      const all = read(PREDATING_KEY, {});
      const have = Array.isArray(all[label]) ? all[label] : [];
      const gone = dismissed().channels;
      let added = false;
      for (const c of channels || []) {
        const op = outpointOf(c);
        if (gone.has(op) || have.some((h) => outpointOf(h) === op)) continue;
        have.push(c);
        added = true;
      }
      if (added) { all[label] = have; write(PREDATING_KEY, all); }
      return added;
    },
    // { [label]: [channel, ...] }, without what was dismissed.
    channels() {
      const all = read(PREDATING_KEY, {}), gone = dismissed().channels, out = {};
      for (const [label, list] of Object.entries(all)) {
        const left = (Array.isArray(list) ? list : []).filter((c) => !gone.has(outpointOf(c)));
        if (left.length) out[label] = left;
      }
      return out;
    },
    // The user dismissed the note for `label`: its channels (the given ones, or all it lists),
    // and the line about its coins outside a channel while they stay at `onchainMsat`.
    dismiss(label, { channels, onchainMsat } = {}) {
      const d = dismissed();
      const list = channels || (read(PREDATING_KEY, {})[label] || []);
      for (const c of list) d.channels.add(outpointOf(c));
      if (onchainMsat != null) d.idle[label] = Number(onchainMsat);
      saveDismissed(d);
    },
    idleDismissed(label, onchainMsat) {
      const v = dismissed().idle[label];
      return v != null && Number(v) === Number(onchainMsat);
    },
  };
}

const CLOSED = new Set(['ONCHAIN', 'CLOSED']);
const CLOSING = new Set(['FUNDING_SPEND_SEEN', 'AWAITING_UNILATERAL']);

// What became of an old channel, from the node's report. 'unknown' while the node does not
// answer (or reports no channel list); 'closed' when it reports the channel on chain or no
// longer lists it; 'closing' while its close waits for a block; 'stuck' for a mutual close that
// was agreed and never reached the chain; 'open' otherwise.
export function channelFate(c, node) {
  if (!node || !node.node_up || !Array.isArray(node.channel_states)) return 'unknown';
  const op = outpointOf(c);
  const s = node.channel_states.find((x) => (String(x.funding_txid || '').toLowerCase() + ':' + Number(x.funding_outnum)) === op);
  if (!s) return 'closed';
  if (CLOSED.has(s.state)) return 'closed';
  if (CLOSING.has(s.state)) return 'closing';
  if (s.state === 'CLOSINGD_COMPLETE') return 'stuck';
  return 'open';
}

const FATE_COPY = {
  closed: ['is closed.', 'are closed.'],
  closing: ['is closing: its closing transaction waits for a block.', 'are closing: their closing transactions wait for a block.'],
  stuck: ['has a close that was agreed before the upgrade and never reached the chain; its balance stays in it.',
          'have a close that was agreed before the upgrade and never reached the chain; their balance stays in them.'],
  open: ['is still open and moves no payments: your device signs none of its steps.',
         'are still open and move no payments: your device signs none of their steps.'],
};

// The node's name in a sentence: "GOLD Lightning", or "Lightning" alone when there is no ticker.
function lightning(ticker) { return ticker ? ticker + ' Lightning' : 'Lightning'; }

// The note for one node. `channels`: what its device found in the old store (not dismissed);
// `node`: its /node/onchain answer (or null); `ticker`; `amountText`: what it holds on chain,
// formatted; `opening`: the progress text of an open this page has running for it, if any;
// `idleDismissed`: the user dismissed the line about its coins at this amount. Returns null
// when there is nothing to say.
export function noteFor({ label, ticker, channels = [], node = null, amountText = '', opening = null, idleDismissed = false }) {
  const name = lightning(ticker);
  const paragraphs = [];
  const fates = { closed: 0, closing: 0, stuck: 0, open: 0 };
  let known = 0;
  for (const c of channels) {
    const f = channelFate(c, node);
    if (f === 'unknown') continue;
    fates[f] += 1;
    known += 1;
  }
  if (known === 1) {
    const f = Object.keys(fates).find((k) => fates[k]);
    paragraphs.push('Your ' + name + ' channel from before the Lightning service\'s upgrade is not carried over:'
      + ' your device signs no step of it. It ' + FATE_COPY[f][0]);
  } else if (known > 1) {
    paragraphs.push('Your ' + known + ' ' + name + ' channels from before the Lightning service\'s upgrade are not'
      + ' carried over: your device signs no step of them.');
    for (const f of ['closed', 'closing', 'stuck', 'open']) {
      const n = fates[f];
      if (!n) continue;
      paragraphs.push(n === known
        ? (n === 2 ? 'Both ' : 'All of them ') + FATE_COPY[f][1]
        : (n === 1 ? 'One of them ' + FATE_COPY[f][0] : n + ' of them ' + FATE_COPY[f][1]));
    }
  }
  const msat = node && node.node_up ? Number(node.onchain_msat || 0) : 0;
  const idle = msat > 0 && !idleDismissed;
  if (idle) {
    paragraphs.push(amountText + (ticker ? ' ' + ticker : '') + ' is on chain at your ' + name
      + ' node\'s own address, not in a channel. Your device moves it only to your node\'s own addresses'
      + ' or into a channel.');
  }
  if (!paragraphs.length) return null;
  return {
    label,
    paragraphs,
    canOpen: idle,
    opening: opening || null,
    amountMsat: msat,
  };
}

// What "Open a new channel" asks the LSP for: a channel funded from the coins on the user's
// own node, after they move to a new address of the node's own (`consolidate`).
export function openRequest(label, node) {
  const chain = /^btc(:|$)/i.test(String(label)) ? 'btc' : 'seq';
  const asset = chain === 'seq' ? (String(label).split(':')[1] || '').toLowerCase() : undefined;
  const amount = Math.floor(Number((node && node.onchain_msat) || 0) / 1000);
  const req = { chain, amount, node: label, consolidate: true };
  if (asset) req.asset = asset;
  return req;
}

// One open at a time per node: the page asks before it sends, and the button shows the open
// as running until it ends.
export function makeOpenGuard() {
  const running = new Map();
  return {
    start(label, text) { if (running.has(label)) return false; running.set(label, text || 'Opening…'); return true; },
    progress(label, text) { if (running.has(label) && text) running.set(label, text); },
    end(label) { running.delete(label); },
    text(label) { return running.get(label) || null; },
  };
}
