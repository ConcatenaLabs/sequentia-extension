#!/usr/bin/env node
// Serves the test site, and puts a local operator and its node behind the same
// address, with CORS, for the extension's leaf wallet (whose worker calls them from
// the extension's own origin):
//
//   /site.html, /site.js  -> this directory
//   /operator/…           -> the operator's server
//   /node                 -> the node's JSON-RPC
//
// The operator is the one the operator repository's harness keeps running for a
// browser (bark-cli/tests/arca_operator_for_browsers.rs); where its server and node
// are is read from the harness's control address.
//
//   node test/leaves/dev-server.mjs [--control 127.0.0.1:18640] [--port 0]
//
// It prints one line, `serving <url>`, once it listens.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const control = arg('--control', process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640');
const port = Number(arg('--port', '0'));
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
};

async function state() {
  const r = await fetch(`http://${control}/state`);
  if (!r.ok) throw new Error('the operator harness answered ' + r.status);
  return r.json();
}
function body(req) {
  return new Promise((ok, no) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', no);
  });
}
async function proxy(req, res, target) {
  const headers = {};
  for (const h of ['content-type', 'authorization']) if (req.headers[h]) headers[h] = req.headers[h];
  const b = req.method === 'GET' || req.method === 'HEAD' ? undefined : await body(req);
  try {
    const r = await fetch(target, { method: req.method, headers, body: b });
    const out = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { ...CORS, 'Content-Type': r.headers.get('content-type') || 'application/json' });
    res.end(out);
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' });
    res.end('the proxy could not reach ' + target + ': ' + e.message);
  }
}

const types = { '.html': 'text/html', '.js': 'text/javascript' };
const srv = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  try {
    if (p.startsWith('/operator/')) {
      const s = await state();
      return proxy(req, res, s.server.replace(/\/$/, '') + p.slice('/operator'.length) + url.search);
    }
    if (p === '/node' || p === '/node/') {
      const s = await state();
      return proxy(req, res, s.node_url);
    }
  } catch (e) { res.writeHead(502, CORS); res.end(String(e.message)); return; }
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const name = p === '/' ? 'site.html' : p.slice(1);
  const f = join(here, name);
  if (!['site.html', 'site.js'].includes(name) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[name.slice(name.lastIndexOf('.'))] });
  res.end(readFileSync(f));
});
srv.listen(port, '127.0.0.1', () => console.log(`serving http://127.0.0.1:${srv.address().port}/`));
