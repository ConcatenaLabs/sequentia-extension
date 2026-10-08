// A minimal esplora HTTP API over a sequentiad node's JSON-RPC, for driving the
// extension against a private regtest chain.
//
// It serves only what the extension and the kit's EsploraClient ask for, and
// indexes the chain in memory from the node (which must run with -txindex).
// It assumes no reorganisation: a regtest chain driven by one test has none.
//
// Script hashes are the FORWARD sha256 of the scriptPubKey, as the deployed
// esplora indexes them (src/staking.js explains why that matters).

import http from 'node:http';
import { createHash } from 'node:crypto';

export async function rpcCall(rpc, method, params = []) {
  const r = await fetch(rpc.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(rpc.auth).toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
  return j.result;
}

const sha = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const atoms = (v) => Math.round(Number(v) * 1e8);

// Test controls: `pools` is served as the pool board; `failNextPost(n)`
// refuses the n-th broadcast from now as the node would refuse an invalid
// one; `failTipHeight(true)` makes the tip height unreadable; `setRpc`
// follows a node restarted on another port.
export function startEsploraShim({ rpc, port, pools = null }) {
  const call = (m, p) => rpcCall(rpc, m, p);
  let postsUntilFailure = 0, tipHeightFails = false;
  let indexed = -1;
  const blockOf = new Map();              // txid -> { height, hash }
  const funding = new Map();              // scripthash -> [{ txid, vout, value, asset }]
  const spentBy = new Map();              // "txid:vout" -> { txid, vin }
  const touches = new Map();              // scripthash -> Set<txid>
  const spkOf = new Map();                // "txid:vout" -> scripthash
  const outOf = new Map();                // "txid:vout" -> { scriptpubkey, value, asset }
  const txJson = new Map();               // txid -> esplora-shaped transaction

  function add(map, k, v) { if (!map.has(k)) map.set(k, []); map.get(k).push(v); }
  function touch(h, txid) { if (!touches.has(h)) touches.set(h, new Set()); touches.get(h).add(txid); }

  function jsonOf(tx) {
    return {
      txid: tx.txid,
      vin: tx.vin.map((i) => i.coinbase || !i.txid
        ? { is_coinbase: true }
        : { txid: i.txid, vout: i.vout, is_coinbase: false, prevout: outOf.get(`${i.txid}:${i.vout}`) || null }),
      vout: tx.vout.map((o) => ({
        scriptpubkey: (o.scriptPubKey && o.scriptPubKey.hex) || '',
        value: o.value != null ? atoms(o.value) : null,
        asset: o.asset || null,
      })),
    };
  }

  function indexTx(tx) {
    for (const o of tx.vout) {
      const spk = o.scriptPubKey && o.scriptPubKey.hex;
      outOf.set(`${tx.txid}:${o.n}`, { scriptpubkey: spk || '', value: o.value != null ? atoms(o.value) : null, asset: o.asset || null });
      if (spk == null || spk === '') continue;
      const h = sha(spk);
      spkOf.set(`${tx.txid}:${o.n}`, h);
      add(funding, h, { txid: tx.txid, vout: o.n, value: o.value != null ? atoms(o.value) : null, asset: o.asset || null });
      touch(h, tx.txid);
    }
    tx.vin.forEach((i, n) => {
      if (i.coinbase || !i.txid) return;
      const k = `${i.txid}:${i.vout}`;
      spentBy.set(k, { txid: tx.txid, vin: n });
      const h = spkOf.get(k);
      if (h) touch(h, tx.txid);
    });
    txJson.set(tx.txid, jsonOf(tx));
  }

  let mempoolSeen = new Set();
  async function catchUp() {
    const tip = await call('getblockcount');
    for (let height = indexed + 1; height <= tip; height++) {
      const hash = await call('getblockhash', [height]);
      const b = await call('getblock', [hash, 2]);
      for (const tx of b.tx) {
        if (!mempoolSeen.has(tx.txid)) indexTx(tx);
        blockOf.set(tx.txid, { height, hash });
      }
      indexed = height;
    }
    // Parents before children, so a child's inputs find their outputs.
    let pending = [];
    for (const txid of await call('getrawmempool')) {
      if (mempoolSeen.has(txid) || blockOf.has(txid)) continue;
      try { pending.push(await call('getrawtransaction', [txid, 1])); } catch {}
    }
    while (pending.length) {
      const ids = new Set(pending.map((t) => t.txid));
      const ready = pending.filter((t) => !t.vin.some((i) => ids.has(i.txid)));
      for (const tx of ready.length ? ready : pending) { indexTx(tx); mempoolSeen.add(tx.txid); }
      pending = ready.length ? pending.filter((t) => !ready.includes(t)) : [];
    }
  }

  const status = (txid) => {
    const b = blockOf.get(txid);
    return b ? { confirmed: true, block_height: b.height, block_hash: b.hash } : { confirmed: false };
  };
  // Only what is still on chain or in the mempool: a mempool tx that was
  // evicted (replaced, or refused at a fork) is forgotten here.
  async function live(txid) {
    if (blockOf.has(txid)) return true;
    try { await call('getmempoolentry', [txid]); return true; } catch { return false; }
  }
  async function history(h) {
    const out = [];
    for (const txid of touches.get(h) || []) if (await live(txid)) out.push({ ...txJson.get(txid), status: status(txid) });
    // Newest first, unconfirmed before confirmed, as esplora orders them.
    const key = (t) => (t.status.confirmed ? t.status.block_height : 1e12);
    out.sort((a, b) => key(b) - key(a));
    return out;
  }
  async function utxos(h) {
    const out = [];
    for (const f of funding.get(h) || []) {
      const sp = spentBy.get(`${f.txid}:${f.vout}`);
      if (sp && await live(sp.txid)) continue;
      if (!(await live(f.txid))) continue;
      out.push({ txid: f.txid, vout: f.vout, value: f.value, asset: f.asset, status: status(f.txid) });
    }
    return out;
  }

  const log = [];
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'text/plain') => {
      res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
      res.end(body);
    };
    const json = (v) => send(200, JSON.stringify(v), 'application/json');
    try {
      let body = '';
      for await (const c of req) body += c;
      await catchUp();
      const p = new URL(req.url, 'http://x').pathname.replace(/^\/api/, '');
      log.push(`${req.method} ${p}`);
      let m;
      if (p === '/pools/pools.json' && pools) return json(pools);
      if (req.method === 'POST' && p === '/tx') {
        if (postsUntilFailure > 0 && --postsUntilFailure === 0) {
          return send(400, 'sendrawtransaction RPC error: {"code":-26,"message":"refused by the regtest shim on request"}');
        }
        try { return send(200, await call('sendrawtransaction', [body.trim()])); }
        catch (e) { return send(400, 'sendrawtransaction RPC error: ' + JSON.stringify({ code: e.code, message: e.message })); }
      }
      if (p === '/blocks/tip/hash') return send(200, await call('getbestblockhash'));
      if (p === '/blocks/tip/height' && tipHeightFails) return send(503, 'unavailable');
      if (p === '/blocks/tip/height') return send(200, String(await call('getblockcount')));
      if ((m = p.match(/^\/block-height\/(\d+)$/))) return send(200, await call('getblockhash', [Number(m[1])]));
      if ((m = p.match(/^\/block\/([0-9a-f]{64})\/header$/))) return send(200, await call('getblockheader', [m[1], false]));
      if ((m = p.match(/^\/block\/([0-9a-f]{64})$/))) {
        const h = await call('getblockheader', [m[1]]);
        return json({ id: h.hash, height: h.height, mediantime: h.mediantime, timestamp: h.time });
      }
      if ((m = p.match(/^\/address\/([^/]+)\/utxo$/))) {
        const s = await call('scantxoutset', ['start', [`addr(${m[1]})`]]);
        return json(s.unspents.map((u) => ({ txid: u.txid, vout: u.vout, value: atoms(u.amount), asset: u.asset,
          status: { confirmed: u.height > 0, block_height: u.height } })));
      }
      if ((m = p.match(/^\/tx\/([0-9a-f]{64})\/raw$/))) {
        const hex = await call('getrawtransaction', [m[1], 0]);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(Buffer.from(hex, 'hex'));
      }
      if ((m = p.match(/^\/tx\/([0-9a-f]{64})\/hex$/))) return send(200, await call('getrawtransaction', [m[1], 0]));
      if ((m = p.match(/^\/tx\/([0-9a-f]{64})\/status$/))) return json(status(m[1]));
      if ((m = p.match(/^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/))) {
        const sp = spentBy.get(`${m[1]}:${m[2]}`);
        if (sp && await live(sp.txid)) return json({ spent: true, txid: sp.txid, vin: sp.vin, status: status(sp.txid) });
        return json({ spent: false });
      }
      if ((m = p.match(/^\/address\/([^/]+)\/txs$/))) {
        const v = await call('validateaddress', [decodeURIComponent(m[1])]);
        if (!v.isvalid) return send(400, 'invalid address');
        return json(await history(sha(v.scriptPubKey)));
      }
      // Paged as esplora pages: unconfirmed plus the newest 25 confirmed, then
      // 25 confirmed at a time after the last one seen.
      if ((m = p.match(/^\/scripthash\/([0-9a-f]{64})\/txs$/))) {
        const all = await history(m[1]);
        const unconf = all.filter((t) => !t.status.confirmed);
        return json([...unconf, ...all.filter((t) => t.status.confirmed).slice(0, 25)]);
      }
      if ((m = p.match(/^\/scripthash\/([0-9a-f]{64})\/txs\/chain\/([0-9a-f]{64})$/))) {
        const conf = (await history(m[1])).filter((t) => t.status.confirmed);
        const at = conf.findIndex((t) => t.txid === m[2]);
        return json(at < 0 ? [] : conf.slice(at + 1, at + 26));
      }
      if ((m = p.match(/^\/scripthash\/([0-9a-f]{64})\/utxo$/))) return json(await utxos(m[1]));
      return send(404, 'not served by the shim: ' + p);
    } catch (e) {
      return send(500, String((e && e.message) || e));
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}`,
    log,
    setRpc: (r) => { rpc = r; },
    failNextPost: (n = 1) => { postsUntilFailure = n; },
    failTipHeight: (on) => { tipHeightFails = !!on; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}
