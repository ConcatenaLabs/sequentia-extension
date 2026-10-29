#!/usr/bin/env node
// Default mode against the live testnet, in headless Chromium: the unpacked extension in three
// fresh profiles, every step through the popup as a person takes it.
//
//   A: a new wallet joins the pinned operator by itself and shows one receive code; the faucet
//      pays that code; A sends part of it to B's receive code; A trades once in the composer.
//   B: a new wallet, paid by A; then Remove wallet, and a new wallet shows BTC alone.
//   C: A's phrase imported: the same figures as A.
//
// Every popup screen in default mode is read against the words default mode never says, and
// every error or exception of the service worker, the offscreen document and its workers fails
// the drive. Phrases stay in memory: nothing of them is written anywhere.
//
//   CHROME=… [TRADE_PAY=USDX] [TRADE_GET=EURX] [FAUCET=USDX] node test/default/live-drive.mjs <evidence-dir> <work-dir>
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from '../leaves/cdp.mjs';
import { forbiddenIn } from '../../vendor/user-trade.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const CHROME = process.env.CHROME;
const out = resolve(process.argv[2] || 'default-evidence');
const work = resolve(process.argv[3] || '/tmp/default-drive');
const FAUCET = process.env.FAUCET || 'USDX';
const PAY = process.env.TRADE_PAY || 'USDX';
const GET = process.env.TRADE_GET || 'EURX';
if (!CHROME) { console.error('set CHROME'); process.exit(2); }
mkdirSync(join(out, 'screens'), { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'drive.log');
writeFileSync(logFile, '');
const T0 = Date.now();
const note = (s) => { const l = `[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); appendFileSync(logFile, l + '\n'); };
let failures = 0;
function check(name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  if (!ok) failures++;
  return ok;
}
const secs = (t) => ((Date.now() - t) / 1000).toFixed(1) + ' s';

async function open(label) {
  const b = new Browser({ chrome: CHROME, profile: join(work, 'profile-' + label), ext: EXT, consoleLog: join(out, 'console-' + label + '.log'), headless: true });
  await b.launch(label);
  await b.serviceWorker();
  const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
  await pop.eval("document.body.style.width='380px'; true");
  pop.ui = async (method, params = {}) => {
    const r = await pop.eval(`chrome.runtime.sendMessage({scope:'ui', method:${JSON.stringify(method)}, params:${JSON.stringify(params)}})`);
    if (!r || !r.ok) throw new Error(method + ': ' + ((r && r.error) || 'no answer'));
    return r.result;
  };
  return { b, pop, label };
}
async function create(w) {
  await w.pop.waitFor("!!document.querySelector('#btnStartCreate') && !!document.querySelector('#btnStartCreate').onclick", 60000);
  await w.pop.click('#btnStartCreate');
  await w.pop.waitFor("!!document.querySelector('#newPhrase').dataset.phrase");
  const phrase = await w.pop.eval("document.querySelector('#newPhrase').dataset.phrase");
  await w.pop.set('createPw', 'drive-password'); await w.pop.set('createPw2', 'drive-password');
  const t = Date.now();
  await w.pop.click('#btnCreateGo');
  await w.pop.waitFor("!document.querySelector('#vApp').classList.contains('hide')", 120000);
  return { phrase, t };
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
async function joined(w, t, ms = 240000) {
  for (;;) {
    const j = await w.pop.ui('default.joined').catch(() => ({}));
    if (j.joined && j.open) { j.after = secs(t); return j; }
    if (Date.now() - t > ms) return j;
    await sleep(1000);
  }
}
// The popup's visible text on each default-mode tab, read against the forbidden words.
async function wordsCheck(w, tag) {
  const seen = {};
  for (const t of ['balance', 'send', 'receive', 'trade']) {
    await w.pop.click(`[data-tab=${t}]`);
    await sleep(t === 'trade' ? 4000 : 1500);
    const text = await w.pop.eval("document.querySelector('#vApp').innerText");
    const bad = forbiddenIn(text);
    seen[t] = bad;
    await w.pop.shot(join(out, 'screens', `${w.label}-${tag}-${t}.png`));
  }
  check(`${w.label} ${tag}: no forbidden word on any default-mode tab`, Object.values(seen).every((x) => !x.length), seen);
}
async function rows(w) {
  const ov = await w.pop.ui('overview', { withLn: false });
  return Object.fromEntries(ov.rows.map((r) => [r.ticker, { total: r.total, arriving: r.arriving, precision: r.precision }]));
}
async function waitRow(w, ticker, pred, ms) {
  const t = Date.now();
  for (;;) {
    const r = (await rows(w).catch(() => ({})))[ticker];
    if (r && pred(BigInt(r.total))) return r;
    if (Date.now() - t > ms) return r || null;
    await sleep(2000);
  }
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
// One browser at a time (the laptop's memory): each profile is opened, used and closed.
let current = null;
async function session(label, fn) {
  const w = await open(label); current = w;
  try { return await fn(w); } finally {
    check(`${label}: no error or exception in the extension's contexts`, !w.b.problems.length, w.b.problems.slice(0, 10));
    await w.b.close().catch(() => {}); current = null;
  }
}

async function main() {
  try {
    // ---- B: a new wallet, its receive code taken, then closed ----
    const ONLY_A = !!process.env.ONLY_A;
    const bcode = ONLY_A ? null : await session('B', async (B) => {
      const bw = await create(B);
      const jb = await joined(B, bw.t);
      check('B joined the operator by itself', jb.joined && jb.open, jb);
      await B.pop.click('[data-tab=receive]');
      await B.pop.waitFor("/^bitcoin:.*sequentia=/.test(document.querySelector('#recvDCode').innerText)", 120000);
      return await B.pop.text('#recvDCode');
    });

    // ---- A: a new wallet joins by itself; faucet; pays B; trades once ----
    const { a, aRows } = await session('A', async (A) => {
      const a = await create(A);
      const ja = await joined(A, a.t);
      check('A joined the operator by itself', ja.joined && ja.open, ja);
      check('A holds BTC on the Bitcoin ark wallet (open)', !!ja.ark, ja);
      const fresh = await rows(A);
      check('a fresh wallet lists BTC alone', Object.keys(fresh).join() === 'BTC', Object.keys(fresh));
      await A.pop.click('[data-tab=send]'); await sleep(800);
      const sendList = await A.pop.eval("[...document.querySelectorAll('#sendDAsset option')].map(o=>o.textContent)");
      check('a fresh wallet sends from BTC alone', sendList.join() === 'BTC', sendList);
      await A.pop.click('[data-tab=receive]');
      await A.pop.waitFor("/^bitcoin:/.test(document.querySelector('#recvDCode').innerText)", 120000);
      const code = await A.pop.text('#recvDCode');
      check('A shows one receive code with the ark and the Sequentia parts', /^bitcoin:tb1[0-9a-z]+\?/.test(code) && /[?&]ark=/.test(code) && /[?&]sequentia=/.test(code), code.slice(0, 60) + '…');
      note(`     A: code shown ${secs(a.t)} after Create`);
      await wordsCheck(A, 'fresh');

      // the faucet pays the code
      await A.pop.click('[data-tab=receive]'); await sleep(500);
      const tf = Date.now();
      await A.pop.click(`#faucetBtns [data-faucet="${FAUCET}"]`);
      await A.pop.waitFor("/Received|could not/.test(document.querySelector('#faucetStatus').innerText)", 180000);
      const fs = await A.pop.text('#faucetStatus');
      check('the faucet paid', /^Received /.test(fs), `${fs} (${secs(tf)})`);
      const got = await waitRow(A, FAUCET, (v) => v > 0n, 180000);
      check(`A's ${FAUCET} figure shows it`, got && BigInt(got.total) > 0n, `${JSON.stringify(got)} ${secs(tf)} after the click`);
      await A.pop.click('[data-tab=balance]'); await sleep(1500);
      await A.pop.shot(join(out, 'screens', 'A-after-faucet.png'));

      // A pays B's code
      if (bcode) {
      await A.pop.click('[data-tab=send]'); await sleep(1000);
      await A.pop.set('sendDTo', bcode);
      const hex = await A.pop.eval(`[...document.querySelectorAll('#sendDAsset option')].find(o=>o.textContent===${JSON.stringify(FAUCET)})?.value`);
      await A.pop.set('sendDAsset', hex); await A.pop.set('sendDAmt', '1');
      await A.pop.click('#btnDReview');
      await A.pop.waitFor("!!document.querySelector('.modal') || /\\S/.test(document.querySelector('#sendDErr').innerText)", 120000);
      const review = await A.pop.eval("(document.querySelector('.modal')||{}).innerText||document.querySelector('#sendDErr').innerText");
      check('the review reads "Send 1 …?" "It arrives in seconds."', /Send 1 \w+\?/.test(review) && /It arrives in seconds\./.test(review), review.replace(/\n/g, ' | '));
      await A.pop.shot(join(out, 'screens', 'A-send-review.png'));
      if (await A.pop.eval("!!document.querySelector('.modal')")) {
        const ts = Date.now();
        await A.pop.eval("[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Send').click(), true");
        await A.pop.waitFor("/Sent |declined|Part of|can't|up to|Failed|nothing/i.test(document.querySelector('.modal .status').innerText)", 300000);
        const sent = await A.pop.text('.modal .status');
        check('A paid B\'s code', /^Sent 1 \w+ \([\d.]+ s\)\.$/.test(sent), `${sent} (${secs(ts)})`);
        await A.pop.shot(join(out, 'screens', 'A-sent.png'));
        await A.pop.eval("document.querySelector('.modal')?.remove(); true");
      }
      }

      // one trade in the composer
      await A.pop.click('[data-tab=trade]');
      await A.pop.waitFor("!!document.querySelector('#ucPay')", 60000);
      const pick = async (id, ticker) => {
        const v = await A.pop.eval(`[...document.querySelectorAll('#${id} option')].find(o=>o.textContent===${JSON.stringify(ticker)})?.value`);
        if (!v) return false;
        await A.pop.set(id, v); await sleep(800); return true;
      };
      check(`You pay lists ${PAY}`, await pick('ucPay', PAY));
      await A.pop.waitFor("!!document.querySelector('#ucGet')", 30000);
      check(`You get lists ${GET}`, await pick('ucGet', GET));
      await A.pop.set('ucAmount', process.env.TRADE_AMOUNT || '5');
      const tq = Date.now();
      await A.pop.click('#ucReview');
      await A.pop.waitFor("!!document.querySelector('#ucConfirm') || (/\\S/.test(document.querySelector('#ucNote').innerText) && !/Finding/.test(document.querySelector('#ucNote').innerText))", 900000);
      const ticket = await A.pop.eval("(document.querySelector('#ucTicket')||{}).innerText + ' | ' + (document.querySelector('#ucNote')||{}).innerText");
      note(`     ticket (${secs(tq)}): ${ticket.replace(/\n/g, ' | ')}`);
      await A.pop.shot(join(out, 'screens', 'A-trade-ticket.png'));
      if (await A.pop.eval("!!document.querySelector('#ucConfirm')")) {
        const tc = Date.now();
        await A.pop.click('#ucConfirm');
        await A.pop.waitFor("!!document.querySelector('.uc-trade .uc-state') && !/Working/.test(document.querySelector('.uc-trade .uc-state').innerText)", 300000).catch(() => {});
        const st = await A.pop.eval("[...document.querySelectorAll('.uc-trade')].map(d=>d.innerText.replace(/\\n/g,' ')).join(' ; ') + ' | ' + document.querySelector('#ucNote').innerText");
        check('the trade was made', /Sent|Settled/.test(st), `${st} (${secs(tc)} after Trade)`);
        for (let i = 0; i < 120 && !/Settled|Returned/.test(await A.pop.text('#ucTrades')); i++) await sleep(10000);
        note(`     the trade after following it: ${(await A.pop.text('#ucTrades')).replace(/\n/g, ' | ')} (${secs(tc)} after Trade)`);
        await A.pop.shot(join(out, 'screens', 'A-trade-after.png'));
      } else check('the composer priced a trade', false, ticket);
      await sleep(10000);
      const aRows = await rows(A);
      note(`     A's figures: ${JSON.stringify(aRows)}`);
      return { a, aRows };
    });

    if (ONLY_A) { note(`${failures ? failures + ' FAILED' : 'all passed'}`); return; }
    // ---- B again: paid; then Remove wallet, and a new wallet lists BTC alone ----
    await session('B', async (B) => {
      const t = await unlock(B);
      const bgot = await waitRow(B, FAUCET, (v) => v >= 100000000n, 240000);
      check(`B's figure shows the ${FAUCET} A sent`, bgot && BigInt(bgot.total) >= 100000000n, `${JSON.stringify(bgot)} ${secs(t)} after unlock`);
      await wordsCheck(B, 'paid');
      await B.pop.click('[data-tab=settings]'); await sleep(500);
      await B.pop.set('removePw', 'drive-password');
      await B.pop.click('#btnRemoveWallet');
      await B.pop.waitFor("!document.querySelector('#vWelcome').classList.contains('hide')", 60000);
      note(`     B after Remove wallet: ${JSON.stringify(await B.pop.ui('default.joined').catch((e) => ({ error: e.message })))}`);
      const b2 = await create(B);
      await joined(B, b2.t);
      const b2rows = await rows(B);
      check('after Remove wallet, a new wallet lists BTC alone at 0', Object.keys(b2rows).join() === 'BTC' && b2rows.BTC.total === '0', b2rows);
      await B.pop.click('[data-tab=balance]'); await sleep(1000);
      await B.pop.shot(join(out, 'screens', 'B2-after-remove.png'));
    });

    // ---- C: A's phrase restored ----
    await session('C', async (C) => {
      const tr = await importPhrase(C, a.phrase);
      const jc = await joined(C, tr);
      check('C (A\'s phrase) joined by itself', jc.joined && jc.open, jc);
      const same = (c) => Object.keys(aRows).every((k) => c[k] && c[k].total === aRows[k].total);
      let cRows = {};
      for (let i = 0; i < 60; i++) { cRows = await rows(C); if (same(cRows)) break; await sleep(3000); }
      check('the restore shows A\'s figures', same(cRows), { A: aRows, C: cRows, after: secs(tr) });
      await C.pop.click('[data-tab=balance]'); await sleep(1000);
      await C.pop.shot(join(out, 'screens', 'C-restored.png'));
    });
    note(`${failures ? failures + ' FAILED' : 'all passed'}`);
  } finally {
    if (current) await current.b.close().catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { note('drive error: ' + (e && e.stack || e)); note('FAILED'); process.exit(1); });
