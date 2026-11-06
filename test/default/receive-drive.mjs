#!/usr/bin/env node
// Receive in default mode against the live testnet, in headless Chromium: the unpacked extension
// in one fresh profile, through the popup as a person uses it (the web wallet's
// docs/DEFAULT_MODE.md, Receive).
//
//   - New code moves the code to a new address, and makes its other parts new.
//   - A payment name chosen under the code: the QR code becomes the name (read back from the
//     picture, it is `name@domain` in lower case), with the line saying names are public, Copy name
//     and Show full code and no New code; the wallet leaves its stock of signed codes with the name
//     service (`LNADDR_STORE`: the service's store file, read for the stock) and tops it up after a
//     lookup takes one; a code the service forged is refused (`FORGE_FILE`: the proxy's
//     --lnaddr-forge file). Show full code gives the code, which carries the name's LNURL-pay
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
//
// `LNADDR_BASE` names the name service the extension was built against (src/config.js LSP.url, a
// copy pointed at the web wallet's tooling/live-proxy.mjs --lnaddr), else the testnet's.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
const LNADDR_BASE = process.env.LNADDR_BASE || 'https://sequentiatestnet.com/lsp';
const WELL_KNOWN = LNADDR_BASE.replace(/\/lsp$/, '');
// The stock the service holds for `name`, from its store file (LNADDR_STORE), or null.
const stockOf = (name) => { try { const j = JSON.parse(readFileSync(process.env.LNADDR_STORE, 'utf8')); return ((j.names[name] || {}).stock || []).length; } catch { return null; } };
// The web wallet's QR decoder, beside this checkout or at JSQR.
const JSQR = process.env.JSQR || resolve(EXT, '../sequentia-web-wallet/jsqr.js');

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
    // The picture is the name.
    const nameShown = await waitFor(`document.querySelector('#recvDCode').innerText===${JSON.stringify(named)} ? true : false`, 120000).catch(() => false);
    check('Receive shows the name in place of the code', nameShown);
    await sleep(800);
    if (existsSync(JSQR)) {
      await pop.eval(readFileSync(JSQR, 'utf8') + '; true');
      const qrText = await pop.eval("(async()=>{ const i=document.querySelector('#recvDQr'); await i.decode(); const c=document.createElement('canvas'); c.width=i.naturalWidth; c.height=i.naturalHeight; const x=c.getContext('2d'); x.drawImage(i,0,0); const r=jsQR(x.getImageData(0,0,c.width,c.height).data,c.width,c.height); return r ? r.data + ' v' + r.version : 'none' })()");
      check('the QR code read back is the name, in lower case', String(qrText).split(' ')[0] === named.toLowerCase(), qrText);
    } else note('no QR decoder at ' + JSQR + ': the picture is not read back');
    const ui1 = await pop.eval("({ pub: document.querySelector('#recvDPublic').innerText, pubShown: !document.querySelector('#recvDPublic').classList.contains('hide'), copy: document.querySelector('#btnDCopy').innerText, full: document.querySelector('#btnDFull').innerText, fullShown: !document.querySelector('#btnDFull').classList.contains('hide'), newShown: !document.querySelector('#btnDNew').classList.contains('hide'), label: document.querySelector('#recvDLbl').innerText })");
    check('the name says it is public, offers Copy name and Show full code, and no New code',
      ui1.pubShown && /Anyone who has your name/.test(ui1.pub) && ui1.copy === 'Copy name' && ui1.fullShown && ui1.full === 'Show full code' && !ui1.newShown && ui1.label === 'Your payment name', ui1);
    const once = await pop.eval("({ lbl: !document.querySelector('#nameLbl').classList.contains('hide'), addr: !document.querySelector('#nameAddr').classList.contains('hide'), copy: !document.querySelector('#btnNameCopy').classList.contains('hide'), quiet: document.querySelector('#btnNameRemove').classList.contains('quiet') })");
    check('the name is said once: below it only Remove name, as a quiet link', !once.lbl && !once.addr && !once.copy && once.quiet, once);
    await shot('R-3-name.png');
    await noWords('Receive showing the name');
    // The stock the wallet leaves with the name service, and its top-up after a lookup.
    if (process.env.LNADDR_STORE) {
      const t2 = Date.now(); let n = null;
      while (Date.now() - t2 < 240000) { n = stockOf(want); if (n >= 10) break; await sleep(2000); }
      check('the wallet leaves ten signed codes with the name service', n >= 10, `${n} after ${((Date.now() - t2) / 1000).toFixed(1)} s`);
      const look = await fetch(`${LNADDR_BASE}/lnaddr/${want}`).then((r) => r.json()).catch((e) => ({ error: e.message }));
      const { verifyCode } = await import('../../vendor/lnaddr.js');
      const { readPayCode: rpc0 } = await import('../../vendor/pay-code.js');
      const lc = look.code ? rpc0(look.code) : null;
      check('a lookup gets a full code signed by the name\'s key', !!look.code && verifyCode(look.pubkey, 'sequentiatestnet.com', want, look) && !!lc.sequentia && !!lc.address && look.fresh === true, { fresh: look.fresh, parts: lc && Object.keys(lc).filter((k) => lc[k] && k !== 'other') });
      const after = stockOf(want);
      const t3 = Date.now(); let n2 = after;
      while (Date.now() - t3 < 120000) { n2 = stockOf(want); if (n2 >= 10) break; await sleep(2000); }
      check('the open wallet tops the stock up again', after < 10 && n2 >= 10, `${after} -> ${n2} in ${((Date.now() - t3) / 1000).toFixed(1)} s`);
    }
    // Send to this name: resolved and verified (and its key kept); a forged code is refused.
    const own = await ui('default.prepareSend', { to: named, amtS: '1', asset: USDX }).then((r) => 'resolved: ' + r.title, (e) => 'refused: ' + e.message);
    note('Send to the wallet\'s own name: ' + own);
    check('Send resolves the name to a signed code (here refused only for want of USDX)', !/did not sign|another wallet|No wallet/.test(own), own);
    if (process.env.FORGE_FILE) {
      writeFileSync(process.env.FORGE_FILE, 'address');
      const f1 = await ui('default.prepareSend', { to: named, amtS: '1', asset: USDX }).then(() => 'no refusal', (e) => e.message);
      check('a code whose address the service swapped is refused', /did not sign, so nothing was sent/.test(f1), f1);
      writeFileSync(process.env.FORGE_FILE, 'key');
      const f2 = await ui('default.prepareSend', { to: named, amtS: '1', asset: USDX }).then(() => 'no refusal', (e) => e.message);
      check('a code under a key the service put in place of the name\'s is refused', /belongs to another wallet than the one you paid before/.test(f2), f2);
      rmSync(process.env.FORGE_FILE, { force: true });
    }
    // Show full code.
    await pop.click('#btnDFull');
    const c3 = await waitFor("(()=>{ const t=document.querySelector('#recvDCode').innerText; return /[?&]lightning=LNURL1/.test(t) ? t : false })()", 120000).catch(() => null);
    check('Show full code gives the code, which carries the name\'s LNURL-pay', !!c3);
    check('and offers Show name back', (await pop.eval("document.querySelector('#btnDFull').innerText")) === 'Show name');
    await shot('R-3b-full-code.png');
    if (c3) {
      const url = lnurlDecode(param(c3, 'lightning'));
      check('it is the name\'s own LNURL-pay', url === `https://sequentiatestnet.com/.well-known/lnurlp/${want}`, url);
      const pr = await fetch(url.replace('https://sequentiatestnet.com', WELL_KNOWN)).then((r) => r.json()).catch((e) => ({ error: e.message }));
      check('which the service answers with a pay request', pr.tag === 'payRequest', { tag: pr.tag, reason: pr.reason });
      if (pr.callback) {
        const msat = 2000n * 1000n;
        const cb = await fetch(pr.callback + '?amount=' + msat).then((r) => r.json()).catch((e) => ({ error: e.message }));
        const d = cb.pr ? decodeBolt11(cb.pr) : null;
        check('a Lightning wallet paying it gets an invoice for the amount it chose, from this wallet', !!d && d.ok && d.chain === 'btc' && BigInt(d.amountMsat) === msat, cb.pr ? cb.pr.slice(0, 20) + '…' : cb);
      }
      note(`code with the name: ${c3.length} characters; the name: ${named.length}`);
    }
    await noWords('Receive, the full code with a name');
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
