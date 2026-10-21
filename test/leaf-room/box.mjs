// A stand-in for the testnet box, for the leaf-room drive: one HTTPS server that the
// browser reaches as https://sequentiatestnet.com (Chromium maps the name to it with
// --host-resolver-rules and accepts its throwaway certificate), so the extension and
// the SeqDEX site run unchanged, every endpoint at the path the box serves it at:
//
//   /dex/…                       the SeqDEX site, from a checkout (SEQDEX_WEB)
//   /seqob/…                     the on-chain relay (seqobd), local
//   /arca/…                      the operator's server, local (the harness's)
//   /arca-node                   the operator's node JSON-RPC
//   /api/tx/<txid>               a transaction as the explorer serves it (the
//                                outputs only: script, asset, value), from the node
//   /registry/index.minimal.json the two test assets, by ticker
//   /prices                      no prices (values are shown in atoms)
//
// Anything else answers 404, which the extension and the site take as the testnet's
// services being unreachable. Every answer carries CORS headers: the extension's
// worker and service worker call these from the extension's own origin.
import https from 'node:https';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

function body(req) {
  return new Promise((ok, no) => { const p = []; req.on('data', (d) => p.push(d)); req.on('end', () => ok(Buffer.concat(p))); req.on('error', no); });
}

export function startBox({ key, cert, port = 0, site, relay, operator, node, nodeAuth, assets }) {
  const rpc = async (method, params = []) => {
    const r = await fetch(node, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(nodeAuth).toString('base64') },
      body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const log = [];
  const srv = https.createServer({ key, cert }, async (req, res) => {
    const url = new URL(req.url, 'https://sequentiatestnet.com');
    const p = decodeURIComponent(url.pathname);
    log.push(`${req.method} ${p}`);
    const send = (code, data, type = 'application/json') => { res.writeHead(code, { ...CORS, 'Content-Type': type }); res.end(data); };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const proxy = async (target, auth) => {
      const headers = {};
      for (const h of ['content-type', 'authorization']) if (req.headers[h]) headers[h] = req.headers[h];
      if (auth) headers.authorization = 'Basic ' + Buffer.from(auth).toString('base64');
      const b = req.method === 'GET' || req.method === 'HEAD' ? undefined : await body(req);
      try {
        const r = await fetch(target, { method: req.method, headers, body: b });
        send(r.status, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || 'application/json');
      } catch (e) { send(502, 'the box could not reach ' + target + ': ' + e.message, 'text/plain'); }
    };
    try {
      if (p.startsWith('/seqob/')) return proxy(relay + p.slice('/seqob'.length) + url.search);
      if (p.startsWith('/arca/')) return proxy(operator.replace(/\/$/, '') + p.slice('/arca'.length) + url.search);
      if (p === '/arca-node' || p === '/arca-node/') return proxy(node);
      let m;
      if ((m = p.match(/^\/api\/tx\/([0-9a-f]{64})$/))) {
        let tx;
        try { tx = await rpc('getrawtransaction', [m[1], true]); } catch { return send(404, 'Transaction not found', 'text/plain'); }
        const vout = tx.vout.map((o) => ({
          scriptpubkey: o.scriptPubKey.hex,
          asset: o.asset ?? null,
          value: o.value != null ? Math.round(Number(o.value) * 1e8) : null,
        }));
        return send(200, JSON.stringify({ txid: tx.txid, vout, status: { confirmed: !!tx.blockhash, block_hash: tx.blockhash || undefined } }));
      }
      if (p === '/registry/index.minimal.json') {
        const idx = {};
        for (const [id, ticker] of Object.entries(assets || {})) idx[id] = ['regtest.invalid', ticker, 'Test asset ' + ticker, 8, false, false];
        return send(200, JSON.stringify(idx));
      }
      if (p === '/prices') return send(200, '{}');
      if (p === '/dex' || p === '/dex/') { res.writeHead(302, { Location: '/dex/index.html' }); res.end(); return; }
      if (p.startsWith('/dex/')) {
        const f = normalize(join(site, p.slice('/dex/'.length)));
        if (!f.startsWith(site) || !existsSync(f) || !statSync(f).isFile()) return send(404, 'not found', 'text/plain');
        return send(200, readFileSync(f), TYPES[extname(f)] || 'application/octet-stream');
      }
    } catch (e) { return send(500, String(e.message), 'text/plain'); }
    send(404, 'not served by the stand-in box', 'text/plain');
  });
  return new Promise((ok) => srv.listen(port, '127.0.0.1', () => ok({ server: srv, port: srv.address().port, log })));
}
