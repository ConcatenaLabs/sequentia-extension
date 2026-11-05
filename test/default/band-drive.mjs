#!/usr/bin/env node
// The Bitcoin ark's band and the Lightning limit on a receive (src/ark-band.js), in default mode
// against the live testnet: Ambra browser from this checkout, headless, one wallet kept in <work>
// between runs, one step a run.
//
//   setup                 a new wallet in default mode (its phrase in <work>/phrase, mode 600), the
//                         band's figures set to { board 70, hold 140, direct 70 } USD, and the
//                         faucet's BTC asked to the wallet's address
//   refill [minutes]      waits until the confirmed BTC at the address has moved into the ark, at
//                         most the resting level; writes what the ark and the address hold
//   down [minutes]        sets { board 30, hold 60 }: the ark, holding more than 60 USD, moves
//                         everything above 30 USD to the wallet's own address in one move
//   codes                 the receive code and the review: an amount of `direct` or more carries
//                         neither the ark's address nor an invoice, and a payment of it reviews to
//                         the address with the sentence that says why; an amount over the operator's
//                         published limit on one Lightning payment in carries no invoice, one under
//                         it does (figures set to no `direct` for that part)
//   state                 what the ark, the address and the overview hold now
//
//   CHROME=… node test/default/band-drive.mjs <work> <step> [args…]
//
// The figures are set in the extension's local storage (`ext.arkLimits`), as a test may. Every
// default-mode screen read here is checked against the words default mode never says.
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '../leaves/cdp.mjs';
import { forbiddenIn } from '../../vendor/user-trade.js';
import { readPayCode } from '../../vendor/pay-code.js';

const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const CHROME = process.env.CHROME;
const PW = 'band-drive-password';
const [work, step, ...rest] = process.argv.slice(2);
if (!CHROME || !work || !step) { console.error('usage: CHROME=… node test/default/band-drive.mjs <work> <step> [args…]'); process.exit(2); }
const out = join(work, 'evidence'); mkdirSync(out, { recursive: true });
const logf = join(out, 'drive.log');
const note = (s) => { const l = `[${new Date().toISOString()}] ${step}: ${s}`; console.log(l); appendFileSync(logf, l + '\n'); };
let failures = 0;
const check = (name, ok, detail) => { note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); if (!ok) failures++; return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const shot = async (p, name) => { const f = join(out, `${String(Date.now()).slice(-6)}-${String(++n).padStart(2, '0')}-${step}-${name}.png`); await p.shot(f); };

const b = new Browser({ chrome: CHROME, profile: join(work, 'chrome-profile'), ext: EXT, consoleLog: join(out, `console-${step}.log`), headless: true });

async function unlock() {
  const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
  await pop.eval("document.body.style.width='380px'; true");
  await pop.waitFor("(document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null && !!document.querySelector('#btnUnlock').onclick) || (document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide'))", 60000);
  if (await pop.eval("!!(document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null)")) {
    await pop.set('unlockPw', PW); await pop.click('#btnUnlock');
  }
  await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
  return pop;
}
const ui = async (pop, method, params = {}) => {
  const r = await pop.eval(`new Promise((ok) => chrome.runtime.sendMessage({ scope: 'ui', method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }, (r) => ok(r)))`);
  if (!r || !r.ok) throw new Error(method + ': ' + ((r && r.error) || 'no answer'));
  return r.result;
};
const setFigures = (pop, f) => pop.eval(`chrome.storage.local.set({ 'ext.arkLimits': ${JSON.stringify(f)} }).then(() => true)`);
// What the ark holds as the service worker last kept it (`ext.ark.sum`, the host's figures), and
// the BTC at the wallet's address.
async function held(pop) {
  const sum = await pop.eval("chrome.storage.local.get('ext.ark.sum').then((o) => Object.values(o['ext.ark.sum'] || {})[0] || null)");
  const at = await ui(pop, 'default.btcAtAddress').catch(() => ({ sats: null }));
  return { ark: sum, address: at.sats };
}
// The console lines of every context of the extension this run, as cdp.mjs writes them.
const consoleHas = (re) => { try { return re.test(readFileSync(join(out, `console-${step}.log`), 'utf8')); } catch { return false; } };

try {
  await b.launch(step);
  await b.serviceWorker();
  await sleep(2000);
  if (step === 'setup') {
    const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    await pop.waitFor("document.querySelector('#btnStartCreate') && document.querySelector('#btnStartCreate').offsetParent !== null && !!document.querySelector('#btnStartCreate').onclick", 60000);
    await pop.click('#btnStartCreate');
    await pop.waitFor("document.querySelector('#newPhrase').dataset.phrase");
    const phrase = await pop.eval("document.querySelector('#newPhrase').dataset.phrase");
    writeFileSync(join(work, 'phrase'), phrase + '\n', { mode: 0o600 });
    await pop.set('createPw', PW); await pop.set('createPw2', PW);
    await pop.click('#btnCreateGo');
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    note('wallet created (phrase kept in the work directory, mode 600)');
    await setFigures(pop, { btc: { board: 70, hold: 140, direct: 70 } });
    note('figures { board 70, hold 140, direct 70 }');
    const f = await ui(pop, 'default.faucet', { asset: 'BTC' });
    check('the faucet paid BTC to the address', /BTC/.test(f.text), f.text);
    await shot(pop, 'funded');
  } else if (step === 'refill') {
    const pop = await unlock();
    const until = Date.now() + Number(rest[0] || 60) * 60000;
    let h = await held(pop);
    note('before: ' + JSON.stringify(h));
    while (Date.now() < until && !(h.ark && BigInt(h.ark.total || 0) > 0n)) {
      await ui(pop, 'sync').catch(() => {});
      await sleep(30000);
      h = await held(pop);
      note('ark ' + JSON.stringify(h.ark) + ' address ' + h.address);
    }
    const boards = (readFileSync(join(out, `console-${step}.log`), 'utf8').match(/\[btc ark\] boarded \d+ sat in \w+/g) || []);
    const st = { lastBoard: boards.length ? { value: { amount: boards[boards.length - 1].match(/boarded (\d+)/)[1] } } : null };
    note('boards: ' + JSON.stringify(boards));
    const price = await pop.eval("fetch('https://sequentiatestnet.com/prices').then((r) => r.json()).then((d) => d.tBTC.price)");
    const cap = BigInt(Math.floor((70 * 1e8) / price));
    check('the ark was refilled', h.ark && BigInt(h.ark.total || 0) > 0n, h.ark);
    check('the board carried at most the resting level', st.lastBoard && st.lastBoard.value && BigInt(st.lastBoard.value.amount) <= cap, { board: st.lastBoard && st.lastBoard.value, cap: String(cap), price });
    check('the rest stayed at the address', h.address != null && BigInt(h.address) > 0n, h.address);
    writeFileSync(join(out, 'refill.json'), JSON.stringify({ held: h, lastBoard: st.lastBoard, price, cap: String(cap) }, null, 2));
    await shot(pop, 'refilled');
  } else if (step === 'down') {
    const pop = await unlock();
    const before = await held(pop);
    note('before: ' + JSON.stringify(before));
    await setFigures(pop, { btc: { board: 30, hold: 60, direct: 70 } });
    note('figures { board 30, hold 60, direct 70 }');
    const until = Date.now() + Number(rest[0] || 20) * 60000;
    let h = before;
    while (Date.now() < until && !consoleHas(/\[ark limit\] moved/)) { await sleep(15000); h = await held(pop); note('ark ' + JSON.stringify(h.ark) + ' address ' + h.address); }
    await sleep(10000); h = await held(pop);
    const line = (readFileSync(join(out, `console-${step}.log`), 'utf8').match(/.*\[ark limit\].*/g) || []).join(' | ');
    check('everything above the resting level moved to the address in one move', /\[ark limit\] moved \d+ sat/.test(line), line);
    writeFileSync(join(out, 'down.json'), JSON.stringify({ before, after: h, line }, null, 2));
    await shot(pop, 'moved-down');
  } else if (step === 'codes') {
    const pop = await unlock();
    const price = await pop.eval("fetch('https://sequentiatestnet.com/prices').then((r) => r.json()).then((d) => d.tBTC.price)");
    const info = await pop.eval("fetch('https://sequentiatestnet.com/arca/v1/info').then((r) => r.json())");
    const si = info.server_info || info;
    const maxIn = BigInt(si.lightning.bitcoin.node.max_payment.receive);
    note(`price ${price}; the operator's Bitcoin node takes at most ${maxIn} sat in one payment`);
    const code = async (sats) => { const r = await ui(pop, 'default.receiveCode', { sats: String(sats), fresh: false }); return { r, c: readPayCode(r.code) }; };
    await setFigures(pop, { btc: { board: 30, hold: 60, direct: 70 } });
    const big = BigInt(Math.ceil((70 * 1e8) / price)) + 1000n;
    const a = await code(big);
    check(`a code for ${big} sat (70 USD or more) carries no ark and no invoice`, !a.c.ark && !a.c.lightning && !!a.c.address, { ark: !!a.c.ark, lightning: !!a.c.lightning, amount: a.c.amount });
    const s = await code(10000);
    check('a code for 10000 sat carries the ark and an invoice', !!s.c.ark && !!s.c.lightning, { ark: !!s.c.ark, lightning: !!s.c.lightning });
    // The payer's review of the large code: to the address, and why.
    const plan = await ui(pop, 'default.prepareSend', { to: a.r.code, amtS: (Number(big) / 1e8).toFixed(8), asset: 'BTC' });
    const said = [plan.title, ...(plan.lines || [])].join(' | ');
    check('paying it reviews to the address, saying why', /A payment of 70 USD or more goes to the address\./.test(said) && /To: tb1/.test(said), said);
    check('the review says none of the words default mode never says', forbiddenIn(said).length === 0, forbiddenIn(said));
    // The Lightning limit: no `direct`, so only the operator's limit decides the invoice.
    await setFigures(pop, { btc: { board: 30, hold: 60, direct: null } });
    const over = await code(maxIn + 1n);
    check(`a code for ${maxIn + 1n} sat, one over the operator's limit, carries no invoice`, !over.c.lightning && !!over.c.ark, { ark: !!over.c.ark, lightning: !!over.c.lightning });
    const at = await code(maxIn);
    check(`a code for ${maxIn} sat, at the limit, carries an invoice`, !!at.c.lightning, { lightning: !!at.c.lightning });
    await setFigures(pop, { btc: { board: 30, hold: 60, direct: 70 } });
    // The popup's own receive screen, in default mode.
    await pop.click('[data-tab=receive]'); await sleep(3000);
    const recv = await pop.text('#tReceive');
    check('the receive screen says none of the words default mode never says', forbiddenIn(recv).length === 0, forbiddenIn(recv));
    await shot(pop, 'receive');
    writeFileSync(join(out, 'codes.json'), JSON.stringify({ price, maxIn: String(maxIn), large: a.c, small: { ark: !!s.c.ark, lightning: !!s.c.lightning }, review: said }, null, 2));
  } else if (step === 'state') {
    const pop = await unlock();
    note(JSON.stringify(await held(pop)));
    const ov = await ui(pop, 'overview', { withLn: false });
    note('BTC row: ' + JSON.stringify((ov.rows || []).find((r) => r.key === 'BTC')));
    await shot(pop, 'state');
  } else throw new Error('no step ' + step);
} catch (e) {
  failures++;
  note('FAIL ' + ((e && e.stack) || e));
} finally {
  await b.close().catch(() => {});
  note(failures ? `${failures} failure(s)` : 'all ok');
  process.exit(failures ? 1 : 0);
}
