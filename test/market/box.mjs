// A stand-in for the testnet box, for the market drives: one server that the wallet and
// the SeqDEX site reach as https://sequentiatestnet.com (Chromium maps the name to it with
// --host-resolver-rules and accepts its throwaway certificate) or, from Node, at its own
// address, every endpoint at the path the box serves it at:
//
//   /api/…                       the explorer, from an esplora shim over a regtest node
//   /seqob/…                     the on-chain relay (seqobd), local
//   /seqob-pln/…, /seqob-conf/…  books with no offers (no Lightning makers here)
//   /feerates                    the node's fee exchange rates
//   /prices                      the prices given (reference currency USD)
//   /registry/index.minimal.json the test assets, by ticker
//   /dex/…                       the SeqDEX site, from a checkout
//
// Anything else answers 404, which the wallet and the site take as that service being
// unreachable. With `upstream` (the real box's address, say https://<its IP>), only
// /dex/ is served from the checkout and everything else is passed to the real box with
// its own host name: the checkout's site runs against the live testnet. Every answer carries CORS headers: the wallet's service worker calls these
// from the extension's own origin.
import https from 'node:https';
import http from 'node:http';
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

// { tls: {key, cert} | null, esplora, relay, rpc: { url, auth }, site, assets: {id: [ticker, name, precision]}, prices }
export function startBox({ tls = null, port = 0, esplora, relay, rpc, site, assets = {}, prices = {}, upstream = null, instantPairs = [] }) {
  const call = async (method, params = []) => {
    const r = await fetch(rpc.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(rpc.auth).toString('base64') },
      body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const log = [];
  const handler = async (req, res) => {
    const url = new URL(req.url, 'https://sequentiatestnet.com');
    const p = decodeURIComponent(url.pathname);
    log.push(`${req.method} ${p}`);
    const send = (code, data, type = 'application/json') => { res.writeHead(code, { ...CORS, 'Content-Type': type }); res.end(data); };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const proxy = async (target) => {
      const headers = {};
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      const b = req.method === 'GET' || req.method === 'HEAD' ? undefined : await body(req);
      try {
        const r = await fetch(target, { method: req.method, headers, body: b });
        send(r.status, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || 'application/json');
      } catch (e) { send(502, 'the box could not reach ' + target + ': ' + e.message, 'text/plain'); }
    };
    try {
      if (upstream && !p.startsWith('/dex')) return passUp(req, res, upstream, url);
      if (p.startsWith('/api/')) return proxy(esplora + p + url.search);
      if (p.startsWith('/seqob/')) return proxy(relay + p.slice('/seqob'.length) + url.search);
      if (p.startsWith('/seqob-pln/') || p.startsWith('/seqob-conf/')) {
        // The instant book lists the pairs it is given (`instantPairs`, [base, 'BTC']), each
        // with no offer: a market with nobody to trade against.
        if (p.endsWith('/v1/markets')) return send(200, JSON.stringify({ markets: p.startsWith('/seqob-pln/') ? instantPairs.map(([b, q]) => ({ pair: { base_asset: b, quote_asset: q, confidential: false }, n_orders: 0 })) : [] }));
        if (p.endsWith('/orderbook')) return send(200, JSON.stringify({ offers: [] }));
        return send(404, 'not served by the stand-in box', 'text/plain');
      }
      if (p === '/feerates') return send(200, JSON.stringify(await call('getfeeexchangerates')));
      if (p === '/prices') return send(200, JSON.stringify(prices));
      if (p === '/registry/index.minimal.json') {
        const idx = {};
        for (const [id, [ticker, name, precision]] of Object.entries(assets)) idx[id] = ['regtest.invalid', ticker, name, precision, true, false];
        return send(200, JSON.stringify(idx));
      }
      if (p === '/dex' || p === '/dex/') { res.writeHead(302, { Location: '/dex/index.html' }); res.end(); return; }
      if (p.startsWith('/dex/') && site) {
        const f = normalize(join(site, p.slice('/dex/'.length)));
        if (!f.startsWith(site) || !existsSync(f) || !statSync(f).isFile()) return send(404, 'not found', 'text/plain');
        return send(200, readFileSync(f), TYPES[extname(f)] || 'application/octet-stream');
      }
    } catch (e) { return send(500, String(e.message), 'text/plain'); }
    send(404, 'not served by the stand-in box', 'text/plain');
  };
  const srv = tls ? https.createServer(tls, handler) : http.createServer(handler);
  // The real box answers for sequentiatestnet.com only, so the request carries that name.
  async function passUp(req, res, up, url) {
    const b = req.method === 'GET' || req.method === 'HEAD' ? undefined : await body(req);
    const u = new URL(up);
    const r2 = https.request({ host: u.hostname, port: u.port || 443, path: url.pathname + url.search, method: req.method, servername: 'sequentiatestnet.com',
      headers: { ...Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection'].includes(k))), host: 'sequentiatestnet.com' } }, (up2) => {
      const h = { ...up2.headers, ...CORS };
      res.writeHead(up2.statusCode, h); up2.pipe(res);
    });
    r2.on('error', (e) => { res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' }); res.end('the real box is unreachable: ' + e.message); });
    if (b) r2.write(b);
    r2.end();
  }
  return new Promise((ok) => srv.listen(port, '127.0.0.1', () => ok({
    server: srv, port: srv.address().port, url: `${tls ? 'https' : 'http'}://127.0.0.1:${srv.address().port}`, log,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  })));
}
