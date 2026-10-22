#!/usr/bin/env node
// Drives orders resting as leaves in the operator's tree end to end, in headless
// Chromium with this extension loaded, three browser profiles (a maker and two
// takers), against a local operator on an anchored regtest chain, a local relay
// (seqobd -arca-operator) and the SeqDEX site:
//
//  - every wallet is created in the popup, put in developer mode and joins the
//    operator; the maker boards leaves of X, the takers leaves of Y;
//  - the maker rests three orders through the site's leaves room (`restOrder`, the
//    approval shown each time): A, the one the takers fill, B, which it cancels later,
//    and C, whose REFUND lies a little over seven hours ahead; the round that makes the
//    leaves is final, the wallet hands its forfeits over and the library publishes each
//    order; the wallet lists each on the relay, which admits it from the operator's
//    state view; the maker's browser then closes;
//  - a taker finds A in the site's default view (one more order of the market, with its
//    price and size, and no leaf, operator or template named) and buys part of it with
//    the default view's form (`placeOrder`, which fills it in the tree); the book then
//    shows the remainder, and the leaves room shows the operator, the order id and the
//    locator (the coin it rests at now, and what that coin holds);
//  - the second taker's fill is quoted and shown; before it is approved the first taker
//    fills A again, so the order moves: the operator answers the shown fill
//    `order_moved`, and the wallet fills it where it rests now, for the same amount and
//    price; a fourth fill, from the default view, takes the rest, and the relay
//    delists A;
//  - the relay refuses, each with its reason: a locator the operator does not report, a
//    value above what the leaf holds, the filled order posted again, an order past its
//    delist time (C, once the chain's median time passes it), and the cancelled order
//    posted again (B, once the maker, back, cancels it with the approval shown);
//  - the maker's wallet, opened again, holds every credit; user mode refuses each method
//    before any window; the service workers' consoles stay clean.
//
//   CHROME=… ARCA_OPERATOR_CONTROL=127.0.0.1:18640 SEQOBD=/path/to/seqobd \
//     SEQDEX_WEB=/path/to/seqdex-web node test/resting/drive.mjs <evidence-dir> <work-dir>
//
// The operator is the arca repository's browser harness
// (bark-cli/tests/arca_operator_for_browsers.rs), started fresh for each run. The browsers
// reach every endpoint at https://sequentiatestnet.com (test/leaf-room/box.mjs).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { Browser, sleep } from '../leaves/cdp.mjs';
import { startBox } from '../leaf-room/box.mjs';
import { __test__ as seqob, restingOfferForPost, normRelayOffer, hexToBytes } from '../../vendor/seqob.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const CHROME = process.env.CHROME;
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const SEQOBD = process.env.SEQOBD;
const SITE = process.env.SEQDEX_WEB && resolve(process.env.SEQDEX_WEB);
const out = resolve(process.argv[2] || 'resting-evidence');
const work = resolve(process.argv[3] || '/tmp/resting-drive');
if (!CHROME || !SEQOBD || !SITE) { console.error('set CHROME, SEQOBD and SEQDEX_WEB'); process.exit(2); }
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
const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
  return j;
};
const rpc = (method, params = []) => ctl('/rpc', { method, params });
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function until(what, fn, ms = 120000, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(every);
  }
}

// ---- the browsers ----
const PW = 'drive-password';
const DEX = 'https://sequentiatestnet.com/dex/';
function browser(name, boxPort) {
  const b = new Browser({
    chrome: CHROME, profile: join(work, name + '-profile'), ext: EXT, consoleLog: join(out, `console-${name}.log`), headless: true,
    extraArgs: ['--ignore-certificate-errors', `--host-resolver-rules=MAP sequentiatestnet.com 127.0.0.1:${boxPort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
  });
  b.name = name;
  return b;
}
async function shot(p, name, at) {
  if (at) await p.eval(`(()=>{const e=document.querySelector(${JSON.stringify(at)}); if (e) e.scrollIntoView({block:'start'}); return true})()`).catch(() => {});
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
const approvalTarget = (b, ms = 180000) => b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), ms);
async function showApproval(b, name, expect) {
  const t = await approvalTarget(b);
  const a = await b.pageOf(t.targetId);
  await a.waitFor("document.querySelector('#reqCard') && !document.querySelector('#reqCard').classList.contains('hide')", 30000);
  const title = await a.text('#reqTitle');
  const body = await a.text('#reqCard');
  const miss = expect.filter((re) => !re.test(body));
  check(`${b.name}: approval "${title}" shown`, miss.length === 0, miss.length ? { missing: miss.map(String), body: body.replace(/\s+/g, ' ').slice(0, 1200) } : body.replace(/\s+/g, ' ').slice(0, 900));
  await shot(a, `${b.name}-approval-${name}`);
  return { t, a, body };
}
async function decide(b, w, yes = true) {
  await w.a.click(yes ? '#btnApprove' : '#btnReject');
  for (let i = 0; i < 100 && (await b.targets()).some((x) => x.targetId === w.t.targetId); i++) await sleep(100);
}
async function approve(b, name, expect, yes = true) {
  const w = await showApproval(b, name, expect);
  await decide(b, w, yes);
  return w.body;
}
async function approvals(b) { return (await b.targets()).filter((x) => x.type === 'page' && x.url.includes('/approval/approval.html')).length; }
async function popup(b) { return b.page(`chrome-extension://${b.extId}/popup/popup.html`); }
async function createWallet(b) {
  const pop = await popup(b);
  await pop.waitFor("document.querySelector('#btnStartCreate') && document.querySelector('#btnStartCreate').offsetParent !== null && !!document.querySelector('#btnStartCreate').onclick", 60000);
  await pop.click('#btnStartCreate');
  await pop.waitFor("document.querySelector('#newPhrase').dataset.phrase");
  await pop.set('createPw', PW); await pop.set('createPw2', PW);
  await pop.click('#btnCreateGo');
  await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
  await pop.click('[data-tab=settings]');
  await pop.waitFor("document.querySelector('#setMode').value === 'user'", 30000);
  return pop;
}
async function setMode(pop, mode) {
  await pop.eval(`(()=>{const s=document.querySelector('#setMode'); s.value='${mode}'; s.dispatchEvent(new Event('change')); return true})()`);
}
async function joinOperator(b, pop, st) {
  await setMode(pop, 'developer');
  await pop.waitFor("!document.querySelector('#leafCard').classList.contains('hide')", 30000);
  await pop.set('leafServer', 'https://sequentiatestnet.com/arca'); await pop.set('leafNodeUrl', 'https://sequentiatestnet.com/arca-node');
  await pop.set('leafNodeUser', st.node_user); await pop.set('leafNodePassword', st.node_password);
  await pop.set('leafDelay', '1'); await pop.set('leafMinDelay', '1');
  await pop.click('#btnLeafJoin');
  await pop.waitFor("!document.querySelector('#leafJoined').classList.contains('hide') || /refused|error|could not|failed/i.test(document.querySelector('#leafStatus').innerText)", 180000);
  const op = (await pop.text('#leafOperator')).trim();
  check(`${b.name}: joined the operator in Settings`, /^[0-9a-f]{64}$/.test(op), { operator: op, status: await pop.text('#leafStatus') });
  // The drive's only shortcut: the host's idle tick, 60 s in use, is 4 s here.
  await pop.eval("chrome.storage.local.get(['ext.walletTag','ext.leaves.byWallet']).then((o)=>{const t=o['ext.walletTag'], all=o['ext.leaves.byWallet']; all[t]={...all[t], tick_ms: 4000}; return chrome.storage.local.set({'ext.leaves.byWallet': all})})");
  return op;
}
async function unlock(b) {
  const pop = await popup(b);
  await pop.waitFor("document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null && !!document.querySelector('#btnUnlock').onclick", 60000);
  await pop.set('unlockPw', PW); await pop.click('#btnUnlock');
  await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
  return pop;
}
async function room(b) {
  const p = await b.page(DEX + 'leaves.html');
  await p.waitFor("document.querySelector('#room') && document.querySelector('#room').childElementCount > 0", 60000);
  return p;
}
async function marketPage(b) {
  const p = await b.page(DEX + 'index.html?pair=XLEAF-YLEAF');
  await p.waitFor("document.querySelector('#pairList button.mkt.on') && document.querySelector('#orderForm h2')", 90000);
  return p;
}
const call = (p, method, params = {}) => p.eval(`window.sequentia.request({method:${JSON.stringify(method)}, params:${JSON.stringify(params)}}).then((v)=>({ok:true,v}),(e)=>({ok:false,e:e.message}))`);
// A call that opens a window: the window shown and decided, then the answer.
async function callApproved(b, p, method, params, name, expect) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const pending = p.eval(`window.sequentia.request({method:${JSON.stringify(method)}, params:${JSON.stringify(params)}}).then((v)=>({ok:true,v}),(e)=>({ok:false,e:e.message}))`);
    const early = await Promise.race([pending, approvalTarget(b).then(() => null, () => null)]);
    if (early && !early.ok && /Scan already in progress/.test(early.e)) { note(`     ${b.name}: refused while the node scans for another wallet; asked again`); await sleep(3000); continue; }
    if (early) return early;
    await approve(b, name, expect);
    const r = await pending;
    if (!r.ok && /Scan already in progress/.test(r.e)) { note(`     ${b.name}: refused after approval while the node scans; asked again`); await sleep(3000); continue; }
    return r;
  }
  return { ok: false, e: 'the node stayed busy scanning' };
}
async function connect(b, p) {
  await p.click('#btnConnect');
  await approve(b, 'connect', [/connect/i]);
  await p.waitFor("document.querySelector('#btnConnect').classList.contains('ok')", 60000);
}
async function board(b, p, asset, amount) {
  const addr = await call(p, 'getLeafAddress');
  if (!addr.ok) throw new Error(b.name + ': getLeafAddress ' + addr.e);
  await ctl('/fund', { script: addr.v.script_pubkey, asset, amount: amount + 200000 });
  await ctl('/produce');
  const r = await callApproved(b, p, 'boardLeaves', { asset, amount: String(amount) }, 'board', [/Board a coin into your leaves/, new RegExp(String(amount) + ' atoms')]);
  check(`${b.name}: boarded ${amount} of ${asset.slice(0, 8)}…`, r.ok, r.ok ? { txid: r.v.txid, fee: r.v.fee } : r.e);
  await ctl('/produce'); await ctl('/bury');
  await until(`${b.name}'s board to be live`, async () => {
    const bal = await call(p, 'getLeafBalances');
    if (!bal.ok) return false;
    const live = BigInt(((bal.v.leaves[asset] || {}).states || {}).live || 0);
    if (live < BigInt(amount)) { await ctl('/produce'); return false; }
    return true;
  }, 180000, 2000);
}
// The default view's one form, filled as a user does.
async function trade(b, p, { side, amount }, name, expect) {
  await p.click('#type-market'); await p.click('#side-' + side);
  await p.set('fAmount', amount);
  await p.eval("document.querySelector('#fStatus').textContent=''");
  await shot(p, `${b.name}-form-${name}`);
  await p.click('#fGo');
  const which = await Promise.race([
    approvalTarget(b).then(() => 'window', () => 'timeout'),
    p.waitFor("document.querySelector('#fStatus').classList.contains('err')", 180000).then(() => 'refused', () => 'timeout'),
  ]);
  if (which !== 'window') return { ok: false, why: await p.text('#fStatus') };
  await approve(b, name, expect);
  await p.waitFor("document.querySelector('#fStatus').classList.contains('ok') || document.querySelector('#fStatus').classList.contains('err')", 300000);
  return { ok: await p.eval("document.querySelector('#fStatus').classList.contains('ok')"), why: await p.text('#fStatus') };
}

async function main() {
  const st = await ctl('/state');
  const X = st.x, Y = st.y;
  note(`operator ${st.server}; node ${st.node_url}; X ${X}, Y ${Y}`);
  const rates = await rpc('getfeeexchangerates');
  if (!rates[Y]) await rpc('setfeeexchangerates', [{ ...rates, [Y]: 100000000 }]);
  note('     Y listed for fees on the node');

  // ---- the relay, following the operator ----
  const relayPort = await freePort();
  const relayLog = join(out, 'seqobd.log');
  const relay = spawn(SEQOBD, [`-listen=127.0.0.1:${relayPort}`, `-node-rpc=${new URL(st.node_url).host}`, '-node-rpc-user=arca', '-node-rpc-pass=arca',
    '-watch-interval=1s', '-resting-interval=1s', '-min-expiry=5s', `-arca-operator=${st.server}`, '-fill-anchor-depth=2'], { stdio: ['ignore', 'pipe', 'pipe'] });
  relay.stdout.on('data', (d) => appendFileSync(relayLog, d)); relay.stderr.on('data', (d) => appendFileSync(relayLog, d));
  const R = `http://127.0.0.1:${relayPort}`;
  await until('the relay', async () => (await fetch(R + '/v1/markets')).ok, 30000, 300);
  note(`relay seqobd pid ${relay.pid} at ${R}, following the operator at ${st.server}`);
  const book = async (a = X, b = Y) => {
    const j = await (await fetch(`${R}/v1/market/${a}/${b}/orderbook`)).json();
    return (j.offers || []).map((o, i) => ({ o, st: (j.statuses || [])[i] || {} }));
  };
  const resting = async () => (await book()).filter((x) => x.o.resting_leaf);
  const fills = async () => ((await (await fetch(`${R}/v1/market/${X}/${Y}/fills`)).json()).fills || []);
  const post = async (o) => {
    const r = await fetch(R + '/v1/offers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
    return { status: r.status, text: (await r.text()).trim() };
  };
  // An offer signed by a key of the drive's own: the relay's checks of a resting order
  // stand on the operator's view, not on who posts it.
  const testKey = hexToBytes('11'.repeat(32));
  const repost = (served, edit) => {
    const o = normRelayOffer(JSON.parse(JSON.stringify(served)));
    delete o.maker_sig; delete o.maker_pubkey;
    o.offer_id = 'drive-' + Math.random().toString(16).slice(2, 10);
    o.created_at_unix = String(Math.floor(Date.now() / 1000));
    if (edit) edit(o);
    seqob.signOffer(o, testKey);
    return post(restingOfferForPost(o));
  };

  // ---- the stand-in box ----
  const key = join(work, 'box.key'), crt = join(work, 'box.crt');
  if (!existsSync(crt)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=sequentiatestnet.com', '-addext', 'subjectAltName=DNS:sequentiatestnet.com'], { stdio: 'ignore' });
  const box = await startBox({ key: readFileSync(key), cert: readFileSync(crt), site: SITE, relay: R, operator: st.server, node: st.node_url, nodeAuth: 'arca:arca', assets: { [X]: 'XLEAF', [Y]: 'YLEAF' } });
  note(`box at 127.0.0.1:${box.port} (https://sequentiatestnet.com for the browsers)`);

  const maker = browser('maker', box.port), t1 = browser('taker1', box.port), t2 = browser('taker2', box.port);
  try {
    // ---- three wallets: created, developer mode, joined, with leaves ----
    const opKey = await (async () => {
      await maker.launch('maker start 1'); await readConsole(maker, 'start 1');
      const pop = await createWallet(maker);
      return joinOperator(maker, pop, st);
    })();
    let mroom = await room(maker);
    await connect(maker, mroom);
    await board(maker, mroom, X, 1200000);
    // ---- the maker rests three orders ----
    await mroom.waitFor("document.querySelector('#rsSell') && document.querySelector('#rsSell').options.length >= 2", 60000);
    await mroom.eval(`(()=>{document.querySelector('#rsSell').value=${JSON.stringify(X)}; document.querySelector('#rsWant').value=${JSON.stringify(Y)}; return true})()`);
    await mroom.set('rsAmount', '600000'); await mroom.set('rsTotal', '1200000'); await mroom.set('rsLot', '10000');
    await shot(mroom, 'maker-rest-form');
    await mroom.eval("document.querySelector('#restStatus').textContent=''");
    await mroom.click('#btnRest');
    await approve(maker, 'rest-A', [/rest an order in the operator’s tree/, /You give/, /600000 atoms/, /You get/, /1200000 atoms/, /Fee/, /Smallest fill/, /10000 atoms/, /Listed at/]);
    await mroom.waitFor("/Rested: order/.test(document.querySelector('#restStatus').innerText) || document.querySelector('#restStatus').classList.contains('err')", 300000);
    const restedA = await mroom.text('#restStatus');
    check('maker: order A rested through the room', /Rested: order/.test(restedA), restedA);
    const early = await call(mroom, 'restOrder', { sell: X, want: Y, amount: '100000', rate_num: '3', rate_den: '1', expiry: String((await rpc('getblockchaininfo')).mediantime + 3600) });
    check('a REFUND within the operator\'s margin is refused before any window, in the library\'s words', !early.ok && /co-signs no fill of an order refundable within/.test(early.e) && (await approvals(maker)) === 0, early.e);
    const odd = await call(mroom, 'restOrder', { sell: X, want: Y, amount: '100001', rate_num: '3', rate_den: '2' });
    check('a price that is not a whole number of atoms is refused before any window', !odd.ok && /not a whole number of atoms/.test(odd.e), odd.e);

    // A's round: made, final, the forfeits handed over, published, listed.
    const roundOf = async (what) => until(what, async () => { const r = await ctl('/round'); return r && r.round ? r : null; }, 180000, 3000);
    const round1 = await roundOf('the round that makes A');
    note(`     the round ${round1.round} (${round1.vsize} vB)`);
    await until('the relay to list A', async () => { await ctl('/settle').catch(() => {}); return (await resting()).length === 1; }, 300000, 3000);
    // B and C, from the change A's round made.
    await until('the maker\'s change leaf to be live', async () => {
      const bal = await call(mroom, 'getLeafBalances');
      return bal.ok && BigInt(((bal.v.leaves[X] || {}).states || {}).live || 0) >= 300000n;
    }, 180000, 3000);
    const rB = await callApproved(maker, mroom, 'restOrder', { sell: X, want: Y, amount: '100000', rate_num: '3', rate_den: '1', min_lot: '10000' }, 'rest-B',
      [/100000 atoms/, /300000 atoms/]);
    check('maker: order B rested (3 Y per X)', rB.ok, rB.ok ? rB.v.order : rB.e);
    const round2 = await roundOf('the round that makes B');
    note(`     the round ${round2.round} (${round2.vsize} vB)`);
    await until('the relay to list B', async () => { await ctl('/settle').catch(() => {}); return (await resting()).length === 2; }, 300000, 3000);
    await until('the maker\'s change leaf to be live again', async () => {
      const bal = await call(mroom, 'getLeafBalances');
      return bal.ok && BigInt(((bal.v.leaves[X] || {}).states || {}).live || 0) >= 200000n;
    }, 180000, 3000);
    const mtp = (await rpc('getblockchaininfo')).mediantime;
    const cExpiry = mtp + 7 * 3600 + 900;
    const rC = await callApproved(maker, mroom, 'restOrder', { sell: X, want: Y, amount: '100000', rate_num: '3', rate_den: '1', min_lot: '10000', expiry: String(cExpiry) }, 'rest-C',
      [/100000 atoms/, /refundable from/]);
    check(`maker: order C rested, its landed REFUND at median time ${cExpiry} (7 h 15 min ahead)`, rC.ok, rC.ok ? rC.v.order : rC.e);
    const round3 = await roundOf('the round that makes C');
    note(`     the round ${round3.round} (${round3.vsize} vB)`);
    const listed = await until('the relay to list three resting orders', async () => { await ctl('/settle').catch(() => {}); const r = await resting(); return r.length === 3 ? r : null; }, 300000, 3000);
    const A = listed.find((x) => x.o.offer_amount === '600000');
    const others = listed.filter((x) => x !== A);
    const C = others.find((x) => Number(x.o.resting_leaf.landed_expiry) === cExpiry);
    const B = others.find((x) => x !== C);
    check('the relay lists A at what its leaf holds, from the operator\'s view: its order id, operator and locator', !!A && A.st.active_amount === '600000'
      && A.o.resting_leaf.coin === A.o.resting_leaf.order_id && A.o.resting_leaf.operator_key === opKey && A.st.status === 'OFFER_STATUS_OPEN',
      A && { order: A.o.resting_leaf.order_id, coin: A.o.resting_leaf.coin, value: A.o.resting_leaf.value, active: A.st.active_amount, status: A.st.status, operator_url: A.o.resting_leaf.operator_url });
    check('the relay lists B and C', !!B && !!C, { B: B && B.o.resting_leaf.order_id, C: C && C.o.resting_leaf.order_id });
    await mroom.eval('location.reload(), true'); await sleep(5000);
    mroom = await room(maker);
    await mroom.waitFor("document.querySelectorAll('#pMyResting .take').length >= 3", 120000);
    await shot(mroom, 'maker-room-three-resting', '#pMyResting');
    const servedA = A.o, servedB = B.o, servedC = C.o;
    const orderA = servedA.resting_leaf.order_id;
    // The maker leaves.
    await maker.close();
    note('     the maker\'s browser is closed');

    // ---- the takers: created, developer mode, joined, with leaves of Y boarded now ----
    // (a fill is paid only with coins expiring no earlier than the order's, and a board
    // made before the order's round expires before it)
    for (const t of [t1, t2]) {
      await t.launch(`${t.name} start 1`); await readConsole(t, 'start 1');
      const pop = await createWallet(t);
      await joinOperator(t, pop, st);
      t.pop = pop;
      t.room = await room(t);
      await connect(t, t.room);
      await board(t, t.room, Y, t === t1 ? 2000000 : 1000000);
    }


    // ---- taker 1 finds A on the default view and buys part of it ----
    const mp = await marketPage(t1);
    const bookText = (p) => p.text('#bookBody');
    await until('the ask in the default view\'s book', async () => /6,000|0\.006/.test(await bookText(mp)) || (await mp.eval('location.reload(), true').then(() => sleep(4000)).then(() => false)), 90000, 1000);
    // The market itself, without the developer view's links to the rooms (this wallet is
    // in developer mode, so the page links them; in user mode it does not).
    const pageWords = await mp.eval("(()=>{const c=document.body.cloneNode(true); c.querySelectorAll('#devNav, .topbar nav').forEach((n)=>n.remove()); return c.innerText})()");
    const named = pageWords.match(/\b(leaf|leaves|operator|operators|template|resting_leaf|tree)\b/i);
    check('default view: the resting order is one more order of the market, its price and size shown, and the market names no leaf, operator or template',
      !named, { named: named && named[0], book: (await bookText(mp)).replace(/\s+/g, ' ') });
    await shot(mp, 'taker1-default-view-book');
    const f1 = await trade(t1, mp, { side: 'buy', amount: '0.002' }, 'buy-part', [/You give/, /You get/, /200000 atoms|0\.002/, /Fees/]);
    check('taker 1: the default view\'s market buy filled 200,000 X of A in the tree', f1.ok, f1.why);
    const afterF1 = await until('the relay to follow A to its remainder', async () => { const r = (await resting()).find((x) => x.o.resting_leaf.order_id === orderA); return r && r.st.active_amount === '400000' ? r : null; }, 60000, 1000);
    check('the relay moved A to the coin its remainder rests at, listed at 400,000, the signed offer unchanged', afterF1.o.resting_leaf.coin !== orderA
      && afterF1.o.maker_sig === servedA.maker_sig && afterF1.st.status === 'OFFER_STATUS_PARTIAL', { coin: afterF1.o.resting_leaf.coin, value: afterF1.o.resting_leaf.value, status: afterF1.st.status });
    await mp.eval('location.reload(), true'); await sleep(5000);
    await until('the default view to show the remainder', async () => /4,000|0\.004/.test(await bookText(mp)) || (await mp.eval('location.reload(), true').then(() => sleep(4000)).then(() => false)), 60000, 1000);
    check('default view: the book shows the remainder', true, (await bookText(mp)).replace(/\s+/g, ' '));
    await shot(mp, 'taker1-default-view-remainder');
    const rec1 = await until('the first fill\'s record', async () => (await fills()).find((f) => f.offer_id === servedA.offer_id && f.taker && f.taker.via === 'operator_tree'), 60000, 1000);
    check('the relay records the fill by the operator\'s transfer id, in the tree, final with the round its order rests on',
      /^[0-9a-f]{64}$/.test(rec1.txid) && rec1.filled === 200000 && rec1.remainder === 400000 && rec1.credit.value === 400000 && rec1.state === 'final' && !!rec1.taker.round_txid,
      { transfer: rec1.txid, filled: rec1.filled, credit: rec1.credit, state: rec1.state, round: rec1.taker.round_txid, depth: `${rec1.anchor_depth}/${rec1.required_depth}` });

    // The leaves room: the operator, the order id and the locator.
    const t1room = await room(t1);
    await t1room.waitFor(`[...document.querySelectorAll('#pResting .take')].some((d)=>d.dataset.order===${JSON.stringify(orderA)} && d.innerText.includes(${JSON.stringify(afterF1.o.resting_leaf.coin)}))`, 90000);
    const roomA = await t1room.eval(`[...document.querySelectorAll('#pResting .take')].find((d)=>d.dataset.order===${JSON.stringify(orderA)}).innerText`);
    check('developer view: the leaves room shows A\'s operator, order id and locator, and its fill', roomA.includes(opKey) && roomA.includes(orderA) && roomA.includes(afterF1.o.resting_leaf.coin) && /final/.test(roomA), roomA.replace(/\s+/g, ' '));
    await shot(t1room, 'taker1-leaves-room-locator', '#pResting');

    // ---- a stale fill: taker 2 is shown A, taker 1 fills it first ----
    const t2room = await room(t2);
    await t2room.waitFor(`[...document.querySelectorAll('#pResting .take')].some((d)=>d.dataset.order===${JSON.stringify(orderA)} && !!d.querySelector('button'))`, 90000);
    await t2room.eval(`(()=>{const d=[...document.querySelectorAll('#pResting .take')].find((d)=>d.dataset.order===${JSON.stringify(orderA)}); d.querySelector('input').value='150000'; d.querySelector('button').click(); return true})()`);
    const shownT2 = await showApproval(t2, 'fill-shown', [/fill an order resting in the operator’s tree/, /You get/, /150000 atoms/, /You give/, /Price/, /300000 atoms/, /Fee/, new RegExp(afterF1.o.resting_leaf.coin)]);
    note('     taker 2\'s approval is open, quoted at ' + afterF1.o.resting_leaf.coin.slice(0, 16) + '…; taker 1 fills A first');
    const f2 = await callApproved(t1, t1room, 'fillRestingOrder', { order: afterF1.o, amount: '100000' }, 'fill-first', [/100000 atoms/, /200000 atoms/]);
    check('taker 1 fills 100,000 of A from its leaves (fillRestingOrder)', f2.ok && f2.v.filled === '100000', f2.ok ? { transfer: f2.v.answer && f2.v.answer.transfer_id, coin: f2.v.coin } : f2.e);
    const afterF2 = await until('the relay to follow A again', async () => { const r = (await resting()).find((x) => x.o.resting_leaf.order_id === orderA); return r && r.st.active_amount === '300000' ? r : null; }, 60000, 1000);
    await decide(t2, shownT2, true);
    await t2room.waitFor("document.querySelector('#restFillStatus').classList.contains('ok') || document.querySelector('#restFillStatus').classList.contains('err')", 300000);
    const t2said = await t2room.text('#restFillStatus');
    check('taker 2: the shown fill was answered order_moved, and the wallet filled A where it rests now, for the same amount and price',
      /Filled 150000 for 300000/.test(t2said) && new RegExp('had moved from ' + afterF1.o.resting_leaf.coin.slice(0, 12)).test(t2said), t2said);
    await shot(t2room, 'taker2-stale-fill-retried', '#restFillStatus');
    const swLog = readFileSync(join(out, 'console-taker2.log'), 'utf8');
    check('taker 2\'s service worker logged the move (order_moved) and the fill at the new coin', /\(order_moved\): filled there/.test(swLog) && swLog.includes(afterF2.o.resting_leaf.coin.slice(0, 12)),
      (swLog.match(/.*order_moved.*/) || [''])[0].slice(0, 300));
    const afterF3 = await until('the relay to follow A to 150,000', async () => { const r = (await resting()).find((x) => x.o.resting_leaf.order_id === orderA); return r && r.st.active_amount === '150000' ? r : null; }, 60000, 1000);

    // ---- the rest, from the default view ----
    const mp2 = await marketPage(t2);
    await until('the remainder in taker 2\'s default view', async () => /1,500|0\.0015/.test(await bookText(mp2)) || (await mp2.eval('location.reload(), true').then(() => sleep(4000)).then(() => false)), 60000, 1000);
    await shot(mp2, 'taker2-default-view-before-the-rest');
    const f4 = await trade(t2, mp2, { side: 'buy', amount: '0.0015' }, 'buy-rest', [/150000 atoms|0\.0015/, /Fees/]);
    check('taker 2: the default view\'s market buy took the rest of A', f4.ok, f4.why);
    await until('the relay to delist A, filled whole', async () => !(await resting()).some((x) => x.o.resting_leaf.order_id === orderA), 60000, 1000);
    const recs = await until('four fill records of A', async () => { const r = (await fills()).filter((f) => f.offer_id === servedA.offer_id && f.state !== 'undone'); return r.length >= 4 ? r : null; }, 30000, 1000).catch(async () => (await fills()).filter((f) => f.offer_id === servedA.offer_id));
    check('the relay recorded four fills of A, each by its transfer id, and delisted it', recs.length === 4 && recs.every((f) => f.taker.via === 'operator_tree')
      && recs.map((f) => f.filled).join(',') === '200000,100000,150000,150000' && recs[3].remainder === 0,
      recs.map((f) => ({ t: f.txid.slice(0, 12), spent: f.spent.slice(0, 12), filled: f.filled, credited: f.credit.value, rest: f.remainder, state: f.state })));
    await mp2.eval('location.reload(), true'); await sleep(5000);
    await shot(mp2, 'taker2-default-view-filled');

    // ---- refused at the relay ----
    const r1 = await repost(servedB, (o) => { o.resting_leaf.coin = 'ab'.repeat(32); });
    check('refused at the relay: a locator the operator does not report', r1.status === 400 && /resting at coin [0-9a-f]{64}, not at abab/.test(r1.text), r1.text);
    // B's leaf holds 100,000. An offer signed for 200,000 at B's price, naming B's coin
    // as holding 150,000: within what it signs, above what the leaf holds.
    const r2 = await repost(servedB, (o) => { o.base_amount = o.offer_amount = '200000'; o.want_amount = '600000'; o.resting_leaf.value = '150000'; });
    check('refused at the relay: a value above what the leaf holds', r2.status === 400 && /holding 100000 atoms, not the 150000 the offer names/.test(r2.text), r2.text);
    const r2b = await repost(servedB, (o) => { o.resting_leaf.value = '100001'; });
    check('refused at the relay: a value above what its maker signed', r2b.status === 400 && /holds 100001 atoms, more than the offer_amount 100000 its maker signed/.test(r2b.text), r2b.text);
    const r3 = await post(restingOfferForPost(normRelayOffer(JSON.parse(JSON.stringify(servedA)))));
    check('refused at the relay: the filled order posted again', r3.status === 400 && /is filled at its operator: it takes no fill/.test(r3.text), r3.text);
    const okB = await repost(servedB);
    check('control: the same order, posted by another key at its locator, is admitted (and refused as a second listing)', okB.status === 409 && /resting order already listed/.test(okB.text), okB.text);
    // C reaches its delist time: the chain's median time passes its REFUND less six hours.
    await ctl('/advance', { seconds: 4800 });
    await ctl('/produce');
    await until('the relay to delist C at its delist time', async () => !(await resting()).some((x) => x.o.resting_leaf.order_id === servedC.resting_leaf.order_id), 90000, 1000);
    const r4 = await post(restingOfferForPost(normRelayOffer(JSON.parse(JSON.stringify(servedC)))));
    check('refused at the relay: an order past its delist time', r4.status === 400 && /is past its delist time/.test(r4.text), r4.text);

    // ---- the maker comes back ----
    await maker.launch('maker start 2'); await readConsole(maker, 'start 2');
    await unlock(maker);
    mroom = await room(maker);
    const mine = await until('the maker\'s wallet to take up its credits', async () => {
      const r = await call(mroom, 'getRestingOrders');
      if (!r.ok) return null;
      const a = r.v.orders.find((o) => o.order === orderA);
      return a && a.credits.length === 4 ? r.v : null;
    }, 300000, 4000);
    const a = mine.orders.find((o) => o.order === orderA);
    const credited = a.credits.map((c) => c.value);
    check('the maker\'s wallet, opened again, holds the four credits of A', credited.join(',') === '400000,200000,300000,300000' && a.state === 'filled',
      { state: a.state, credits: a.credits, fills: a.fills.length });
    const bal = await call(mroom, 'getLeafBalances');
    const liveY = BigInt(((bal.v.leaves[Y] || {}).states || {}).live || 0);
    check('its leaves of Y hold 1,200,000: every credit live', liveY === 1200000n, bal.v.leaves[Y]);
    await mroom.waitFor(`[...document.querySelectorAll('#pMyResting .take')].some((d)=>d.dataset.order===${JSON.stringify(orderA)} && /credit/.test(d.innerText))`, 60000);
    await shot(mroom, 'maker-back-credits', '#pMyResting');
    // The maker cancels B.
    const cancel = await callApproved(maker, mroom, 'cancelRestingOrder', { order: servedB.resting_leaf.order_id }, 'cancel-B',
      [/cancel an order resting in the operator’s tree/, /You give/, /100000 atoms/, /You get/, /Fee/]);
    check('maker: B cancelled with the operator', cancel.ok && cancel.v.state === 'cancelled', cancel.ok ? cancel.v : cancel.e);
    await until('the relay to delist B', async () => !(await resting()).some((x) => x.o.resting_leaf.order_id === servedB.resting_leaf.order_id), 60000, 1000);
    const r5 = await post(restingOfferForPost(normRelayOffer(JSON.parse(JSON.stringify(servedB)))));
    check('refused at the relay: a cancelled order posted again', r5.status === 400 && /is cancelled at its operator: it takes no fill/.test(r5.text), r5.text);

    // ---- user mode refuses each method before any window ----
    await setMode(t2.pop, 'user');
    await sleep(1500);
    for (const [m, p] of [['restOrder', { sell: X, want: Y, amount: '100000', rate_num: '2', rate_den: '1' }], ['fillRestingOrder', { order: servedB }],
      ['cancelRestingOrder', { order: servedB.resting_leaf.order_id }], ['getRestingOrders', {}]]) {
      const r = await call(t2.room, m, p);
      check(`user mode: ${m} is refused before any window`, !r.ok && /developer-mode rail/.test(r.e) && (await approvals(t2)) === 0, r.e);
    }

    for (const b of [maker, t1, t2]) {
      const late = b.problems.splice(0);
      check(`${b.name}: no exception or console error from the extension's contexts during the drive`, late.length === 0, late.length ? late : undefined);
    }
  } finally {
    // A browser closed already (the maker's, when the drive stops while it is away)
    // answers no Browser.close: each close is bounded.
    for (const b of [maker, t1, t2]) {
      if (!b.proc || b.proc.exitCode != null) continue;
      try { await Promise.race([b.close(), sleep(20000)]); } catch {}
      try { if (b.proc.exitCode == null) b.proc.kill(); } catch {}
    }
    box.server.close();
    relay.kill();
    writeFileSync(join(out, 'box-requests.log'), box.log.join('\n') + '\n');
  }
}

main().then(() => {
  note(failures ? `${failures} check(s) failed` : 'all passed');
  for (const n of ['maker', 'taker1', 'taker2']) rmSync(join(work, n + '-profile'), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  process.exit(failures ? 1 : 0);
}).catch((e) => {
  note('ERROR ' + (e.stack || e));
  process.exit(1);
});
