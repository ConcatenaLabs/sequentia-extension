#!/usr/bin/env node
// A confidential payment from what default mode holds for instant payments, against the live
// testnet, in headless Chromium: the unpacked extension in two fresh profiles, one open at a time,
// through the popup as a person uses it (the web wallet's docs/DEFAULT_MODE.md, Send).
//
//   R: a new wallet; Receive with Confidential on gives its confidential address (tsqb1…).
//   P: a new wallet; the faucet pays its receive code (or, with FUNDER=<phrase file>, that wallet,
//      imported in a profile of its own, pays FUND_AMOUNT to its address, which P then moves in
//      by itself; `FUND_TO=code` pays the code instead, which lands as a channel's credit when the
//      code names one), so it holds that asset for instant payments only; Send of 1 to R's confidential address first moves the coins out ("Moving … out of the
//      Ark so it can be sent confidentially…"), then shows the review, and the payment is made on
//      the chain. The transaction's output to R is read from the chain: blinded.
//   R again: the payment shows in its figure.
//
// Every screen is read against the words default mode never says, and every error or exception of
// the extension's contexts fails the drive. Each wallet's phrase is written to <phrase-dir> (mode
// 600) before it is funded, so whatever is left in it is never stranded.
//
//   CHROME=… [ASSET=USDX] [FUNDER=<phrase file>] [FUND_AMOUNT=2] node test/default/confidential-drive.mjs <evidence-dir> <work-dir> <phrase-dir> [<name>]
import { mkdirSync, writeFileSync, appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from '../leaves/cdp.mjs';
import { forbiddenIn } from '../../vendor/user-trade.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const CHROME = process.env.CHROME;
const ASSET = process.env.ASSET || 'USDX';
const FUNDER = process.env.FUNDER || null;
const FUND_AMOUNT = process.env.FUND_AMOUNT || '5';
const FUND_TO = process.env.FUND_TO || 'address';
// REUSE=1: the wallets of an earlier run in the same work directory, unlocked, P already funded.
// Delete each profile's `Default/Service Worker` and `Default/Code Cache` first: a profile keeps the
// service worker it installed, so it would run the code of the run that made it.
const REUSE = !!process.env.REUSE;
const ESPLORA = 'https://sequentiatestnet.com/api';
const out = resolve(process.argv[2] || 'confidential-evidence');
const work = resolve(process.argv[3] || '/tmp/confidential-drive');
const phrases = process.argv[4] ? resolve(process.argv[4]) : null;
const NAME = process.argv[5] || 'conf-drive';
if (!CHROME || !phrases) { console.error('set CHROME and name a phrase directory'); process.exit(2); }
mkdirSync(join(out, 'screens'), { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'confidential-drive.log');
writeFileSync(logFile, '');
const T0 = Date.now();
const note = (s) => { const l = `[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${new Date().toISOString()} ${s}`; console.log(l); appendFileSync(logFile, l + '\n'); };
let failures = 0;
function check(name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  if (!ok) failures++;
  return ok;
}
const secs = (t) => ((Date.now() - t) / 1000).toFixed(1) + ' s';

async function open(label) {
  const b = new Browser({ chrome: CHROME, profile: join(work, 'profile-' + label), ext: EXT, consoleLog: join(out, 'console-' + label + '.log'), headless: true });
  current = { b };
  await b.launch(label);
  await b.serviceWorker();
  const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
  await pop.waitFor("location.protocol === 'chrome-extension:' && document.readyState === 'complete' && !!document.body", 60000);
  await pop.eval("document.body.style.width='380px'; true");
  pop.ui = async (method, params = {}) => {
    const r = await pop.eval(`chrome.runtime.sendMessage({scope:'ui', method:${JSON.stringify(method)}, params:${JSON.stringify(params)}})`);
    if (!r || !r.ok) throw new Error(method + ': ' + ((r && r.error) || 'no answer'));
    return r.result;
  };
  return { b, pop, label };
}
// A new wallet, its phrase written to <phrase-dir> before anything can pay it.
async function create(w, file) {
  if (existsSync(file)) throw new Error(file + ' exists: name another wallet');
  await w.pop.waitFor("!!document.querySelector('#btnStartCreate') && !!document.querySelector('#btnStartCreate').onclick", 60000);
  await w.pop.click('#btnStartCreate');
  await w.pop.waitFor("!!document.querySelector('#newPhrase').dataset.phrase");
  const phrase = await w.pop.eval("document.querySelector('#newPhrase').dataset.phrase");
  writeFileSync(file, phrase + '\n', { mode: 0o600 }); chmodSync(file, 0o600);
  note(`${w.label}: phrase kept in ${file}`);
  await w.pop.set('createPw', 'drive-password'); await w.pop.set('createPw2', 'drive-password');
  const t = Date.now();
  await w.pop.click('#btnCreateGo');
  await w.pop.waitFor("!document.querySelector('#vApp').classList.contains('hide')", 120000);
  return t;
}
async function importPhrase(w, phrase) {
  await w.pop.waitFor("!!document.querySelector('#btnStartImport') && !!document.querySelector('#btnStartImport').onclick", 60000);
  await w.pop.click('#btnStartImport');
  await w.pop.set('importPhrase', phrase);
  await w.pop.set('importPw', 'drive-password'); await w.pop.set('importPw2', 'drive-password');
  const t = Date.now();
  await w.pop.click('#btnImportGo');
  await w.pop.waitFor("!document.querySelector('#vApp').classList.contains('hide')", 120000);
  return t;
}
async function unlock(w) {
  await w.pop.waitFor("!document.querySelector('#vUnlock').classList.contains('hide') || !document.querySelector('#vApp').classList.contains('hide')", 60000);
  if (await w.pop.eval("!document.querySelector('#vApp').classList.contains('hide')")) return Date.now();
  await w.pop.set('unlockPw', 'drive-password');
  const t = Date.now();
  await w.pop.click('#btnUnlock');
  await w.pop.waitFor("!document.querySelector('#vApp').classList.contains('hide')", 120000);
  return t;
}
async function joined(w, t, ms = 240000) {
  for (;;) {
    const j = await w.pop.ui('default.joined').catch(() => ({}));
    if (j.joined && j.open) return j;
    if (Date.now() - t > ms) return j;
    await sleep(1000);
  }
}
async function row(w, ticker) {
  const ov = await w.pop.ui('overview', { withLn: false }).catch(() => null);
  return ov && ov.rows.find((r) => r.ticker === ticker);
}
async function waitRow(w, ticker, pred, ms) {
  const t = Date.now();
  for (;;) {
    const r = await row(w, ticker);
    if (r && pred(r)) return r;
    if (Date.now() - t > ms) return r || null;
    await sleep(3000);
  }
}
const noWords = async (w, what) => {
  const text = await w.pop.eval("document.querySelector('#vApp').innerText.replace((document.querySelector('#recvDCode')||{}).innerText||'', '')");
  const bad = forbiddenIn(text);
  check(`${w.label} ${what}: none of the words default mode never says`, !bad.length, bad);
};
let current = null;
let rBefore = 0n;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { if (current) await current.b.close().catch(() => {}); process.exit(1); });
async function session(label, fn) {
  const w = await open(label); current = w;
  try { return await fn(w); } finally {
    check(`${label}: no error or exception in the extension's contexts`, !w.b.problems.length, w.b.problems.slice(0, 10));
    await w.b.close().catch(() => {}); current = null;
  }
}

async function main() {
  try {
    // ---- R: the confidential address ----
    const conf = await session('R', async (R) => {
      const t = REUSE ? await unlock(R) : await create(R, join(phrases, `${NAME}-receiver.phrase`));
      check('R joined by itself', (await joined(R, t)).joined);
      await R.pop.click('[data-tab=receive]');
      await R.pop.waitFor("/^bitcoin:/i.test(document.querySelector('#recvDCode').innerText)", 180000);
      await R.pop.eval("(()=>{ const c=document.querySelector('#recvDConf'); c.checked=true; c.dispatchEvent(new Event('change')); return true })()");
      await R.pop.waitFor("/^tsqb1/.test(document.querySelector('#recvDCode').innerText)", 60000);
      const a = await R.pop.text('#recvDCode');
      check('R\'s confidential code is its confidential address alone', /^tsqb1[0-9a-z]+$/.test(a), a.slice(0, 24) + '…');
      await R.pop.shot(join(out, 'screens', 'C-0-receiver-confidential.png'));
      // What R holds before, read after a sync, so the payment is told from what it held already.
      await R.pop.ui('sync').catch(() => {});
      const r0 = await row(R, ASSET);
      rBefore = r0 ? BigInt(r0.total) : 0n;
      note(`R holds ${rBefore} atoms of ${ASSET} before`);
      return a;
    });

    // ---- P: instant holdings only, then the confidential payment ----
    const pcode = await session('P', async (P) => {
      if (REUSE) return null;
      const t = await create(P, join(phrases, `${NAME}-payer.phrase`));
      check('P joined by itself', (await joined(P, t)).joined);
      await P.pop.click('[data-tab=receive]');
      await P.pop.waitFor("/^bitcoin:.*sequentia=/i.test(document.querySelector('#recvDCode').innerText)", 180000);
      if (FUNDER) return await P.pop.text('#recvDCode');
      const tf = Date.now();
      await P.pop.click(`#faucetBtns [data-faucet="${ASSET}"]`);
      await P.pop.waitFor("/Received|could not|sent/i.test(document.querySelector('#faucetStatus').innerText)", 300000);
      const fs = await P.pop.text('#faucetStatus');
      check('the faucet paid the receive code', /^Received /.test(fs), `${fs} (${secs(tf)})`);
      return null;
    });

    // ---- F: a funded wallet pays P's receive code, in seconds ----
    if (FUNDER) {
      await session('F', async (F) => {
        const t = await importPhrase(F, readFileSync(FUNDER, 'utf8').trim());
        check('F joined by itself', (await joined(F, t)).joined);
        const has = await waitRow(F, ASSET, (r) => BigInt(r.total) - BigInt(r.arriving || 0) >= 1000000000n, 600000);
        if (!check(`F holds ${ASSET}`, !!has && BigInt(has.total) - BigInt(has.arriving || 0) >= 1000000000n, has && { total: has.total, arriving: has.arriving })) return;
        await F.pop.click('[data-tab=send]'); await sleep(1000);
        await F.pop.set('sendDTo', FUND_TO === 'code' ? pcode : pcode.replace(/^bitcoin:/i, '').split('?')[0]);
        const hex = await F.pop.eval(`[...document.querySelectorAll('#sendDAsset option')].find(o=>o.textContent===${JSON.stringify(ASSET)})?.value`);
        await F.pop.set('sendDAsset', hex); await F.pop.set('sendDAmt', FUND_AMOUNT);
        await F.pop.click('#btnDReview');
        await F.pop.waitFor("!!document.querySelector('.modal') || document.querySelector('#sendDErr').classList.contains('err')", 300000);
        const review = await F.pop.eval("(document.querySelector('.modal')||{}).innerText||document.querySelector('#sendDErr').innerText");
        check('F\'s review', /Send [\d.]+ \w+\?/.test(review), review.replace(/\n/g, ' | '));
        await F.pop.eval("[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Send').click(), true");
        await F.pop.waitFor("/Sent |declined|can't|up to|could not|nothing/i.test(document.querySelector('.modal .status').innerText)", 300000);
        const sent = await F.pop.text('.modal .status');
        check(`F paid P's ${FUND_TO}`, /^Sent /.test(sent), sent);
      });
    }

    const paid = await session('P', async (P) => {
      await unlock(P);
      // What P holds on the chain could not pay 1 (a payment before leaves a little change there).
      // CHAIN=1: P pays from a confidential coin it already holds on the chain (an earlier run's
      // own output), and nothing moves.
      const fewOnChain = (r) => !!process.env.CHAIN || BigInt(r.onchain || 0) < 100000000n;
      const got = await waitRow(P, ASSET, (r) => BigInt(r.total) > 0n && fewOnChain(r) && BigInt(r.arriving || 0) === 0n, 1800000);
      check(`P holds ${ASSET} for instant payments, and too little on the chain to pay 1`, !!got && BigInt(got.total) > 0n && fewOnChain(got),
        got && { total: got.total, onchain: got.onchain, leaves: got.leaves, arriving: got.arriving });
      // A coin received is given up for one of the wallet's own in the next round, and arrives
      // again: the payment is asked once nothing of it is arriving, twice 20 s apart.
      for (let i = 0, still = 0; i < 40 && still < 2; i++) {
        const r = await row(P, ASSET);
        still = r && BigInt(r.arriving || 0) === 0n ? still + 1 : 0;
        if (still < 2) await sleep(20000);
      }
      const ready = await row(P, ASSET);
      note(`P before Send: ${JSON.stringify(ready && { total: ready.total, onchain: ready.onchain, leaves: ready.leaves, arriving: ready.arriving })}`);
      await P.pop.click('[data-tab=balance]'); await sleep(1500);
      await P.pop.shot(join(out, 'screens', 'C-1-payer-holds.png'));

      // Send 1 to R's confidential address.
      await P.pop.click('[data-tab=send]'); await sleep(1000);
      await P.pop.set('sendDTo', conf);
      const hex = await P.pop.eval(`[...document.querySelectorAll('#sendDAsset option')].find(o=>o.textContent===${JSON.stringify(ASSET)})?.value`);
      await P.pop.set('sendDAsset', hex); await P.pop.set('sendDAmt', '1');
      // A coin just received is paid out only once it is final: "still arriving" until then, and
      // Review is pressed again, as a person would, every minute for up to half an hour.
      let ts = Date.now(), first = '';
      for (let i = 0; i < 30; i++) {
        ts = Date.now();
        await P.pop.click('#btnDReview');
        await P.pop.waitFor("!!document.querySelector('.modal') || /\\S/.test(document.querySelector('#sendDErr').innerText)", 300000);
        first = await P.pop.text('#sendDErr');
        if (!/still arriving/.test(first)) break;
        if (i === 0) { await P.pop.shot(join(out, 'screens', 'C-2a-still-arriving.png')); note(`Review: ${first}`); }
        await P.pop.waitFor("!document.querySelector('#btnDReview').disabled", 60000);
        await sleep(60000);
      }
      note(`Review answered: ${first}`);
      if (!process.env.CHAIN) check('Send says the coins move out first, in the contract\'s words', /^Moving [\d.,]+ \w+ out of the Ark so it can be sent confidentially\. They are ready (in a few minutes|in about \d+ minutes|shortly)\. Keep this page open\.$/.test(first), `${first} (${secs(ts)})`);
      await P.pop.shot(join(out, 'screens', 'C-2-moving-out.png'));
      await noWords(P, 'Send while the coins move');
      await P.pop.waitFor("!!document.querySelector('.modal') || document.querySelector('#sendDErr').classList.contains('err')", 45 * 60000);
      const review = await P.pop.eval("(document.querySelector('.modal')||{}).innerText||document.querySelector('#sendDErr').innerText");
      const tReview = Date.now();
      check('once they are there, the payment is reviewed', /Send 1 \w+\?/.test(review) && /Fee [\d.,]+ \w+/.test(review) && /Anyone reading the chain can see that (this payment is \w+, but not how much|a payment was made, but not its asset or amount)\./.test(review), `${review.replace(/\n/g, ' | ')} (${secs(ts)} after Review)`);
      await P.pop.shot(join(out, 'screens', 'C-3-review.png'));
      await noWords(P, 'the review');
      if (!(await P.pop.eval("!!document.querySelector('.modal')"))) return null;
      const before = new Set(((await P.pop.ui('history')).seq || []).map((x) => x.txid));
      await P.pop.eval("[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Send').click(), true");
      await P.pop.waitFor("/Sent |declined|can't|up to|could not|nothing/i.test(document.querySelector('.modal .status').innerText)", 300000);
      const sent = await P.pop.text('.modal .status');
      check('the payment was made', /^Sent 1 \w+\. It arrives/.test(sent), `${sent} (${secs(tReview)} after Send; ${secs(ts)} after Review)`);
      await P.pop.shot(join(out, 'screens', 'C-4-sent.png'));
      let txid = null;
      for (let i = 0; i < 40 && !txid; i++) {
        const h = ((await P.pop.ui('history').catch(() => ({}))).seq || []);
        const n = h.find((x) => !before.has(x.txid) && Object.values(x.deltas || {}).some((v) => BigInt(v) < 0n));
        if (n) txid = n.txid; else await sleep(3000);
      }
      check('the payment is in P\'s history', !!txid, txid);
      return { txid, at: new Date(ts).toISOString(), reviewAfter: ((tReview - ts) / 1000).toFixed(1) };
    });

    // ---- the chain: R's output is blinded ----
    if (paid && paid.txid) {
      let tx = null;
      for (let i = 0; i < 20 && !tx; i++) { tx = await fetch(`${ESPLORA}/tx/${paid.txid}`).then((r) => (r.ok ? r.json() : null)).catch(() => null); if (!tx) await sleep(3000); }
      const outs = (tx && tx.vout) || [];
      const blinded = outs.filter((o) => o.valuecommitment && o.assetcommitment);
      const explicitIn = ((tx && tx.vin) || []).reduce((n, i) => n + (i.prevout && i.prevout.value != null ? BigInt(i.prevout.value) : 0n), 0n);
      const explicitOut = outs.filter((o) => o.value != null).reduce((n, o) => n + BigInt(o.value), 0n);
      // The amount is hidden when at least two blinded outputs share what the inputs hold beyond
      // the explicit change and fee: the chain says how much they hold together, never the split.
      check('on the chain the amount cannot be worked out: two blinded outputs share the rest',
        blinded.length >= 2 && (explicitIn > explicitOut || ((tx && tx.vin) || []).every((i) => !i.prevout || i.prevout.value == null)),
        { txid: paid.txid, inputs: ((tx && tx.vin) || []).map((i) => i.prevout && i.prevout.value != null ? `explicit ${i.prevout.value}` : 'blinded'),
          outputs: outs.map((o) => o.scriptpubkey_type === 'fee' ? `fee ${o.value}` : (o.valuecommitment ? 'blinded' : `explicit ${o.value}`)),
          blindedHoldTogether: String(explicitIn - explicitOut) });
    }

    // ---- R again: the payment arrived ----
    if (paid) {
      await session('R', async (R) => {
        const t = await unlock(R);
        await R.pop.ui('sync').catch(() => {});
        const r = await waitRow(R, ASSET, (x) => BigInt(x.total) >= rBefore + 100000000n, 600000);
        check(`R's figure shows the 1 ${ASSET} more than before`, !!r && BigInt(r.total) >= rBefore + 100000000n, r && `${rBefore} -> ${r.total} atoms, ${secs(t)} after unlock`);
        await R.pop.click('[data-tab=balance]'); await sleep(1500);
        await R.pop.shot(join(out, 'screens', 'C-5-receiver-paid.png'));
        await noWords(R, 'Balance, paid');
      });
    }
    note(`payment: ${JSON.stringify(paid)}`);
  } finally {
    if (current) await current.b.close().catch(() => {});
  }
}

main().then(() => { note(`done, ${failures} failed`); process.exit(failures ? 1 : 0); },
  (e) => { note('FAIL ' + (e && e.stack || e)); process.exit(1); });
