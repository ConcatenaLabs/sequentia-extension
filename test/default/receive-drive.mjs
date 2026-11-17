#!/usr/bin/env node
// Receive in default mode against the live testnet, in headless Chromium: the unpacked extension
// in one fresh profile, through the popup as a person uses it (the web wallet's
// docs/DEFAULT_MODE.md, Receive).
//
//   - Receive is one card: the picture, one line and Copy. The wallet holds a payment name from the
//     start, made with nothing asked, and the picture is the name (read back from the QR code, it is
//     `name@domain` in lower case, `JSQR`). Everything else is under More options.
//   - Show full code writes the code out (and Show name goes back); it carries the name's LNURL-pay,
//     which the name service answers with a pay request, and whose callback gives an invoice of this
//     wallet's for the amount a Lightning wallet chose. New code moves the full code to a new
//     address. The wallet leaves its stock of signed codes with the name service (`LNADDR_STORE`: the
//     service's store file, read for the stock); a code the service forged is refused (`FORGE_FILE`:
//     the proxy's --lnaddr-forge file).
//   - An amount in BTC carries the Bitcoin ark's invoice; an amount in an asset the operator
//     receives over Lightning carries that asset's invoice and no BTC amount.
//   - The Confidential switch: the code is the confidential address alone, the line says what stays
//     public, and the switch is off again once Receive is left.
//   - The name is changed and then removed in Settings; the code carries no LNURL-pay after, and no
//     name is made again by itself.
//
// Every screen is read against the words default mode never says, and every error or exception of
// the extension's contexts fails the drive. A screenshot of each step goes to <evidence-dir>/screens.
// `WORD_NAME=1` leaves the wallet on its default word name; otherwise the name is changed to a chosen one.
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
const WORD_NAME = !!process.env.WORD_NAME;
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
    for (let i = 0; i < 60 && !(await pop.eval('!!document.body').catch(() => false)); i++) await sleep(250);
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
    // The code itself is left out of the words check: it spells `lightning=` as BIP321 does.
    const noWords = async (what) => { const w = forbiddenIn(await pop.eval("document.querySelector('#vApp').innerText.replace(document.querySelector('#recvDCode').innerText, '')")); check(`${what}: none of the words default mode never says`, !w.length, w); };
    // The wallet's own answer for a code, as the card asks it.
    const answer = (p = {}) => ui('default.receiveCode', p);
    const codeWith = async (p, pat, ms = 120000) => { const t0 = Date.now(); for (;;) { const r = await answer(p).catch(() => null); if (r && pat.test(r.code || '')) return r.code; if (Date.now() - t0 > ms) return null; await sleep(2000); } };
    const nameState = async (pred, ms = 180000) => { const t0 = Date.now(); let n = null; while (Date.now() - t0 < ms) { n = await ui('default.name').catch(() => null); if (n && pred(n)) return n; await sleep(2000); } return n; };
    const more = async (open) => { const on = await pop.eval("!document.querySelector('#recvMore').classList.contains('hide')"); if (on !== open) { await pop.click('#btnRecvMore'); await sleep(400); } };
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
    // The name, made with nothing asked.
    const nm = await nameState((n) => n.name && n.verified && !n.unreachable);
    check('the wallet holds a payment name from the start, made with nothing asked', !!(nm && nm.name && nm.verified), nm && { name: nm.address, word: nm.isWordName, after: ((Date.now() - t) / 1000).toFixed(1) + ' s' });
    const named = nm && nm.display;
    const { lnurlDecode } = await import('../../vendor/pay-code.js');
    const { decodeBolt11 } = await import('../../vendor/bolt11.js');
    // The card is drawn once the wallet has answered for the picture.
    const drawn = await waitFor("document.querySelector('#recvDQr').getAttribute('src') ? true : false", 120000).catch(() => false);
    if (!drawn) note('the card was not drawn: ' + JSON.stringify(await pop.eval("({ line: document.querySelector('#recvDLine').innerText, status: document.querySelector('#recvDStatus').innerText })")));
    await sleep(1000);
    const lineOf = () => pop.eval("document.querySelector('#recvDLine').innerText");
    check('Receive is one card: the picture, the line and Copy', (await lineOf()) === 'Scan or share to get paid in BTC or any asset.' && (await pop.eval("document.querySelector('#btnDCopy').innerText")) === 'Copy' && !(await pop.eval("!document.querySelector('#recvMore').classList.contains('hide') || !document.querySelector('#recvDCode').classList.contains('hide')")));
    await shot('R-1-card.png');
    if (existsSync(JSQR)) {
      await pop.eval(readFileSync(JSQR, 'utf8') + '; true');
      const qrText = await pop.eval("(async()=>{ const i=document.querySelector('#recvDQr'); await i.decode(); const k=Math.max(1, Math.ceil(600/i.naturalWidth)); const c=document.createElement('canvas'); c.width=i.naturalWidth*k+80; c.height=i.naturalHeight*k+80; const x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,c.width,c.height); x.imageSmoothingEnabled=false; x.drawImage(i,40,40,i.naturalWidth*k,i.naturalHeight*k); const r=jsQR(x.getImageData(0,0,c.width,c.height).data,c.width,c.height); return r ? r.data + ' v' + r.version : 'none' })()");
      check('the QR code read back is the name in lower case, about 30 characters', String(qrText).split(' ')[0] === nm.address && nm.address.length < 40, qrText);
    } else note('no QR decoder at ' + JSQR + ': the picture is not read back');
    await noWords('Receive, the card');
    // More options.
    await more(true);
    const opt = await pop.eval("({ name: document.querySelector('#recvMoreName').innerText, btn: document.querySelector('#btnRecvMore').innerText, full: document.querySelector('#btnDFull').innerText, amtLbl: document.querySelector('#recvDAmtLbl').innerText })");
    check('More options (Fewer options): where the name is changed, Show full code, the amount', opt.btn === 'Fewer options' && opt.name === `Your payment name is ${named}. You can change or remove it in Settings.` && opt.full === 'Show full code' && opt.amtLbl === 'Request a specific amount', opt);
    await shot('R-2-more.png');
    // The stock the wallet leaves with the name service, and its top-up after a lookup takes one.
    const want = nm.name;
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
    const own = await ui('default.prepareSend', { to: nm.address, amtS: '1', asset: USDX }).then((r) => 'resolved: ' + r.title, (e) => 'refused: ' + e.message);
    note('Send to the wallet\'s own name: ' + own);
    check('Send resolves the name to a signed code (here refused only for want of USDX)', !/did not sign|another wallet|No wallet/.test(own), own);
    if (process.env.FORGE_FILE) {
      writeFileSync(process.env.FORGE_FILE, 'address');
      const f1 = await ui('default.prepareSend', { to: nm.address, amtS: '1', asset: USDX }).then(() => 'no refusal', (e) => e.message);
      check('a code whose address the service swapped is refused', /did not sign, so nothing was sent/.test(f1), f1);
      writeFileSync(process.env.FORGE_FILE, 'key');
      const f2 = await ui('default.prepareSend', { to: nm.address, amtS: '1', asset: USDX }).then(() => 'no refusal', (e) => e.message);
      check('a code under a key the service put in place of the name\'s is refused', /belongs to another wallet than the one you paid before/.test(f2), f2);
      rmSync(process.env.FORGE_FILE, { force: true });
    }
    // Show full code: the code written out, carrying the name's LNURL-pay; Show name goes back.
    await pop.click('#btnDFull');
    const c1 = await waitFor("(()=>{ const t=document.querySelector('#recvDCode').innerText; return /[?&]lightning=LNURL1/.test(t) ? t : false })()", 120000).catch(() => null);
    check('Show full code writes the code out, which carries the name\'s LNURL-pay', !!c1);
    check('the line then says who it is for, and Show name is offered', /^For a wallet that can't look names up/.test(await lineOf()) && (await pop.eval("document.querySelector('#btnDFull').innerText")) === 'Show name');
    await shot('R-3-full-code.png');
    if (c1) {
      const url = lnurlDecode(param(c1, 'lightning'));
      check('it is the name\'s own LNURL-pay', url === `https://sequentiatestnet.com/.well-known/lnurlp/${want}`, url);
      const pr = await fetch(url.replace('https://sequentiatestnet.com', WELL_KNOWN)).then((r) => r.json()).catch((e) => ({ error: e.message }));
      check('which the service answers with a pay request', pr.tag === 'payRequest', { tag: pr.tag, reason: pr.reason });
      if (pr.callback) {
        const msat = 2000n * 1000n;
        const cb = await fetch(pr.callback + '?amount=' + msat).then((r) => r.json()).catch((e) => ({ error: e.message }));
        const d = cb.pr ? decodeBolt11(cb.pr) : null;
        check('a Lightning wallet paying it gets an invoice for the amount it chose, from this wallet', !!d && d.ok && d.chain === 'btc' && BigInt(d.amountMsat) === msat, cb.pr ? cb.pr.slice(0, 20) + '…' : cb);
      }
      note(`code with the name: ${c1.length} characters; the name: ${nm.address.length}`);
    }
    await noWords('Receive, the full code with a name');
    // New code, with the full code shown, moves it to a new address.
    await pop.click('#btnDNew');
    const c2 = await waitFor(`(()=>{ const t=document.querySelector('#recvDCode').innerText; return /^bitcoin:.*sequentia=/i.test(t) && t!==${JSON.stringify(c1)} ? t : false })()`, 120000).catch(() => null);
    check('New code moves the full code to a new address and makes its receive request new', !!c2 && addrOf(c1) !== addrOf(c2) && /^tb1/.test(addrOf(c2)) && param(c1, 'sequentia') !== param(c2, 'sequentia'), c2 && `${addrOf(c1)} -> ${addrOf(c2)}`);
    await shot('R-4-new-code.png');
    await pop.click('#btnDFull');
    await waitFor("document.querySelector('#recvDCode').classList.contains('hide')", 30000).catch(() => null);
    // Amounts: the full code, written out by the wallet's own answer.
    const setAmount = (v, ticker) => pop.eval(`(()=>{ const s=document.querySelector('#recvDAsset'); const o=[...s.options].find(o=>o.textContent.trim()===${JSON.stringify(ticker)}); if(!o) return 'no '+${JSON.stringify(ticker)}+': '+[...s.options].map(o=>o.textContent).join(','); s.value=o.value; s.dispatchEvent(new Event('change')); const i=document.querySelector('#recvDAmt'); i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); return true })()`);
    await waitFor("[...document.querySelector('#recvDAsset').options].length > 1", 60000).catch(() => null);
    const menu = await pop.eval("[...document.querySelector('#recvDAsset').options].map(o=>o.textContent.trim())");
    note('the amount\'s menu: ' + menu.join(', '));
    await setAmount('0.0002', 'BTC');
    await sleep(2500);
    check('with an amount the card offers no Show full code (the code is the full one)', (await pop.eval("document.querySelector('#btnDFull').classList.contains('hide')")));
    const c4 = await codeWith({ asset: 'BTC', amount: '0.0002' }, /[?&]lightning=LNTB/i);
    check('an amount in BTC: the code names it and carries an invoice, not the name', !!c4 && param(c4, 'amount') === '0.0002' && !/LNURL1/.test(c4), c4 && param(c4, 'lightning').slice(0, 16) + '…');
    await shot('R-5-amount-btc.png');
    const asset = menu.find((x) => x !== 'BTC');
    if (asset) {
      await setAmount('1', asset);
      const hex = (await ui('default.receiveChoices')).find((k) => k !== 'BTC');
      const c5 = await codeWith({ asset: hex, amount: '1' }, /[?&]lightning=(?!LNURL1)/i, 180000);
      check(`an amount in ${asset}: the code carries its invoice in the asset, and no BTC amount`, !!c5 && !/[?&]amount=/.test(c5), c5 && param(c5, 'lightning').slice(0, 16) + '…');
      await shot(`R-6-amount-${asset}.png`);
    } else check('the amount\'s menu lists an asset the operator receives over Lightning', false, menu);
    await setAmount('', 'BTC');
    // Confidential.
    await pop.eval("(()=>{ const c=document.querySelector('#recvDConf'); c.checked=true; c.dispatchEvent(new Event('change')); return true })()");
    await sleep(2500);
    const cc = await codeWith({ confidential: true }, /^tsqb1/);
    check('Confidential on: the code is the confidential address alone', !!cc && /^tsqb1[0-9a-z]+$/.test(cc), cc && cc.slice(0, 20) + '…');
    const said = await pop.eval("({ line: document.querySelector('#recvDLine').innerText, note: document.querySelector('#recvDConfNote').innerText, shown: !document.querySelector('#recvDConfNote').classList.contains('hide'), amount: !document.querySelector('#recvDAmtRow').classList.contains('hide') })");
    check('it says what stays public and shows no amount', said.shown && /BTC is never confidential/.test(said.note) && !said.amount && said.line === 'Any Sequentia asset, any amount, paid to your confidential address.', said);
    await shot('R-7-confidential.png');
    await noWords('Receive, Confidential on');
    await pop.click('[data-tab=balance]'); await sleep(500); await pop.click('[data-tab=receive]'); await sleep(2500);
    // Back on Receive: More options closed, Confidential off, the name's picture.
    check('leaving Receive closes More options and turns Confidential off again', !(await pop.eval("document.querySelector('#recvDConf').checked || !document.querySelector('#recvMore').classList.contains('hide')")) && (await lineOf()) === 'Scan or share to get paid in BTC or any asset.');
    // Send to a name nobody holds: the service is asked, and its refusal shown in its own words.
    const unknown = await ui('default.prepareSend', { to: 'nobody-' + want + '@sequentiatestnet.com', amtS: '1', asset: USDX }).then(() => 'no refusal', (e) => e.message);
    check('Send to a name nobody holds is refused in plain words', /No wallet goes by that name/.test(unknown), unknown);
    // `NAME_FILE=<file>`: the name is written there, and the drive waits (up to ten minutes) for
    // another wallet to pay it USDX, with this wallet open, as a payer of the name meets it. The card
    // says the payment.
    if (process.env.NAME_FILE) {
      writeFileSync(process.env.NAME_FILE, nm.address + '\n');
      note('waiting for a payment to ' + nm.address);
      const t1 = Date.now(); let got = null; const said2 = [];
      while (Date.now() - t1 < Number(process.env.NAME_WAIT_MS || 600000)) {
        const a = await pop.eval("document.querySelector('#recvArrive').classList.contains('hide') ? '' : document.querySelector('#recvArrive').innerText").catch(() => '');
        if (a && said2[said2.length - 1] !== a) said2.push(a);
        const ov = await ui('overview', { withLn: false }).catch(() => null); const r = ov && ov.rows.find((x) => x.ticker === 'USDX'); if (r && BigInt(r.total) > 0n) { got = r; break; } await sleep(3000);
      }
      check('another wallet paid the name, and USDX arrived', !!got, got ? `${got.total} atoms, ${((Date.now() - t1) / 1000).toFixed(1)} s after the name was handed out` : 'nothing in ten minutes');
      await sleep(5000);
      const a2 = await pop.eval("document.querySelector('#recvArrive').classList.contains('hide') ? '' : document.querySelector('#recvArrive').innerText").catch(() => '');
      if (a2 && said2[said2.length - 1] !== a2) said2.push(a2);
      check('Receive said the payment: "Received <amount> USDX."', said2.some((x) => /^Received [\d,.]+ USDX\.$/.test(x)), said2);
      await shot('R-8-received.png');
    }
    // Settings: the name is changed (Choose your own), then removed.
    await pop.click('[data-tab=settings]'); await sleep(1500);
    const sbtn = () => pop.eval("[...document.querySelectorAll('#nameBox button')].filter((b) => b.offsetParent).map((b) => b.textContent)");
    check('Settings holds the name, with Copy, Change name and Remove name', (await sbtn()).includes('Change name') && (await sbtn()).includes('Remove name') && (await sbtn()).includes('Copy'), await sbtn());
    await shot('R-9-settings-name.png');
    if (!WORD_NAME) {
      const mine = 'am5x' + Math.random().toString(36).slice(2, 8);
      await pop.click('#btnNameChoose'); await sleep(500);
      note('Change name form: ' + JSON.stringify(await pop.eval("({ form: !document.querySelector('#nameForm').classList.contains('hide'), name: document.querySelector('#nameAddr').innerText })")));
      await pop.set('nameInput', mine); await pop.click('#btnNameSave');
      await sleep(6000);
      note('after Save: ' + JSON.stringify(await pop.eval("({ st: document.querySelector('#nameStatus').innerText, save: document.querySelector('#btnNameSave').textContent })")) + ' ' + JSON.stringify(await ui('default.name')));
      const n2 = await nameState((n) => n.name === mine && n.verified, 20000);
      if (!n2 || n2.name !== mine) note('direct register: ' + JSON.stringify(await ui('default.nameRegister', { name: mine + 'x' }).then((r) => r, (e) => 'ERR ' + e.message)));
      if (!n2 || n2.name !== mine) note('Change name: ' + JSON.stringify(await pop.eval("({ status: document.querySelector('#nameStatus').innerText, form: !document.querySelector('#nameForm').classList.contains('hide'), input: document.querySelector('#nameInput').value })")));
      check('Change name makes it the chosen one', !!n2 && n2.name === mine, n2 && n2.address);
      await pop.click('[data-tab=receive]'); await sleep(2500);
      await more(true);
      const o2 = await pop.eval("document.querySelector('#recvMoreName').innerText");
      check('Receive follows it: More options names the new name', o2.includes(`${mine}@sequentiatestnet.com`) || o2.toLowerCase().includes(mine), o2);
      await more(false);
      await pop.click('[data-tab=settings]'); await sleep(1000);
    }
    await pop.click('#btnNameRemove');
    const gone = await nameState((n) => !n.name, 60000);
    check('Remove name removes it', !!gone && !gone.name, gone);
    await pop.click('[data-tab=receive]'); await sleep(3000);
    const c7 = await codeWith({ full: false }, /^bitcoin:/i, 60000);
    check('with the name removed, the picture is the full code and it carries no LNURL-pay', !!c7 && !/LNURL1/.test(c7), c7 && c7.slice(0, 40) + '…');
    await shot('R-10-no-name.png');
    // A name the person removed is not made again by itself.
    await ui('default.nameEnsure').catch(() => {});
    await sleep(15000);
    const again = await ui('default.name').catch(() => null);
    check('a removed name is not made again by itself', !!again && !again.name && again.removed === true, again && { name: again.name, removed: again.removed });
  } finally {
    check('no error or exception in the extension\'s contexts', !b.problems.length, b.problems.slice(0, 10));
    await b.close().catch(() => {});
  }
}

main().then(() => { note(`done, ${failures} failed`); process.exit(failures ? 1 : 0); },
  (e) => { note('FAIL ' + (e && e.stack || e)); process.exit(1); });
