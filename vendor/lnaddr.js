// A wallet's payment name: `name@sequentiatestnet.com`, a Lightning address (LNURL-pay, LUD-06 and
// LUD-16) that any Lightning wallet pays in an amount it chooses, and that a Sequentia wallet pays
// in any asset.
//
// Lightning wallets such as Phoenix can't pay a receive code over Lightning: the code names no
// amount, and the Bitcoin ark only makes invoices with one. A Lightning address turns the order
// round: the payer picks the amount first, then the service (tooling/lsp/lnaddr.mjs) asks the
// recipient's open wallet for a Bitcoin ark invoice of that amount and hands it back. A Sequentia
// wallet asks the service for the name's receive code instead (`GET /lnaddr/<name>`) and pays it
// as it pays any code (pay-code.js): an asset at its Sequentia part, BTC at its Ark part.
//
// The wallet holds its name with a key of its own phrase (`NAME_KEY_PATH`, BIP340), which the
// service stores beside the name, first come first served. Everything the wallet tells the
// service is signed with it (`signedDigest`): registering, releasing, waiting for requests, and
// each answer, so nobody else can take a name over, nor slip their own invoice into a payment to
// it. Each message names the service's domain, so a signature given to one service means nothing
// to another, and an answer names the request it answers, so it can't be replayed onto another.
//
// The page keeps one link with the service while it holds a name (`mountLnAddress`): a request the
// service holds open until a payer asks something, about every 25 seconds. A wallet that is not
// open has no link, and a payer is told it is offline.
//
// No DOM: it runs under Node (lnaddr.test.mjs), and tooling/lsp/lnaddr.mjs imports it.
import { HDKey, mnemonicToSeedSync, schnorr, sha256 } from './btc.js';

// The name key's path, beside the Lightning keys' branches (seqln-keys.js uses m/1017'/0' to 3').
export const NAME_KEY_PATH = "m/1017'/16'/0'";
export const NAME_RE = /^[a-z0-9_-]{3,32}$/;
// What a signed message's time may differ from the service's clock by.
export const SKEW_S = 600;

const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => {
  if (typeof h !== 'string' || !/^([0-9a-f]{2})*$/i.test(h)) throw new Error('not hex');
  return Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
};

// What the page says about the name. Default mode's words never name the protocol
// (docs/DEFAULT_MODE.md; lnaddr.test.mjs checks them against USER_MODE_FORBIDDEN_WORDS); developer
// mode's `dev*` lines do.
export const NAME_WORDS = Object.freeze({
  label: 'Your payment name',
  tip: 'Other wallets can pay you at this name, in any amount they choose, while this wallet is open.',
  none: 'Choose a name other wallets can pay you at, in any amount they choose.',
  choose: 'Choose a name',
  hint: 'yourname',
  save: 'Save',
  cancel: 'Cancel',
  saving: 'Saving…',
  copy: 'Copy',
  copied: 'Copied',
  remove: 'Remove name',
  removing: 'Removing…',
  devLabel: 'Lightning address',
  devTip: 'LNURL-pay (LUD-06, LUD-16) at this service: a payer picks the amount and this page makes the invoice on the Bitcoin ark while it is open. A Sequentia wallet paying it is given a new receive code.',
});

// Why `name` can't be a name, or null. Names are written in lower case.
export function nameProblem (name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return 'A name has 3 to 32 characters: lowercase letters, digits, - and _.';
  return null;
}

// The digest a message to the service signs: its action, the service's domain, the name and the
// action's own fields, each on its own line.
export function signedDigest (action, domain, name, ...fields) {
  const parts = ['sequentia-lnaddr/1', action, domain, name, ...fields.map((f) => String(f ?? ''))];
  for (const p of parts) if (/[\n\r]/.test(p)) throw new Error('a signed field holds a line break');
  return sha256(enc(parts.join('\n')));
}

// The name key of a phrase: { priv, pub } (pub is the 32-byte BIP340 key, in hex).
export function nameKey (phrase) {
  const words = String(phrase || '').trim().toLowerCase().split(/\s+/).join(' ');
  if (!words) throw new Error('no phrase');
  const k = HDKey.fromMasterSeed(mnemonicToSeedSync(words)).derive(NAME_KEY_PATH);
  return { priv: k.privateKey, pub: hex(schnorr.getPublicKey(k.privateKey)) };
}

export function signWith (priv, digest) { return hex(schnorr.sign(digest, priv)); }

export function verifySig (pubHex, digest, sigHex) {
  try {
    const pub = unhex(pubHex), sig = unhex(sigHex);
    if (pub.length !== 32 || sig.length !== 64) return false;
    return schnorr.verify(sig, digest, pub);
  } catch { return false; }
}

// `name@domain` as LUD-16 writes it -> { name, domain }, or null for anything else. The user part
// of LUD-16 also takes `.` and `+`; another service's names are read with them.
export function parseLnAddress (text) {
  const m = /^\s*(?:lightning:)?([a-z0-9._+-]+)@([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(String(text || ''));
  if (!m) return null;
  return { name: m[1].toLowerCase(), domain: m[2].toLowerCase() };
}

// The LUD-06 metadata of a name: what the payer's wallet shows, as the raw string the payRequest
// carries.
export function lnurlMetadata (name, domain) {
  return JSON.stringify([['text/plain', `Payment to ${name}@${domain}`], ['text/identifier', `${name}@${domain}`]]);
}

async function getJson (fetchFn, url, timeoutMs) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let r;
  try { r = await fetchFn(url, { signal: ctl ? ctl.signal : undefined, headers: { accept: 'application/json' } }); }
  catch { throw new Error('The address could not be reached. Check your connection and try again.'); }
  finally { if (t) clearTimeout(t); }
  let j = null; try { j = await r.json(); } catch {}
  if (j && String(j.status || '').toUpperCase() === 'ERROR') throw new Error(String(j.reason || 'The address refused the payment.'));
  if (!r.ok || !j) throw new Error('The address could not be reached. Check your connection and try again.');
  return j;
}

// What a payment to a Lightning address pays.
//   our domain: the name's receive code (`{ code }`), paid as any receive code, any asset;
//   another domain: BTC only, over LNURL-pay, an invoice of exactly `msat` (`{ invoice }`).
// `decode` is bolt11.js's decodeBolt11: the invoice must be for Bitcoin and for the amount asked.
// -> { code } | { invoice }, or throws a sentence the page shows.
export async function resolveLnAddress ({ text, asset, msat = null, domain, base, decode, fetch: fetchFn = (...a) => fetch(...a), timeoutMs = 20_000 }) {
  const a = parseLnAddress(text);
  if (!a) throw new Error('not a payment name');
  if (domain && a.domain === String(domain).toLowerCase()) {
    if (nameProblem(a.name)) throw new Error('No wallet goes by that name.');
    const j = await getJson(fetchFn, `${base}/lnaddr/${a.name}`, timeoutMs);
    if (typeof j.code !== 'string' || !j.code) throw new Error('No wallet goes by that name.');
    return { code: j.code, fresh: !!j.fresh };
  }
  if (asset !== 'BTC') throw new Error('This address takes BTC only.');
  if (msat == null || BigInt(msat) <= 0n) throw new Error('Enter an amount.');
  const want = BigInt(msat);
  const p = await getJson(fetchFn, `https://${a.domain}/.well-known/lnurlp/${encodeURIComponent(a.name)}`, timeoutMs);
  if (p.tag !== 'payRequest' || typeof p.callback !== 'string') throw new Error('This address does not take payments.');
  let cb; try { cb = new URL(p.callback); } catch { throw new Error('This address does not take payments.'); }
  if (cb.protocol !== 'https:') throw new Error('This address does not take payments.');
  const min = BigInt(p.minSendable ?? 1), max = BigInt(p.maxSendable ?? 0);
  if (want < min || (max > 0n && want > max)) {
    const btc = (msat) => { const v = msat / 1000n; return `${v / 100_000_000n}.${String(v % 100_000_000n).padStart(8, '0')}`.replace(/\.?0+$/, ''); };
    throw new Error(`This address takes between ${btc(min + 999n)} and ${btc(max)} BTC.`);
  }
  cb.searchParams.set('amount', String(want));
  const r = await getJson(fetchFn, cb.toString(), timeoutMs);
  const pr = String(r.pr || '');
  const d = decode ? decode(pr) : null;
  if (!d || !d.ok) throw new Error('The address answered with an invoice that does not read.');
  if (d.chain !== 'btc') throw new Error('The address answered with an invoice that is not for BTC.');
  if (d.amountMsat == null || BigInt(d.amountMsat) !== want) throw new Error('The address answered with an invoice for another amount.');
  return { invoice: pr };
}

// The page's side: registering and releasing its name, and while it holds one, the link that
// answers the service's requests.
//   base       the service's root (window.SEQ_LSP_URL)
//   domain     the names' domain (window.SEQ_LNADDR_DOMAIN)
//   key        () -> nameKey(phrase), or null while the wallet is locked
//   invoice    async (msat) -> a Bitcoin invoice of exactly that amount (the Bitcoin ark's)
//   code       async () -> a receive code of the wallet's own, new for the payer
//   limits     () -> { min_sat, max_sat } the wallet takes now, or null while it can't take any
//   store      { get(k), set(k, v|null) } for the name, per wallet
export function mountLnAddress ({ base, domain, key, invoice, code, limits = () => null, store, fetch: fetchFn = (...a) => fetch(...a), log = () => {}, now = () => Date.now(), onChange = () => {}, retryMs = 5_000 }) {
  let name = null; try { name = store.get('lnaddr.name') || null; } catch {}
  let running = false, stopped = true, ctl = null;
  const ts = () => Math.floor(now() / 1000);
  const keyOrThrow = () => { const k = key(); if (!k) throw new Error('Your wallet is locked; unlock it and try again.'); return k; };

  async function post (path, body, { signal } = {}) {
    let r;
    try { r = await fetchFn(`${base}/lnaddr/-/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }); }
    catch (e) { if (e && e.name === 'AbortError') throw e; throw new Error('The name could not be saved. Check your connection and try again.'); }
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok || !j || j.ok === false) { const e = new Error((j && j.error) || 'The name could not be saved. Check your connection and try again.'); e.status = r.status; e.code = j && j.code; throw e; }
    return j;
  }
  function keep (n) { name = n; try { store.set('lnaddr.name', n); } catch {} try { onChange(n); } catch {} }

  // The name this wallet's key holds at the service, if any (a wallet restored elsewhere finds it).
  async function recover () {
    const k = key(); if (!k) return name;
    try {
      const r = await fetchFn(`${base}/lnaddr/-/mine?pubkey=${k.pub}`);
      const j = await r.json();
      if (r.ok && j && j.ok) { if ((j.name || null) !== name) keep(j.name || null); }
    } catch {}
    return name;
  }

  async function register (wanted) {
    const n = String(wanted || '').trim().toLowerCase();
    const p = nameProblem(n); if (p) throw new Error(p);
    const k = keyOrThrow(), t = ts();
    await post('register', { name: n, pubkey: k.pub, ts: t, sig: signWith(k.priv, signedDigest('register', domain, n, k.pub, t)) });
    keep(n); start();
    return n;
  }
  async function release () {
    if (!name) return;
    const k = keyOrThrow(), t = ts(), n = name;
    await post('release', { name: n, ts: t, sig: signWith(k.priv, signedDigest('release', domain, n, t)) });
    keep(null); stop();
  }

  async function answer (n, k, req) {
    let body;
    try {
      if (req.kind === 'invoice') {
        const pr = await invoice(BigInt(req.msat));
        body = { name: n, id: req.id, pr, sig: signWith(k.priv, signedDigest('invoice', domain, n, req.id, pr)) };
      } else if (req.kind === 'code') {
        const c = await code();
        body = { name: n, id: req.id, code: c, sig: signWith(k.priv, signedDigest('code', domain, n, req.id, c)) };
      } else return;
    } catch (e) {
      log('[lnaddr] request', req.kind, 'not answered:', e && e.message);
      body = { name: n, id: req.id, refused: true, sig: signWith(k.priv, signedDigest('refuse', domain, n, req.id)) };
    }
    await post('answer', body).catch((e) => log('[lnaddr] answer:', e && e.message));
  }

  async function loop () {
    running = true;
    const seen = new Set();
    try {
      while (!stopped && name) {
        const k = key(), lim = limits();
        if (!k || !lim) { await new Promise((ok) => setTimeout(ok, retryMs)); continue; }
        const n = name, t = ts();
        ctl = typeof AbortController === 'function' ? new AbortController() : null;
        let j;
        try {
          j = await post('wait', { name: n, ts: t, min_sat: String(lim.min_sat), max_sat: String(lim.max_sat),
            sig: signWith(k.priv, signedDigest('wait', domain, n, t, lim.min_sat, lim.max_sat)) }, { signal: ctl ? ctl.signal : undefined });
        } catch (e) {
          if (stopped) break;
          // The service no longer knows the name under this key: it was released elsewhere.
          if (e && (e.status === 404 || e.status === 403)) { keep(null); break; }
          log('[lnaddr] wait:', e && e.message);
          await new Promise((ok) => setTimeout(ok, retryMs));
          continue;
        }
        for (const req of (j && j.requests) || []) {
          if (seen.has(req.id)) continue;
          seen.add(req.id); if (seen.size > 200) seen.delete(seen.values().next().value);
          answer(n, k, req);
        }
      }
    } finally { running = false; ctl = null; }
  }
  function start () { stopped = false; if (!running && name) loop(); }
  function stop () { stopped = true; try { if (ctl) ctl.abort(); } catch {} }

  return { name: () => name, address: () => (name ? `${name}@${domain}` : null), register, release, recover, start, stop, running: () => running };
}
