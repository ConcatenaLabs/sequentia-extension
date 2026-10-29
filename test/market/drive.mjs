#!/usr/bin/env node
// Drives the SeqDEX site's default view end to end, in headless Chromium with this
// extension loaded, two browser profiles (a maker and a taker), on a private chain
// anchored to a regtest parent with a local on-chain relay (test/market/chain.mjs):
//
//  - the default page is read for any word of a rail or of developer mode, in user mode,
//    and its navigation names no room; developer mode brings the rooms' links back;
//  - the maker places a limit order through the page's one form and one button: the
//    approval shows what is given, got and paid, each in the reference currency; the
//    order is listed under Open;
//  - the taker sees it in the merged book and fills part of it with a market order; its
//    trade reads Sent, then Settled once the relay calls the fill final;
//  - the maker's open order shows the part filled; the taker's limit order fills the
//    rest; the maker's order moves to History;
//  - the taker's limit order that crosses nothing rests and shows in the book as a bid
//    (an order on the reversed market);
//  - the maker's next order cannot be taken back before its time, and the page says
//    when; after it, it is taken back from the page;
//  - a trade against BTC this wallet cannot settle is refused in plain words.
// Each step is screenshotted; the service worker's console is read after each start.
//
// The extension is copied into the work directory with its engine pointed at the
// private chain's network (the same one rewrite test/regtest/loader.mjs makes); the
// browser reaches every endpoint at https://sequentiatestnet.com through the stand-in
// box (test/market/box.mjs).
//
//   CHROME=… SEQUENTIAD=… SEQOBD=… SEQDEX_WEB=… node test/market/drive.mjs <evidence-dir> <work-dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from '../leaves/cdp.mjs';
import { startBox } from './box.mjs';
import { startChain } from './chain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../..');
const { CHROME, SEQUENTIAD, SEQOBD } = process.env;
const SITE = process.env.SEQDEX_WEB && resolve(process.env.SEQDEX_WEB);
const out = resolve(process.argv[2] || 'market-evidence');
const work = resolve(process.argv[3] || '/tmp/market-drive');
if (!CHROME || !SEQUENTIAD || !SEQOBD || !SITE) { console.error('set CHROME, SEQUENTIAD, SEQOBD and SEQDEX_WEB'); process.exit(2); }
mkdirSync(out, { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'drive.log');
writeFileSync(logFile, '');
const note = (s) => { console.log(s); appendFileSync(logFile, s + '\n'); };
let failures = 0, step = 0;
function check(name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  if (!ok) failures++;
  return ok;
}
async function until(what, fn, ms = 120000, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(every);
  }
}

// Words of a rail or of developer mode, none of which the default page may show.
const DEV_WORDS = /\b(lightning|on-chain|onchain|covenant|leaf|leaves|round|operator|relay|atoms?|lndex|confidential|channels?|mempool|anchor|developer|rails?|htlc|rooms?|forfeit|submarine|maker|taker)\b/i;

const PW = 'drive-password';
const DEX = 'https://sequentiatestnet.com/dex/';

let chain = null, box = null;
const browsers = [];
async function main() {
  // ---- the extension, pointed at the private chain's network ----
  chain = await startChain({ sequentiad: SEQUENTIAD, seqobd: SEQOBD, work: join(work, 'chain'), log: note });
  const { X, Y } = chain;
  const EXT = join(work, 'extension');
  rmSync(EXT, { recursive: true, force: true });
  cpSync(SRC, EXT, { recursive: true, filter: (p) => !/\/(\.git|test|node_modules)(\/|$)/.test(p.slice(SRC.length)) });
  const engineFile = join(EXT, 'src/engine.js');
  const src = readFileSync(engineFile, 'utf8');
  const from = 'network = Network.sequentiaTestnet();';
  if (src.split(from).length !== 2) throw new Error('engine.js: the network line changed; update the drive');
  writeFileSync(engineFile, src.replace(from, `network = Network.regtestWithGenesis(new AssetId(${JSON.stringify(chain.policy)}), ${JSON.stringify(chain.genesis)});`));
  note(`extension copied to ${EXT}, its engine on the private chain (policy ${chain.policy.slice(0, 12)}…, genesis ${chain.genesis.slice(0, 12)}…)`);

  // ---- the stand-in box ----
  const key = join(work, 'box.key'), crt = join(work, 'box.crt');
  if (!existsSync(crt)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=sequentiatestnet.com', '-addext', 'subjectAltName=DNS:sequentiatestnet.com'], { stdio: 'ignore' });
  box = await startBox({ tls: { key: readFileSync(key), cert: readFileSync(crt) }, esplora: chain.shim.url, relay: chain.relay, rpc: chain.rpc, site: SITE,
    assets: { [X]: ['GOLD', 'Gold (test)', 8], [Y]: ['USDX', 'Dollar (test)', 8] }, prices: { GOLD: 4146, USDX: 1, SEQ: 0.37, tBTC: 84200 },
    instantPairs: [[X, 'BTC']] });
  note(`box at 127.0.0.1:${box.port} (https://sequentiatestnet.com for the browsers)`);

  const browser = (name) => {
    const b = new Browser({
      chrome: CHROME, profile: join(work, name + '-profile'), ext: EXT, consoleLog: join(out, `console-${name}.log`), headless: true,
      extraArgs: ['--ignore-certificate-errors', '--window-size=1300,1700', `--host-resolver-rules=MAP sequentiatestnet.com 127.0.0.1:${box.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    });
    b.name = name; browsers.push(b);
    return b;
  };
  async function shot(p, name) {
    step++;
    const f = join(out, `${String(step).padStart(2, '0')}-${name}.png`);
    await p.shot(f);
    note(`     screenshot ${f.split('/').pop()}`);
  }
  async function readConsole(b, label) {
    await b.serviceWorker();
    await sleep(3000);
    const mine = b.problems.splice(0);
    check(`${b.name} ${label}: the service worker started and its console shows no exception or error`, mine.length === 0, mine.length ? mine : undefined);
  }
  async function approve(b, name, expect, decide = true) {
    const t = await b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), 120000);
    const a = await b.pageOf(t.targetId);
    await a.waitFor("document.querySelector('#reqCard') && !document.querySelector('#reqCard').classList.contains('hide')", 30000);
    const title = await a.text('#reqTitle');
    const body = await a.text('#reqCard');
    const miss = expect.filter((re) => !re.test(body));
    check(`${b.name}: approval "${title}" shown`, miss.length === 0, miss.length ? { missing: miss.map(String), body: body.replace(/\s+/g, ' ').slice(0, 1200) } : body.replace(/\s+/g, ' ').slice(0, 1000));
    await shot(a, `${b.name}-approval-${name}`);
    await a.click(decide ? '#btnApprove' : '#btnReject');
    for (let i = 0; i < 100 && (await b.targets()).some((x) => x.targetId === t.targetId); i++) await sleep(100);
    return body;
  }
  const popup = (b) => b.page(`chrome-extension://${b.extId}/popup/popup.html`);
  async function createWallet(b) {
    const pop = await popup(b);
    await pop.waitFor("document.querySelector('#btnStartCreate') && document.querySelector('#btnStartCreate').offsetParent !== null && !!document.querySelector('#btnStartCreate').onclick", 60000);
    await pop.click('#btnStartCreate');
    await pop.waitFor("document.querySelector('#newPhrase').dataset.phrase");
    await pop.set('createPw', PW); await pop.set('createPw2', PW);
    await pop.click('#btnCreateGo');
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    return pop;
  }
  async function setMode(pop, mode) {
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide') && !!document.querySelector('[data-tab=settings]')", 90000);
    await pop.click('[data-tab=settings]');
    await pop.waitFor("!!document.querySelector('#setMode')", 30000);
    await pop.eval(`(()=>{const s=document.querySelector('#setMode'); s.value='${mode}'; s.dispatchEvent(new Event('change')); return true})()`);
  }
  const call = (p, method, params = {}) => p.eval(`window.sequentia.request({method:${JSON.stringify(method)}, params:${JSON.stringify(params)}}).then((v)=>({ok:true,v}),(e)=>({ok:false,e:e.message}))`);
  async function market(b, pair = 'GOLD-USDX') {
    const p = await b.page(DEX + 'market.html?pair=' + pair);
    await p.waitFor("document.querySelector('#fGo') && /\\//.test(document.querySelector('#pairName').innerText)", 60000);
    return p;
  }
  async function connect(b, p) {
    await p.click('#btnConnect');
    await p.waitFor("document.querySelector('#connectMenu [data-connector=\"extension\"]') && !document.querySelector('#connectMenu').hidden", 30000);
    const menu = (await p.text('#connectMenu')).replace(/\s+/g, ' ');
    check(`${b.name}: the chooser lists Ambra browser, ready`, /Ambra browser\s*Ready/.test(menu), menu);
    await p.click('#connectMenu [data-connector="extension"]');
    await approve(b, 'connect', [/connect/i]);
    await p.waitFor("document.querySelector('#btnConnect').classList.contains('ok')", 60000);
  }
  // One form, one button: fills the form as a user does and clicks it.
  async function trade(b, p, { type, side, amount, price }, name, expect) {
    await p.click('#type-' + type); await p.click('#side-' + side);
    await p.set('fAmount', amount);
    if (price != null) await p.set('fPrice', price);
    await p.eval("document.querySelector('#fStatus').textContent=''");
    await shot(p, `${b.name}-form-${name}`);
    await p.click('#fGo');
    const which = await Promise.race([
      b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), 120000).then(() => 'window', () => 'timeout'),
      p.waitFor("document.querySelector('#fStatus').classList.contains('err')", 120000).then(() => 'refused', () => 'timeout'),
    ]);
    if (which !== 'window') return { ok: false, why: await p.text('#fStatus') };
    await approve(b, name, expect);
    await p.waitFor("document.querySelector('#fStatus').classList.contains('ok') || document.querySelector('#fStatus').classList.contains('err')", 300000);
    const why = await p.text('#fStatus');
    return { ok: await p.eval("document.querySelector('#fStatus').classList.contains('ok')"), why };
  }
  // Your orders, as the pair's page shows them: the rows of its Open orders tab, and of its
  // Trades and Order history tabs (history), each row's text on one line.
  async function orders(p) {
    const rows = async (tab) => {
      await p.click(`#ordTabs button[data-o="${tab}"]`); await sleep(1500);
      return p.eval("[...document.querySelectorAll('#ordersBox tbody tr')].map((d)=>d.innerText.replace(/\\s+/g,' ').trim())");
    };
    const open = await rows('open'), history = [...await rows('trades'), ...await rows('history')];
    await p.click('#ordTabs button[data-o="open"]');
    return { open, history };
  }
  async function refreshed(p, pred, what, ms = 180000) {
    return until(what, async () => { await p.eval('location.reload(), true').catch(() => {}); await sleep(4000); await p.waitFor("!!document.querySelector('#fGo')", 30000); await sleep(2000); const o = await orders(p); return pred(o) ? o : null; }, ms, 2000);
  }
  // The wallet's one figure for an asset, in whole units, as the pages read it.
  async function figure(p, asset) {
    const r = await call(p, 'getBalances');
    if (!r.ok) return null;
    const b = r.v.total || { ...(r.v.assets || {}) };
    if (!r.v.total) for (const [h, v] of Object.entries(r.v.leaves || {})) b[h] = String(BigInt(b[h] || 0) + BigInt(v));
    return Number(b[asset] || 0) / 1e8;
  }
  async function balancesShow(p, asset, pred, what) {
    return until(what, async () => pred(await figure(p, asset)), 180000, 2000);
  }
  const bookText = (p, side) => p.text(side === 'ask' ? '#asks' : '#bids');

  const maker = browser('maker'), taker = browser('taker');
  await maker.launch('maker start'); await readConsole(maker, 'start');
  await taker.launch('taker start'); await readConsole(taker, 'start');
  await createWallet(maker); await createWallet(taker);
  const mp = await market(maker), tp = await market(taker);
  await connect(maker, mp); await connect(taker, tp);
  const mAddr = (await call(mp, 'getAccounts')).v.accounts[0].address, tAddr = (await call(tp, 'getAccounts')).v.accounts[0].address;
  await chain.fund(mAddr, X, 2); await chain.fund(tAddr, Y, 20000); await chain.fund(tAddr, X, 1);
  await chain.mine(1);
  note(`maker ${mAddr} funded with 2 GOLD; taker ${tAddr} with 20000 USDX and 1 GOLD`);
  await balancesShow(mp, X, (v) => v === 2, 'the maker\'s balances');
  await balancesShow(tp, Y, (v) => v === 20000, 'the taker\'s balances');

  // ---- the default page: no rail, no developer word ----
  const words = (await mp.eval('document.body.innerText')).match(DEV_WORDS);
  check('user mode: the default page shows no word of a rail or of developer mode', !words, words ? words[0] : undefined);
  const nav = await mp.text('#devNav');
  check('user mode: the navigation names no room', !/Rooms|LNDEX|On-chain|Confidential|Channels|Leaves|Pools/.test(nav), nav.replace(/\s+/g, ' '));
  await shot(mp, 'maker-default-view');

  // ---- the maker's limit order rests ----
  let r = await trade(maker, mp, { type: 'limit', side: 'sell', amount: '0.5', price: '4146' }, 'limit-sell',
    [/Make this trade\?/, /Place an order on the book to sell 0\.5 GOLD at your price/, /You give\s*0\.5 GOLD \(≈ 2,073 USD\)/, /You get\s*up to 2073 USDX \(≈ 2,073 USD\)/, /Fees\s*0\.0000\d+ GOLD \(≈/, /Taking it back/]);
  check('maker: the limit order is placed', r.ok && /Your order is on the book/.test(r.why), r.why);
  await chain.mine(1);
  let o = await refreshed(mp, (x) => x.open.length === 1 && /0\.5 GOLD/.test(x.open[0]) && /\b0%/.test(x.open[0]), 'the maker\'s open order');
  check('maker: the order is listed under Open', true, o.open[0].replace(/\s+/g, ' '));
  // The market has an order now, so the relay lists it: once each way round.
  const rows = await until('the market in the Tickers panel', async () => { const r = await mp.eval("[...document.querySelectorAll('#tickers tr[data-pair]')].map((r)=>r.dataset.pair)"); return r.includes('GOLD-USDX') ? r : null; }, 60000, 2000).catch(() => []);
  check('the Tickers panel has the pair once each way round', rows.filter((x) => x === 'GOLD-USDX').length === 1 && rows.filter((x) => x === 'USDX-GOLD').length === 1, rows);
  await shot(mp, 'maker-open-order');

  // ---- the taker's market order fills part of it ----
  await tp.eval('location.reload(), true'); await sleep(3000);
  await until('the ask in the taker\'s book', async () => /4,146\.00/.test(await bookText(tp, 'ask')) || (await tp.eval('location.reload(), true').then(() => sleep(3000)).then(() => false)), 60000, 1000);
  check('taker: the merged book shows the ask at 4,146.00 USDX', true, (await bookText(tp, 'ask')).replace(/\s+/g, ' '));
  await shot(tp, 'taker-book-with-ask');
  r = await trade(taker, tp, { type: 'market', side: 'buy', amount: '0.2' }, 'market-buy',
    [/Buy 0\.2 GOLD at the best prices on the book/, /You give\s*829\.2 USDX \(≈ 829\.2 USD\)/, /You get\s*0\.2 GOLD \(≈ 829\.2 USD\)/, /Fees\s*0\.0000\d+ USDX/]);
  check('taker: the market order filled', r.ok && /Traded with 1 order/.test(r.why), r.why);
  o = await refreshed(tp, (x) => x.history.some((h) => /Swapped 829\.2 USDX for 0\.2 GOLD/.test(h)), 'the taker\'s trade under Trades');
  check('taker: the trade reads Sent before the relay calls it final', o.history.some((h) => /Swapped 829\.2 USDX for 0\.2 GOLD/.test(h) && /Sent$/.test(h)), o.history);
  await shot(tp, 'taker-history-sent');
  await chain.mine(1);
  for (let i = 0; i < 6; i++) await chain.bury(1);
  o = await refreshed(tp, (x) => x.history.some((h) => /for 0\.2 GOLD/.test(h) && /Settled$/.test(h)), 'the taker\'s trade settled');
  check('taker: the trade reads Settled once the relay calls the fill final', true, o.history);
  await shot(tp, 'taker-history-settled');

  // ---- the maker sees the part filled ----
  o = await refreshed(mp, (x) => x.open.length === 1 && /0\.5 GOLD/.test(x.open[0]) && /\b40%/.test(x.open[0]), 'the maker\'s order partly filled');
  check('maker: the open order shows 40% (0.2 of 0.5) filled', true, o.open[0]);
  await shot(mp, 'maker-open-order-part-filled');

  // ---- the taker's limit order fills the rest ----
  r = await trade(taker, tp, { type: 'limit', side: 'buy', amount: '0.3', price: '4146' }, 'limit-buy-crossing',
    [/Buy 0\.3 GOLD now at your price or better\./, /You give\s*1243\.8 USDX/, /You get\s*0\.3 GOLD/]);
  check('taker: the limit order filled the rest', r.ok && /Traded with 1 order/.test(r.why), r.why);
  await chain.mine(1);
  for (let i = 0; i < 6; i++) await chain.bury(1);
  o = await refreshed(mp, (x) => x.open.length === 0 && x.history.some((h) => /Sell/.test(h) && /0\.5 GOLD/.test(h) && /Settled$/.test(h)), 'the maker\'s order in Order history');
  check('maker: the order moved to Order history, filled and settled', true, o.history);
  await balancesShow(mp, Y, (v) => v >= 2072 && v < 2074, 'the maker\'s proceeds in its USDX figure');
  check('maker: its USDX figure holds the proceeds', true, await figure(mp, Y));
  await shot(mp, 'maker-history-filled');

  // ---- a resting buy shows as a bid ----
  r = await trade(taker, tp, { type: 'limit', side: 'buy', amount: '0.1', price: '4000' }, 'limit-buy-rests',
    [/Place an order on the book to buy 0\.1 GOLD at your price/, /You give\s*400 USDX/, /You get\s*up to 0\.1 GOLD/]);
  check('taker: the buy order rests', r.ok && /Your order is on the book/.test(r.why), r.why);
  await chain.mine(1);
  await until('the bid in the maker\'s book', async () => /4,000\.00/.test(await bookText(mp, 'bid')) || (await mp.eval('location.reload(), true').then(() => sleep(3000)).then(() => false)), 90000, 1000);
  check('maker: the merged book shows the taker\'s order as a bid at 4,000.00 USDX', true, (await bookText(mp, 'bid')).replace(/\s+/g, ' '));
  await shot(mp, 'maker-book-with-bid');

  // ---- an order taken back after its time ----
  r = await trade(maker, mp, { type: 'limit', side: 'sell', amount: '0.1', price: '5000' }, 'limit-sell-2', [/Place an order on the book to sell 0\.1 GOLD/]);
  check('maker: a second order rests', r.ok, r.why);
  await chain.mine(1);
  o = await refreshed(mp, (x) => x.open.some((t) => /0\.1 GOLD/.test(t) && /from /.test(t) && /Stays on the book/.test(t)), 'the second order, with when it can be taken back');
  check('maker: the page says when the order can be taken back, and offers no button before', !(await mp.eval("!!document.querySelector('#ordersBox tbody button')")), o.open);
  await shot(mp, 'maker-order-before-its-time');
  await chain.advance(86400 + 600);
  await refreshed(mp, () => true, 'reload');
  await mp.waitFor("!!document.querySelector('#ordersBox tbody button')", 60000);
  await shot(mp, 'maker-order-take-back-offered');
  await mp.click('#ordersBox tbody button');
  await approve(maker, 'take-back', [/Take back your order\?/, /Take back what is left of your order: 0\.1 GOLD/, /You get back\s*0\.0999\d* GOLD/]);
  await chain.mine(1);
  o = await refreshed(mp, (x) => x.history.some((h) => /Sell/.test(h) && /5,000\.00/.test(h) && /0\.1 GOLD/.test(h) && /Taken back$/.test(h)), 'the order taken back');
  check('maker: the order is taken back and in Order history', true, o.history);
  await shot(mp, 'maker-history-taken-back');
  const words2 = (await mp.eval('document.body.innerText')).match(DEV_WORDS);
  check('user mode: with orders and history on it, the default page still shows no word of a rail or of developer mode', !words2, words2 ? words2[0] : undefined);

  // ---- against BTC ----
  const groups = await mp.eval("[...document.querySelectorAll('#tickers tr.first td.nm')].map((d)=>d.innerText)");
  check('the Tickers panel lists BTC first when a market has it', !groups.includes('BTC') || groups[0] === 'BTC', groups);
  const mb = await market(maker, 'GOLD-BTC').catch(() => null);
  if (mb && /GOLD\s*\/\s*BTC/.test(await mb.text('#pairName'))) {
    r = await trade(maker, mb, { type: 'market', side: 'buy', amount: '0.01' }, 'btc-refused', []);
    check('a trade against BTC with nothing to take is refused in plain words, before any approval', !r.ok && !DEV_WORDS.test(r.why), r.why);
    await shot(mb, 'maker-btc-refused');
  } else {
    note('     no BTC pair on this chain\'s books (no instant makers here)');
  }

  // ---- developer mode brings the rooms back ----
  const pop = await popup(maker);
  await setMode(pop, 'developer');
  const dp = await market(maker);
  await dp.waitFor("/LNDEX/.test(document.querySelector('#devNav').innerText)", 30000);
  check('developer mode: the navigation names the rooms', /LNDEX/.test(await dp.text('#devNav')), await dp.text('#devNav'));
  await shot(dp, 'maker-developer-view');
  await setMode(pop, 'user');

  await readConsole(maker, 'end'); await readConsole(taker, 'end');
}

try { await main(); }
catch (e) { failures++; note('FAIL ' + (e && e.stack || e)); }
finally {
  for (const b of browsers) await b.close().catch(() => {});
  try { await box?.close(); } catch {}
  try { await chain?.stop(); } catch {}
  note(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
}
