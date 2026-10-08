// Reading a receive request for the approval window, and shaping the library's balance
// for the provider. Pure; tested in test/leaves.test.mjs.
//
// A request is the library's text: a prefix word, a colon, and the hex of its JSON,
// which names its kind (`arca_request`). The wallet reads it here only to SHOW the
// payment before the user approves it. The payment itself is the library's `send`,
// handed the request together with the asset and amount shown, so the library pays
// exactly what was shown or refuses (it refuses an asset other than the request's).

const KIND = 'arca_request';

export function readRequest(text) {
  const s = String(text || '').trim();
  const i = s.indexOf(':');
  if (i <= 0) throw new Error('the receive request: it has no prefix');
  const prefix = s.slice(0, i);
  if (!/^[A-Za-z0-9-]+$/.test(prefix)) throw new Error(`the receive request: its prefix "${prefix}" is not a word`);
  const hex = s.slice(i + 1);
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new Error('the receive request: it is not hex after its prefix');
  let v;
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16);
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (e) { throw new Error('the receive request: ' + e.message); }
  if (!v || typeof v !== 'object' || !(KIND in v)) throw new Error('the receive request: the text is not one');
  return v;
}

// What a send to `req` pays, from the request and what the site named. Refuses what
// the library would refuse for the same reason, so the user is never asked to approve
// a payment that cannot be made as shown.
export function planSend(req, { asset, amount } = {}, info = null) {
  if (info) {
    if (info.genesis_hash && req.genesis_hash !== info.genesis_hash) {
      throw new Error(`the receive request is for the chain of genesis ${req.genesis_hash}, not this wallet's`);
    }
    if (info.operator && req.operator !== info.operator) {
      throw new Error(`the receive request is for operator ${req.operator}, not this wallet's`);
    }
  }
  const a = asset ? String(asset).toLowerCase() : null;
  if (a && !/^[0-9a-f]{64}$/.test(a)) throw new Error('asset must be a 64-hex asset id');
  const ra = req.asset ? String(req.asset).toLowerCase() : null;
  if (a && ra && a !== ra) throw new Error(`the request asks for asset ${ra}, not ${a}`);
  const payAsset = a || ra;
  if (!payAsset) throw new Error('name the asset to send: no asset is a default');
  let value = amount != null && amount !== '' ? String(amount) : (req.value != null ? String(req.value) : null);
  if (value == null) throw new Error('name the amount to send');
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error('amount must be a positive number of atoms');
  return {
    asset: payAsset, amount: value,
    owner: String(req.owner || ''), mailbox: String(req.mailbox || ''),
    until: typeof req.until === 'number' ? req.until : null,
    exitDelayUnits: req.exit_delay_units ?? null,
  };
}

// The library's `balance` and `schedule`, as getLeafBalances answers them.
export function leafBalancesAnswer(balance, schedule) {
  const leaves = {};
  for (const [a, states] of Object.entries((balance && balance.arca) || {})) {
    let total = 0n;
    const st = {};
    for (const [s, v] of Object.entries(states || {})) { st[s] = String(v); total += BigInt(v); }
    leaves[a] = { total: total.toString(), states: st };
  }
  const onchain = {};
  for (const [a, v] of Object.entries((balance && balance.sequentia_onchain) || {})) onchain[a] = String(v);
  return {
    leaves, onchain,
    value: (balance && balance.total) || null,
    schedule: schedule ? { now: schedule.now ?? null, next_sync_at: schedule.next_sync_at ?? null, due: !!schedule.due } : null,
  };
}
