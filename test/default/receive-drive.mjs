#!/usr/bin/env node
// Receive in default mode against the live testnet, in headless Chromium: the unpacked extension
// in one fresh profile, through the popup as a person uses it (the web wallet's
// docs/DEFAULT_MODE.md, Receive).
//
//   - New code moves the code to a new address, and makes its other parts new.
//   - A payment name chosen under the code: a code without an amount carries its LNURL-pay
//     (`lightning=LNURL1…`), which the name service answers with a pay request, and whose callback
//     gives an invoice of this wallet's for the amount a Lightning wallet chose.
//   - An amount in BTC carries the Bitcoin ark's invoice; an amount in an asset the operator
//     receives over Lightning carries that asset's invoice and no BTC amount.
//   - The Confidential switch: the code is the confidential address alone, the line says what stays
//     public, and the switch is off again once Receive is left.
//   - The name is removed at the end, and the code carries no LNURL-pay after.
//
// Every screen is read against the words default mode never says, and every error or exception of
// the extension's contexts fails the drive. A screenshot of each step goes to <evidence-dir>/screens.
// `BEFORE=1` takes the receive screen alone, for a build that predates these.
//
//   CHROME=… node test/default/receive-drive.mjs <evidence-dir> <work-dir>
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from '../leaves/cdp.mjs';
import { forbiddenIn } from '../../vendor/user-trade.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const CHROME = process.env.CHROME;
const out = resolve(process.argv[2] || 'receive-evidence');
const work = resolve(process.argv[3] || '/tmp/receive-drive');
const BEFORE = !!process.env.BEFORE;
if (!CHROME) { console.error('set CHROME'); process.exit(2); }
mkdirSync(join(out, 'screens'), { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'receive-drive.log');
writeFileSync(logFile, '');
const T0 = Date.now();
const note = (s) => { const l = `[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); appendFileSync(logFile, l + '\n'); };
let failures = 0;
function check(name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  if (!ok) failures++;
  return ok;
}
const USDX = '048c7943385563c3f74982760f88654a4acb1ecc0bd49803c2f52b304ee7ce11';
const param = (c, k) => { const m = new RegExp('[?&]' + k + '=([^&]*)', 'i').exec(c); return m ? decodeURIComponent(m[1]) : null; };
const addrOf = (c) => c.replace(/^bitcoin:/i, '').split('?')[0].toLowerCase();

async function main() {
  const b = new Browser({ chrome: CHROME, profile: join(work, 'profile-R'), ext: EXT, consoleLog: join(out, 'console-R.log'), headless: true });
  await b.launch('R');
  try {
    await b.serviceWorker();
    const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    await pop.eval("document.body.style.width='380px'; true");
    const ui = async (method, params = {}) => {
      const r = await pop.eval(`chrome.runtime.sendMessage({scope:'ui', method:${JSON.stringify(method)}, params:${JSON.stringify(params)}})`);
      if (!r || !r.ok) throw new Error(method + ': ' + ((r && r.error) || 'no answer'));
      return r.result;
    };
    // The page's value once `expression` gives one (the helper's waitFor answers nothing).
    const waitFor = async (expression, ms = 30000) => {
      const t0 = Date.now();
      for (;;) {
        let v = null; try { v = await pop.eval(expression); } catch {}
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + expression);
        await sleep(250);
      }
    };
    const shot = (f) => pop.shot(join(out, 'screens', f)).then(() => note('screenshot ' + f));
    const code = () => pop.text('#recvDCode');
    // The code itself is left out: it spells `lightning=` as BIP321 does.
    const noWords = async (what) => { const w = forbiddenIn(await pop.eval("document.querySelector('#vApp').innerText.replace(document.querySelector('#recvDCode').innerText, '')")); check(`${what}: none of the words default mode never says`, !w.length, w); };
    // A new wallet.
    await waitFor("!!document.querySelector('#btnStartCreate') && !!document.querySelector('#btnStartCreate').onclick", 60000);
    await pop.click('#btnStartCreate');
    await waitFor("!!document.querySelector('#newPhrase').dataset.phrase");
    await pop.set('createPw', 'drive-password'); await pop.set('createPw2', 'drive-password');
    const t = Date.now();
    await pop.click('#btnCreateGo');
    await waitFor("!document.querySelector('#vApp').classList.contains('hide')", 120000);
    for (;;) { const j = await ui('default.joined').catch(() => ({})); if ((j.joined && j.open) || Date.now() - t > 240000) break; await sleep(1000); }
    await pop.click('[data-tab=receive]');
    const isCode = "/^bitcoin:.*sequentia=/i.test(document.querySelector('#recvDCode').innerText)";
    const c1 = await waitFor(`${isCode} ? document.querySelector('#recvDCode').innerText : false`, 180000);
    await sleep(1500);
    await shot(BEFORE ? 'R-before-receive.png' : 'R-1-code.png');
    if (BEFORE) return;
    const { lnurlDecode } = await import('../../vendor/pay-code.js');
    const { decodeBolt11 } = await import('../../vendor/bolt11.js');
    check('Receive shows the code; the Confidential switch is under it, off', await pop.eval("!document.querySelector('#recvDConf').checked && document.querySelector('#recvDConfLbl').textContent==='Confidential'"));
    // New code.
    await pop.click('#btnDNew');
    const c2 = await waitFor(`(()=>{ const t=document.querySelector('#recvDCode').innerText; return ${isCode} && t!==${JSON.stringify(c1)} ? t : false })()`, 120000);
    check('New code moves the code to a new address', addrOf(c1) !== addrOf(c2) && /^tb1/.test(addrOf(c2)), `${addrOf(c1)} -> ${addrOf(c2)}`);
    check('and makes its receive request new', param(c1, 'sequentia') !== param(c2, 'sequentia'));
    await shot('R-2-new-code.png');
    // A payment name.
    await waitFor("!document.querySelector('#nameBox').classList.contains('hide')", 120000);
    const want = 'am5x' + Math.random().toString(36).slice(2, 8);
    await pop.click('#btnNameChoose');
    await pop.set('nameInput', want);
    await pop.click('#btnNameSave');
    const named = await waitFor("(()=>{ const t=document.querySelector('#nameAddr').innerText; const s=document.querySelector('#nameStatus').innerText; return t || (s ? 'ERR '+s : false) })()", 120000);
    check('the wallet holds a payment name', named === `${want}@sequentiatestnet.com`, named);
    const c3 = await waitFor("(()=>{ const t=document.querySelector('#recvDCode').innerText; return /[?&]lightning=LNURL1/.test(t) ? t : false })()", 120000).catch(() => null);
    check('without an amount the code carries the name\'s LNURL-pay', !!c3);
    if (c3) {
      const url = lnurlDecode(param(c3, 'lightning'));
      check('it is the name\'s own LNURL-pay', url === `https://sequentiatestnet.com/.well-known/lnurlp/${want}`, url);
      const pr = await fetch(url).then((r) => r.json()).catch((e) => ({ error: e.message }));
      check('which the service answers with a pay request', pr.tag === 'payRequest', { tag: pr.tag, reason: pr.reason });
      if (pr.callback) {
        const msat = 2000n * 1000n;
        const cb = await fetch(pr.callback + '?amount=' + msat).then((r) => r.json()).catch((e) => ({ error: e.message }));
        const d = cb.pr ? decodeBolt11(cb.pr) : null;
        check('a Lightning wallet paying it gets an invoice for the amount it chose, from this wallet', !!d && d.ok && d.chain === 'btc' && BigInt(d.amountMsat) === msat, cb.pr ? cb.pr.slice(0, 20) + '…' : cb);
      }
      note(`code with the name: ${c3.length} characters`);
    }
    await shot('R-3-name.png');
    await noWords('Receive with a name');
    // Amounts.
    const setAmount = (v, ticker) => pop.eval(`(()=>{ const s=document.querySelector('#recvDAsset'); const o=[...s.options].find(o=>o.textContent.trim()===${JSON.stringify(ticker)}); if(!o) return 'no '+${JSON.stringify(ticker)}+': '+[...s.options].map(o=>o.textContent).join(','); s.value=o.value; s.dispatchEvent(new Event('change')); const i=document.querySelector('#recvDAmt'); i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); return true })()`);
    await waitFor("[...document.querySelector('#recvDAsset').options].length > 1", 60000).catch(() => null);
    const menu = await pop.eval("[...document.querySelector('#recvDAsset').options].map(o=>o.textContent.trim())");
    note('the amount\'s menu: ' + menu.join(', '));
    await setAmount('0.0002', 'BTC');
    const c4 = await waitFor("(()=>{ const t=document.querySelector('#recvDCode').innerText; return /[?&]lightning=LNTB/i.test(t) ? t : false })()", 120000).catch(() => null);
    check('an amount in BTC: the code names it and carries an invoice, not the name', !!c4 && param(c4, 'amount') === '0.0002' && !/LNURL1/.test(c4), c4 && param(c4, 'lightning').slice(0, 16) + '…');
    await shot('R-4-amount-btc.png');
    const asset = menu.find((x) => x !== 'BTC');
    if (asset) {
      await setAmount('1', asset);
      const c5 = await waitFor(`(()=>{ const t=document.querySelector('#recvDCode').innerText; return /[?&]lightning=/i.test(t) && !/LNURL1/.test(t) && !/[?&]amount=/.test(t) && t!==${JSON.stringify(c4)} ? t : false })()`, 180000).catch(() => null);
      check(`an amount in ${asset}: the code carries its invoice in the asset, and no BTC amount`, !!c5, c5 && param(c5, 'lightning').slice(0, 16) + '…');
      await shot(`R-5-amount-${asset}.png`);
    } else check('the amount\'s menu lists an asset the operator receives over Lightning', false, menu);
    await setAmount('', 'BTC');
    await waitFor("/[?&]lightning=LNURL1/.test(document.querySelector('#recvDCode').innerText)", 120000).catch(() => null);
    // Confidential.
    await pop.eval("(()=>{ const c=document.querySelector('#recvDConf'); c.checked=true; c.dispatchEvent(new Event('change')); return true })()");
    const cc = await waitFor("(()=>{ const t=document.querySelector('#recvDCode').innerText; return /^tsqb1/.test(t) ? t : false })()", 60000).catch(() => null);
    check('Confidential on: the code is the confidential address alone', !!cc && /^tsqb1[0-9a-z]+$/.test(cc), cc && cc.slice(0, 20) + '…');
    const said = await pop.eval("({ note: document.querySelector('#recvDConfNote').innerText, shown: !document.querySelector('#recvDConfNote').classList.contains('hide'), amount: !document.querySelector('#recvDAmtRow').classList.contains('hide') })");
    check('it says what stays public and shows no amount', said.shown && /BTC is never confidential/.test(said.note) && !said.amount, said);
    await shot('R-6-confidential.png');
    await noWords('Receive, Confidential on');
    await pop.click('#btnDNew');
    const cc2 = await waitFor(`(()=>{ const t=document.querySelector('#recvDCode').innerText; return /^tsqb1/.test(t) && t!==${JSON.stringify(cc)} ? t : false })()`, 60000).catch(() => null);
    check('New code moves the confidential code to a new address too', !!cc2);
    await pop.click('[data-tab=balance]'); await sleep(500); await pop.click('[data-tab=receive]');
    const back = await waitFor(`${isCode} ? document.querySelector('#recvDCode').innerText : false`, 120000).catch(() => null);
    check('leaving Receive turns Confidential off again', !!back && !(await pop.eval("document.querySelector('#recvDConf').checked")));
    // Send to a name nobody holds: the service is asked, and its refusal shown in its own words.
    const unknown = await ui('default.prepareSend', { to: 'nobody-' + want + '@sequentiatestnet.com', amtS: '1', asset: USDX }).then(() => 'no refusal', (e) => e.message);
    check('Send to a name nobody holds is refused in plain words', /No wallet goes by that name/.test(unknown), unknown);
    // `NAME_FILE=<file>`: the name is written there, and the drive waits (up to ten minutes) for
    // another wallet to pay it USDX, with this wallet open, as a payer of the name meets it.
    if (process.env.NAME_FILE) {
      writeFileSync(process.env.NAME_FILE, named + '\n');
      note('waiting for a payment to ' + named);
      const t1 = Date.now(); let got = null;
      while (Date.now() - t1 < Number(process.env.NAME_WAIT_MS || 600000)) { const ov = await ui('overview', { withLn: false }).catch(() => null); const r = ov && ov.rows.find((x) => x.ticker === 'USDX'); if (r && BigInt(r.total) > 0n) { got = r; break; } await sleep(3000); }
      if (!got) {
        // Whether it arrives once the wallet syncs: tells a payment never made from one not read.
        await ui('sync').catch(() => {});
        await sleep(5000);
        const ov = await ui('overview', { withLn: false }).catch(() => null); const r = ov && ov.rows.find((x) => x.ticker === 'USDX');
        note('after a sync asked: USDX ' + (r ? r.total : 'none'));
      }
      check('another wallet paid the name, and USDX arrived', !!got, got ? `${got.total} atoms, ${((Date.now() - t1) / 1000).toFixed(1)} s after the name was handed out` : 'nothing in ten minutes');
      await waitFor("document.querySelector('[data-tab=receive]')", 1000).catch(() => null);
    }
    // The name removed.
    await pop.click('#btnNameRemove');
    await waitFor("!document.querySelector('#nameAddr').innerText", 60000).catch(() => null);
    const c7 = await waitFor("(()=>{ const t=document.querySelector('#recvDCode').innerText; return /^bitcoin:/i.test(t) && !/LNURL1/.test(t) ? t : false })()", 60000).catch(() => null);
    check('with the name removed, the code carries no LNURL-pay', !!c7);
  } finally {
    check('no error or exception in the extension\'s contexts', !b.problems.length, b.problems.slice(0, 10));
    await b.close().catch(() => {});
  }
}

main().then(() => { note(`done, ${failures} failed`); process.exit(failures ? 1 : 0); },
  (e) => { note('FAIL ' + (e && e.stack || e)); process.exit(1); });
