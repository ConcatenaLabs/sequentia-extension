#!/usr/bin/env node
// Default mode against the live testnet, in headless Chromium: the unpacked extension in three
// fresh profiles, every step through the popup as a person takes it.
//
//   A: a new wallet joins the pinned operator by itself and shows one receive code; the faucet
//      pays that code; A sends part of it to B's receive code; A trades in the composer: PAY for
//      GET and back, then BTC bought with PAY, and PAY bought with BTC. Each trade's ticket,
//      every wait the wallet states while it runs, and the time it took to Settled are logged;
//      a purchase paid with BTC must state its wait and end within it.
//   B: a new wallet, paid by A; then Remove wallet, and a new wallet shows BTC alone.
//   C: A's phrase imported: the same figures as A.
//
// Every popup screen in default mode is read against the words default mode never says, and
// every error or exception of the service worker, the offscreen document and its workers fails
// the drive. Phrases stay in memory, unless PHRASE_DIR names a directory outside the repository:
// then each wallet's phrase is kept there (<label>-<time>.phrase, mode 600), so the coins it
// leaves behind are never stranded. Never put that directory in evidence.
//
//   CHROME=… [TRADE_PAY=USDX] [TRADE_GET=EURX] [TRADE_AMOUNT=5] [BTC_PAY=10] [FAUCET=USDX] \
//     node test/default/live-drive.mjs <evidence-dir> <work-dir>
import { mkdirSync, writeFileSync, appendFileSync, rmSync, chmodSync } from 'node:fs';
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
const AMOUNT = process.env.TRADE_AMOUNT || '5';
// The trades, in order: [pay, get, amount]; an amount of '' trades half of what the wallet then
// holds of what it pays (the way back, and the BTC sale).
const TRADES = [[PAY, GET, AMOUNT], [GET, PAY, ''], [PAY, 'BTC', process.env.BTC_PAY || '10'], ['BTC', PAY, '']];
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
  if (process.env.PHRASE_DIR) {
    const f = join(process.env.PHRASE_DIR, `${process.env.PHRASE_PREFIX || 'live-drive'}-${w.label}-${new Date().toISOString().replace(/[:.]/g, '')}.phrase`);
    writeFileSync(f, phrase + '\n', { mode: 0o600 }); chmodSync(f, 0o600);
    note(`     ${w.label}: phrase kept in ${f.split('/').pop()}`);
  }
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

// The composer's asset chooser (vendor/asset-picker.js): opened, searched, the row clicked.
const pickExpr = (id, want) => `(async () => {
  const b = document.getElementById(${JSON.stringify(id)}); if (!b) return false;
  b.click(); await new Promise((r) => setTimeout(r, 150));
  const inp = document.querySelector('.swpop-search input'); if (!inp) return false;
  inp.value = ${JSON.stringify(want)}; inp.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 100));
  const row = [...document.querySelectorAll('.swpop .swopt')].find((o) => o.dataset.hex === ${JSON.stringify(want)} || ((o.querySelector('.swopt-tk') || {}).firstChild || {}).textContent === ${JSON.stringify(want)});
  if (!row) { inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return false; }
  row.click(); return true;
})()`;
// The waits the composer states, read from all it shows: "within about N minutes" (the ticket's,
// a BTC purchase's waitingOther) and "taking longer than usual" (waitingOtherLate).
const STATED = /within about (\d+) minutes?|in about a minute|taking longer than usual/gi;
// One trade through the composer, as a person makes it, followed to Settled or Returned.
async function trade(A, pay, get, amount) {
  const name = `${pay}->${get}`;
  await A.pop.click('[data-tab=trade]');
  await A.pop.waitFor("!!document.querySelector('#ucPay')", 60000);
  const pick = async (id, tk) => { const t = Date.now(); while (!(await A.pop.eval(pickExpr(id, tk)))) { if (Date.now() - t > 60000) return false; await sleep(1000); } await sleep(500); return true; };
  if (!check(`${name}: You pay lists ${pay}`, await pick('ucPay', pay))) return;
  if (!check(`${name}: You receive lists ${get}`, await pick('ucGet', get))) return;
  let amt = amount;
  if (!amt) {
    const r = (await rows(A))[pay];
    if (!r || !(BigInt(r.total) > 0n)) { check(`${name}: something of ${pay} to pay`, false, r); return; }
    const half = BigInt(r.total) / 2n, p = r.precision || 0;
    amt = (Number(half) / 10 ** p).toFixed(Math.min(p, 8)).replace(/\.?0+$/, '');
  }
  await A.pop.eval(`(()=>{ const i=document.querySelector('#ucAmount'); i.value=${JSON.stringify(amt)}; i.dispatchEvent(new Event('input')); return true })()`);
  const tq = Date.now();
  await A.pop.click('#ucReview');
  const tk = await A.pop.waitFor("(()=>{ const k=document.querySelector('#ucCard'); if(k) return 'CARD '+k.innerText; if(document.querySelector('#ucConfirm')) return document.querySelector('#ucTicket').innerText; const n=document.querySelector('#ucNote'); return n && n.classList.contains('err') && n.textContent ? 'ERR '+n.textContent : false })()", 600000).catch(() => 'ERR no ticket in 10 minutes');
  const ticketWords = forbiddenIn(tk);
  check(`${name}: a ticket for ${amt} ${pay}`, !/^(ERR|CARD)/.test(tk) && !ticketWords.length, `${tk.replace(/\n+/g, ' | ')} (${secs(tq)})`);
  await A.pop.shot(join(out, 'screens', `A-trade-${pay}-${get}-ticket.png`));
  if (/^(ERR|CARD)/.test(tk)) return;
  const statedOnTicket = [...tk.matchAll(STATED)].map((m) => m[0]);
  const tc = Date.now();
  const rows0 = await A.pop.eval("document.querySelectorAll('#ucTrades .uc-trade').length");
  await A.pop.click('#ucConfirm');
  // Followed every two seconds: every wait it states, with when it was stated, and its end.
  const stated = [];
  let fin = null, last = '';
  while (Date.now() - tc < 30 * 60_000) {
    const v = await A.pop.eval(`(()=>{ const r=document.querySelectorAll('#ucTrades .uc-trade'); const st=r.length > ${rows0} ? (r[0].querySelector('.uc-state')||{}).textContent||'' : ''; return { st, all: document.querySelector('#userComposerRoot').innerText } })()`).catch(() => null);
    if (v) {
      for (const m of v.all.matchAll(STATED)) if (!stated.length || stated[stated.length - 1].words !== m[0]) stated.push({ words: m[0], at: +((Date.now() - tc) / 1000).toFixed(1) });
      const bad = forbiddenIn(v.all);
      if (bad.length && v.all !== last) check(`${name}: the composer says none of the forbidden words while it runs`, false, bad);
      last = v.all;
      if (/Settled|Returned/.test(v.st)) { fin = v.st; break; }
    }
    await sleep(2000);
  }
  const took = (Date.now() - tc) / 1000;
  note(`     ${name}: ticket states ${JSON.stringify(statedOnTicket)}; stated while it ran ${JSON.stringify(stated)}`);
  check(`${name}: Settled`, fin === 'Settled', `${fin} ${took.toFixed(1)} s after Trade`);
  // A purchase paid with BTC waits for what it buys to be held for it, and says how long.
  if (pay === 'BTC') {
    // The first wait it states, counted from when it was stated: the trade must end by then.
    const first = stated.find((x) => /within about \d+ minute|in about a minute/i.test(x.words));
    const mins = first ? Number((first.words.match(/(\d+) minute/) || [0, 1])[1]) : null;
    check(`${name}: the purchase states its wait`, !!first, stated);
    if (first) check(`${name}: it ends within the wait it stated (${mins} min, stated ${first.at} s after Trade)`, took <= first.at + mins * 60, `${took.toFixed(1)} s after Trade`);
    check(`${name}: never past the stated wait ("taking longer than usual")`, !stated.some((x) => /longer than usual/i.test(x.words)), stated);
  }
  await A.pop.shot(join(out, 'screens', `A-trade-${pay}-${get}-done.png`));
  await sleep(5000);
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
      await B.pop.waitFor("/^bitcoin:.*sequentia=/i.test(document.querySelector('#recvDCode').innerText)", 120000);
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
      await A.pop.waitFor("/^bitcoin:/i.test(document.querySelector('#recvDCode').innerText)", 120000);
      const code = await A.pop.text('#recvDCode');
      check('A shows one receive code with the ark and the Sequentia parts', /^bitcoin:tb1[0-9a-z]+\?/i.test(code) && /[?&]ark=/i.test(code) && /[?&]sequentia=/i.test(code), code.slice(0, 60) + '…');
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

      // the trades: each way between two assets in the tree, then a BTC purchase and a BTC sale
      for (const [pay, get, amount] of TRADES) await trade(A, pay, get, amount);
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
