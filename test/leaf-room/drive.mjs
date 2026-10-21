#!/usr/bin/env node
// Drives the SeqDEX site's leaves room end to end, in headless Chromium with this
// extension loaded, two browser profiles (a maker and a taker), against a local
// operator on an anchored regtest chain and a local on-chain relay:
//
//  - each wallet is created in the popup, put in developer mode and joins the
//    operator; the site's room appears only then (absent in user mode, from the
//    public pages, and from the navigation);
//  - each wallet boards leaves through the site (`boardLeaves`, approval shown);
//  - the maker places an order on the chain from leaves through the room
//    (`placeOrderFromLeaves`, approval shown); its round, the unlock into the order's
//    address, and the wallet listing it on the relay (`postExisting`);
//  - the taker fills part of it from leaves through the room (`takeOrder`, approval
//    shown); the popup is closed and the browser restarted inside the forfeit window,
//    the wallet unlocked, and the take hands its forfeits over by itself; the round
//    is broadcast, mined, and final; the room shows each state;
//  - an anchor rollback takes the round out of the chain: the room shows the fill
//    undone, then in a round and final again once it is mined again;
//  - a second take fills the rest whole; while that fill is in a block and not final
//    the room does not offer the order, and says why;
//  - the service worker's console is read after every start, and every console line
//    of the extension's contexts and the site is kept.
//
// The browser reaches every endpoint at https://sequentiatestnet.com, which
// --host-resolver-rules maps to the stand-in box (box.mjs); every other name resolves
// to nothing.
//
//   CHROME=… ARCA_OPERATOR_CONTROL=127.0.0.1:18640 SEQOBD=/path/to/seqobd \
//     SEQDEX_WEB=/path/to/seqdex-web node test/leaf-room/drive.mjs <evidence-dir> <work-dir>
//
// The operator is the arca repository's browser harness
// (bark-cli/tests/arca_operator_for_browsers.rs), started fresh for each run; the drive
// builds the rounds (/build), lets them out (/pass) and rolls the anchor back (/orphan)
// through its control address. It lists asset Y for fees on the node and gives Y an
// offboard fee of 1,000 atoms, so a take paid in Y pays the operator a fee.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { Browser, sleep } from '../leaves/cdp.mjs';
import { startBox } from './box.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const CHROME = process.env.CHROME;
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const SEQOBD = process.env.SEQOBD;
const SITE = process.env.SEQDEX_WEB && resolve(process.env.SEQDEX_WEB);
const out = resolve(process.argv[2] || 'leaf-room-evidence');
const work = resolve(process.argv[3] || '/tmp/leaf-room-drive');
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

// ---- the two browsers ----
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
  check(`${b.name}: approval "${title}" shown`, miss.length === 0, miss.length ? { missing: miss.map(String), body: body.replace(/\s+/g, ' ').slice(0, 900) } : body.replace(/\s+/g, ' ').slice(0, 700));
  await shot(a, `${b.name}-approval-${name}`);
  await a.click(decide ? '#btnApprove' : '#btnReject');
  for (let i = 0; i < 100 && (await b.targets()).some((x) => x.targetId === t.targetId); i++) await sleep(100);
  return body;
}
async function popup(b) { return b.page(`chrome-extension://${b.extId}/popup/popup.html`); }
async function createWallet(b, st) {
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
// The site's own page, its provider called as the room calls it.
async function room(b) {
  const p = await b.page(DEX + 'leaves.html');
  await p.waitFor("document.querySelector('#room') && document.querySelector('#room').childElementCount > 0", 60000);
  return p;
}
const call = (p, method, params = {}) => p.eval(`window.sequentia.request({method:${JSON.stringify(method)}, params:${JSON.stringify(params)}}).then((v)=>({ok:true,v}),(e)=>({ok:false,e:e.message}))`);
async function connect(b, p) {
  await p.click('#btnConnect');
  await approve(b, 'connect', [/connect/i]);
  await p.waitFor("document.querySelector('#btnConnect').classList.contains('ok')", 60000);
}
async function board(b, p, asset, amount, feeAsset) {
  const addr = await call(p, 'getLeafAddress');
  if (!addr.ok) throw new Error(b.name + ': getLeafAddress ' + addr.e);
  await ctl('/fund', { script: addr.v.script_pubkey, asset, amount: amount + 200000 });
  await ctl('/produce');
  // The node runs one UTXO-set scan at a time and both wallets share it: a board refused
  // for that alone is asked again, as a user would.
  let r = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const pending = p.eval(`window.sequentia.request({method:'boardLeaves', params:${JSON.stringify({ asset, amount: String(amount), ...(feeAsset ? { fee_asset: feeAsset } : {}) })}}).then((v)=>({ok:true,v}),(e)=>({ok:false,e:e.message}))`);
    // The window opens only once the library quoted the board; a refusal comes back first.
    const early = await Promise.race([pending, b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), 120000).then(() => null, () => null)]);
    if (early && !early.ok) {
      if (/Scan already in progress/.test(early.e)) { note(`     ${b.name}: board refused while the node scans for another wallet; asked again`); await sleep(3000); continue; }
      throw new Error(b.name + ': boardLeaves refused before any window: ' + early.e);
    }
    await approve(b, 'board', [/Board a coin into your leaves/, new RegExp(String(amount) + ' atoms')]);
    r = await pending;
    if (!r.ok && /Scan already in progress/.test(r.e)) { note(`     ${b.name}: board refused while the node scans for another wallet; asked again`); await sleep(3000); continue; }
    break;
  }
  check(`${b.name}: boarded ${amount} of ${asset.slice(0, 8)}…`, r && r.ok, r && (r.ok ? { txid: r.v.txid, fee: r.v.fee } : r.e));
  await ctl('/produce'); await ctl('/bury');
  await until(`${b.name}'s board to be live`, async () => {
    const bal = await call(p, 'getLeafBalances');
    if (!bal.ok) return false;
    const live = BigInt(((bal.v.leaves[asset] || {}).states || {}).live || 0);
    if (live < BigInt(amount)) { await ctl('/produce'); return false; }
    return true;
  }, 180000, 2000);
}
// A room action: click, then either the approval window opens (shown, checked, approved)
// or the room's status line says why not. A refusal only because the shared node was
// scanning for the other wallet is asked again.
async function roomAct(b, p, click, statusSel, okRe, shotName, expect) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await p.eval(`(()=>{const s=document.querySelector(${JSON.stringify(statusSel)}); if (s) { s.textContent=''; s.className='status'; } return true})()`);
    await click();
    const which = await Promise.race([
      b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), 120000).then(() => 'window', () => 'timeout'),
      p.waitFor(`document.querySelector(${JSON.stringify(statusSel)}).classList.contains('err')`, 120000).then(() => 'refused', () => 'timeout'),
    ]);
    if (which === 'timeout') return { ok: false, why: 'neither a window nor a refusal came' };
    if (which === 'refused') {
      const why = await p.text(statusSel);
      if (/Scan already in progress/.test(why)) { note(`     ${b.name}: refused while the node scans for another wallet; asked again`); await sleep(3000); continue; }
      return { ok: false, why };
    }
    await approve(b, shotName, expect);
    await p.waitFor(`${okRe}.test(document.querySelector(${JSON.stringify(statusSel)}).innerText) || document.querySelector(${JSON.stringify(statusSel)}).classList.contains('err')`, 300000);
    const why = await p.text(statusSel);
    if (/Scan already in progress/.test(why)) { note(`     ${b.name}: refused after approval while the node scans; asked again`); await sleep(3000); continue; }
    return { ok: okRe.test(why), why };
  }
  return { ok: false, why: 'the node stayed busy scanning' };
}
const roomState = (p) => p.eval(`(()=>{
  const takes=[...document.querySelectorAll('#pTakes .take')].map((d)=>({take:d.dataset.take,state:d.dataset.state,text:d.innerText}));
  const orders=[...document.querySelectorAll('#pOrders tbody tr:not(.why)')].map((r)=>({offer:r.dataset.offer,fillable:!!r.querySelector('button'),text:r.innerText+(r.nextElementSibling&&r.nextElementSibling.classList.contains('why')?'\\n'+r.nextElementSibling.innerText:'')}));
  const mine=[...document.querySelectorAll('#pMine .take')].map((d)=>({order:d.dataset.order,state:d.dataset.state,text:d.innerText}));
  return {takes,orders,mine};})()`);

async function main() {
  const st = await ctl('/state');
  const X = st.x, Y = st.y;
  note(`operator ${st.server}; node ${st.node_url}; X ${X}, Y ${Y}`);
  const rates = await rpc('getfeeexchangerates');
  if (!rates[Y]) await rpc('setfeeexchangerates', [{ ...rates, [Y]: 100000000 }]);
  await ctl('/fees', { asset: Y, offboard_base: 1000 });
  note('     Y listed for fees on the node; a take paid in Y pays the operator 1000 atoms');

  // ---- the relay, following the operator ----
  const relayPort = await freePort();
  const relayLog = join(out, 'seqobd.log');
  const relay = spawn(SEQOBD, [`-listen=127.0.0.1:${relayPort}`, `-node-rpc=${new URL(st.node_url).host}`, '-node-rpc-user=arca', '-node-rpc-pass=arca',
    '-watch-interval=1s', '-min-expiry=5s', `-arca-operator=${st.server}`, '-fill-anchor-depth=2'], { stdio: ['ignore', 'pipe', 'pipe'] });
  relay.stdout.on('data', (d) => appendFileSync(relayLog, d)); relay.stderr.on('data', (d) => appendFileSync(relayLog, d));
  const R = `http://127.0.0.1:${relayPort}`;
  await until('the relay', async () => (await fetch(R + '/v1/markets')).ok, 30000, 300);
  note(`relay seqobd pid ${relay.pid} at ${R}`);
  const fills = async () => ((await (await fetch(`${R}/v1/market/${X}/${Y}/fills`)).json()).fills || []);

  // ---- the stand-in box ----
  const key = join(work, 'box.key'), crt = join(work, 'box.crt');
  if (!existsSync(crt)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=sequentiatestnet.com', '-addext', 'subjectAltName=DNS:sequentiatestnet.com'], { stdio: 'ignore' });
  const box = await startBox({ key: readFileSync(key), cert: readFileSync(crt), site: SITE, relay: R, operator: st.server, node: st.node_url, nodeAuth: 'arca:arca', assets: { [X]: 'XLEAF', [Y]: 'YLEAF' } });
  note(`box at 127.0.0.1:${box.port} (https://sequentiatestnet.com for the browsers)`);

  const maker = browser('maker', box.port), taker = browser('taker', box.port);
  try {
    // ---- both wallets: created, developer mode, joined ----
    await maker.launch('maker start 1'); await readConsole(maker, 'start 1');
    const mpop = await createWallet(maker, st);
    // The room is absent in user mode, and so are its link and tile.
    let mroom = await room(maker);
    check('user mode: the room draws nothing of itself', /Nothing here/.test(await mroom.text('#room')) && !(await mroom.eval("!!document.querySelector('#navLeaves')")), await mroom.text('#room'));
    await shot(mroom, 'maker-room-user-mode');
    const idx = await maker.page(DEX + 'index.html');
    await sleep(2500);
    check('user mode: the index has no tile and no link for the room', !(await idx.eval("!!document.querySelector('#tileLeaves') || !!document.querySelector('#navLeaves')")));
    const opKey = await joinOperator(maker, mpop, st);
    await mroom.waitFor("!!document.querySelector('#pOrders')", 30000);
    check('developer mode: the room draws itself on modeChanged, and its link appears', await mroom.eval("!!document.querySelector('#navLeaves')"));
    await idx.waitFor("!!document.querySelector('#tileLeaves')", 30000);
    check('developer mode: the index shows the room\'s tile', true);
    await shot(idx, 'maker-index-developer-mode');

    await taker.launch('taker start 1'); await readConsole(taker, 'start 1');
    const tpop = await createWallet(taker, st);
    await joinOperator(taker, tpop, st);

    // ---- leaves: X for the maker, Y for the taker ----
    await connect(maker, mroom);
    await board(maker, mroom, X, 1500000);
    let troom = await room(taker);
    await connect(taker, troom);
    await board(taker, troom, Y, 3000000);

    // ---- the operator named ----
    await mroom.waitFor(`document.querySelector('#pOperator').innerText.includes(${JSON.stringify(opKey)})`, 60000);
    check('the room names the operator the wallet joined, with its forfeit window', /Forfeit window\s*10 min/.test(await mroom.text('#pOperator')), await mroom.text('#pOperator'));

    let mine;
    {
      // ---- the maker places an order from leaves through the room ----
      await mroom.waitFor("document.querySelector('#plSell') && document.querySelector('#plSell').options.length >= 2", 60000);
      await mroom.eval(`(()=>{document.querySelector('#plSell').value=${JSON.stringify(X)}; document.querySelector('#plWant').value=${JSON.stringify(Y)}; return true})()`);
      await mroom.set('plAmount', '600000'); await mroom.set('plTotal', '1200000'); await mroom.set('plLot', '10000'); await mroom.set('plHours', '24');
      await shot(mroom, 'maker-place-form');
      const placed = await roomAct(maker, mroom, () => mroom.click('#btnPlace'), '#placeStatus', /Placed: order/, 'place',
      [/Place an order on the chain from your leaves/, /600000 atoms/, /1200000 atoms/, /Fee/, /Refund/]);
    check('the room placed the order from leaves', placed.ok, placed.why);
    await shot(mroom, 'maker-placed');
      // Its round: built, the maker's forfeits in, broadcast, final; then unlocked and listed.
      const placeRound = await until('the placement round', async () => { const r = await ctl('/build'); return r.rounds.length ? r : null; }, 60000, 2000);
      note(`     placement round ${JSON.stringify(placeRound)}`);
      let listed = null;
      await until('the order to rest on the chain and be listed', async () => {
        await ctl('/pass'); await ctl('/produce'); await ctl('/bury');
        const s = await roomState(mroom);
        const o = s.mine[0];
        if (o && o.state === 'resting' && /listed on the relay/.test(o.text)) { listed = o; return true; }
        return false;
      }, 300000, 3000);
      check('the order rests on the chain and the wallet listed it on the relay', !!listed, listed);
      await shot(mroom, 'maker-order-resting-listed');
      mine = (await call(mroom, 'getLeafOrders')).v.orders[0];
    }
    const book = await (await fetch(`${R}/v1/market/${X}/${Y}/orderbook`)).json();
    const served = (book.offers || []).find((o) => o.offer_id === mine.offer_id);
    check('the relay serves the order at the outpoint the chain shows, holding 600000', !!served && `${served.covenant.covenant_txid}:${served.covenant.covenant_vout}` === mine.rests_at && served.offer_amount === '600000',
      served ? { at: mine.rests_at, offer: served.offer_id, maker: served.maker_pubkey } : book);

    // ---- the taker fills part of it from leaves through the room ----
    troom = await room(taker);
    await troom.waitFor(`[...document.querySelectorAll('#pOrders tbody tr:not(.why)')].some((r)=>r.dataset.offer===${JSON.stringify(mine.offer_id)} && r.querySelector('button'))`, 120000);
    await shot(troom, 'taker-orders-fillable');
    const took = await roomAct(taker, troom, () => troom.eval(`(()=>{const r=[...document.querySelectorAll('#pOrders tbody tr:not(.why)')].find((r)=>r.dataset.offer===${JSON.stringify(mine.offer_id)}); const i=r.querySelector('input'); i.value='300000'; r.querySelector('button').click(); return true})()`),
      '#takeStatus', /Submitted: take/, 'take',
      [/Fill an on-chain order from your leaves/, /You get\s*0\.003 XLEAF \(300000 atoms\)/, /You give\s*0\.00601 YLEAF \(601000 atoms\)/, /Operator.s fee\s*0\.00001 YLEAF \(1000 atoms\)/, /within 10 minutes/]);
    check('the take is submitted from the room', took.ok, took.why);
    const take = (await call(troom, 'getLeafTakes')).v.takes[0];
    note(`     take ${take.take}: order ${take.order}, filled ${take.filled}, price ${take.price}, fee ${take.fee}, stage ${take.stage}`);
    await troom.waitFor("[...document.querySelectorAll('#pTakes .take')].some((d)=>d.dataset.state==='submitted')", 30000);
    await shot(troom, 'taker-take-submitted');
    // The popup closes (it is a page of the extension; nothing of the take lives in it).
    const tp = await popup(taker); await sleep(1000);
    await taker.send('Target.closeTarget', { targetId: tp.targetId });
    // A fresh anchor, so a rollback of the round leaves everything before it alone.
    await ctl('/bury');
    const built = await until('the fill round', async () => { const r = await ctl('/build'); return r.rounds.length ? r.rounds[0] : null; }, 60000, 2000);
    note(`     fill round ${built.txid} built and held (${built.vsize} vB), fills ${JSON.stringify(built.fills)}`);
    // The browser restarts inside the forfeit window, before the wallet handed anything over.
    await taker.close();
    const t0 = Date.now();
    await sleep(3000);
    await ctl('/pass');
    const inPoolBefore = (await rpc('getrawmempool')).includes(built.txid);
    check('with the taker\'s browser closed, the round is held: not broadcast', !inPoolBefore);
    await taker.launch('taker start 2'); await readConsole(taker, 'start 2 (restart inside the forfeit window)');
    await unlock(taker);
    troom = await room(taker);
    await until('the take\'s forfeits to be handed over', async () => {
      const t = (await call(troom, 'getLeafTakes')).v.takes[0];
      return t && (t.stage === 'forfeits-in' || t.stage === 'released');
    }, 300000, 2000);
    check(`after the restart and unlock (${Math.round((Date.now() - t0) / 1000)} s after the browser closed, window 600 s) the wallet handed the forfeits over by itself`, true);
    await troom.waitFor("[...document.querySelectorAll('#pTakes .take')].some((d)=>d.dataset.state==='forfeits-in')", 30000).catch(() => {});
    await shot(troom, 'taker-forfeits-handed-over');
    await until('the round to be broadcast', async () => { await ctl('/pass'); return (await rpc('getrawmempool')).includes(built.txid); }, 60000, 1000);
    check('the operator broadcast the round once the forfeits were in', true);
    await ctl('/produce');
    await until('the relay to record the fill', async () => (await fills()).some((f) => f.txid === built.txid && f.state === 'confirmed'), 60000);
    await troom.waitFor("[...document.querySelectorAll('#pTakes .take')].some((d)=>d.dataset.state==='in-round')", 60000);
    let rs = await roomState(troom);
    check('the room shows the fill in a round', rs.takes[0].state === 'in-round', rs.takes[0].text);
    const rest = rs.orders.find((o) => o.offer === mine.offer_id);
    check('the rest of the order is listed and not offered to a leaf taker until the fill is final', !!rest && !rest.fillable && /not final/.test(rest.text), rest);
    await shot(troom, 'taker-in-round-rest-not-offered');
    // Final.
    const hdr = async (txid) => rpc('getblockheader', [(await rpc('getrawtransaction', [txid, true])).blockhash, true]);
    const anchor = (await hdr(built.txid)).anchorheight;
    await ctl('/bury');
    await until('the relay to call the fill final', async () => (await fills()).some((f) => f.txid === built.txid && f.state === 'final'), 120000);
    await troom.waitFor("[...document.querySelectorAll('#pTakes .take')].some((d)=>d.dataset.state==='final')", 120000);
    await until('the taker to hold the leaf', async () => { const t = (await call(troom, 'getLeafTakes')).v.takes[0]; return t.stage === 'released' && t.leaf && t.leaf.state === 'live'; }, 120000, 2000);
    rs = await roomState(troom);
    check('the room shows the fill final, the leaf live', rs.takes[0].state === 'final', rs.takes[0].text);
    await shot(troom, 'taker-final');
    const tb = (await call(troom, 'getLeafBalances')).v.leaves[X];
    check('the taker holds 300000 X in leaves', !!tb && BigInt(tb.states.live || 0) >= 300000n, tb);

    // ---- an anchor rollback: the fill undone, then mined again and final again ----
    const orphan = await ctl('/orphan', { height: anchor });
    note(`     anchor rollback from parent height ${anchor}: ${orphan.orphaned} parent blocks orphaned; round in the mempool: ${(await rpc('getrawmempool')).includes(built.txid)}`);
    await until('the relay to undo the fill', async () => (await fills()).some((f) => f.txid === built.txid && f.state === 'undone'), 120000);
    await troom.waitFor("[...document.querySelectorAll('#pTakes .take')].some((d)=>d.dataset.state==='undone')", 120000);
    rs = await roomState(troom);
    check('the room shows the fill undone', rs.takes[0].state === 'undone', rs.takes[0].text);
    await shot(troom, 'taker-undone');
    await ctl('/produce');
    await until('the round mined again and recorded', async () => (await fills()).some((f) => f.txid === built.txid && f.state === 'confirmed'), 120000);
    await troom.waitFor("[...document.querySelectorAll('#pTakes .take')].some((d)=>d.dataset.state==='in-round')", 120000);
    await shot(troom, 'taker-in-round-again');
    await ctl('/bury');
    await until('final again', async () => (await fills()).filter((f) => f.txid === built.txid).some((f) => f.state === 'final'), 120000);
    await troom.waitFor("[...document.querySelectorAll('#pTakes .take')].some((d)=>d.dataset.state==='final')", 120000);
    rs = await roomState(troom);
    check('the room shows the fill final again', rs.takes[0].state === 'final', rs.takes[0].text);
    await shot(troom, 'taker-final-again');

    // ---- a full fill of the rest: in a block and not final, it is not offered ----
    await troom.waitFor(`[...document.querySelectorAll('#pOrders tbody tr:not(.why)')].some((r)=>r.dataset.offer===${JSON.stringify(mine.offer_id)} && r.querySelector('button'))`, 120000);
    const took2 = await roomAct(taker, troom, () => troom.eval(`(()=>{const r=[...document.querySelectorAll('#pOrders tbody tr:not(.why)')].find((r)=>r.dataset.offer===${JSON.stringify(mine.offer_id)}); r.querySelector('input').value=''; r.querySelector('button').click(); return true})()`),
      '#takeStatus', /Submitted: take/, 'take-rest', [/You get\s*0\.003 XLEAF \(300000 atoms\)/, /filled whole/]);
    check('the second take, of the rest whole, is submitted', took2.ok, took2.why);
    const built2 = await until('the second fill round', async () => { const r = await ctl('/build'); return r.rounds.length ? r.rounds[0] : null; }, 60000, 2000);
    await until('the second round broadcast', async () => { await ctl('/pass'); return (await rpc('getrawmempool')).includes(built2.txid); }, 120000, 2000);
    await ctl('/produce');
    await until('the relay to record the full fill', async () => (await fills()).some((f) => f.txid === built2.txid && f.state === 'confirmed'), 60000);
    const servedHeld = ((await (await fetch(`${R}/v1/market/${X}/${Y}/orderbook`)).json()).offers || []).some((o) => o.offer_id === mine.offer_id);
    let whole = null;
    await until('the room to say why the order is not offered', async () => {
      rs = await roomState(troom);
      whole = rs.orders.find((o) => o.offer === mine.offer_id);
      return whole && /filled whole .* not final/.test(whole.text);
    }, 60000, 1000).catch(() => {});
    check('a full fill in a block and not final: the relay still lists the order, the room does not offer it and says why',
      servedHeld && !!whole && !whole.fillable && /filled whole .* not final/.test(whole.text), { relayStillLists: servedHeld, row: whole });
    await shot(troom, 'taker-full-fill-not-offered');
    await ctl('/bury');
    await until('the full fill final', async () => (await fills()).some((f) => f.txid === built2.txid && f.state === 'final'), 120000);
    await until('the relay to delist the order', async () => !((await (await fetch(`${R}/v1/market/${X}/${Y}/orderbook`)).json()).offers || []).some((o) => o.offer_id === mine.offer_id), 60000);
    check('the order leaves the book once its full fill is final', true);

    // ---- the maker's side: credited on the chain ----
    await sleep(6000);
    const mo = (await call(mroom, 'getLeafOrders')).v.orders[0];
    check('the maker\'s room sees both fills and its credits', mo.fills.length >= 2 && mo.credits.length >= 2, { state: mo.state, fills: mo.fills.length, credits: mo.credits });
    const mtext = (await roomState(mroom)).mine.map((o) => o.text).join(' | ');
    check('the maker\'s room shows the order filled, with no listing error after the relay moved it', /filled/.test(mtext) && !/not listed yet/.test(mtext), mtext);
    await shot(mroom, 'maker-filled');

    // ---- refusals and user mode ----
    const approvals = async (b) => (await b.targets()).filter((x) => x.url.includes('/approval/approval.html')).length;
    const tmo = await popup(taker);
    await tmo.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 60000);
    await tmo.click('[data-tab=settings]');
    await tmo.waitFor("document.querySelector('#setMode').value === 'developer'", 30000);
    await setMode(tmo, 'user');
    await tmo.waitFor("document.querySelector('#leafCard').classList.contains('hide')", 30000);
    await troom.waitFor("/Nothing here/.test(document.querySelector('#room').innerText)", 30000);
    check('user mode: the room is gone from the open page and its link from the navigation', !(await troom.eval("!!document.querySelector('#navLeaves')")), await troom.text('#room'));
    await shot(troom, 'taker-room-user-mode');
    for (const [m, p] of [['takeOrder', { order: served }], ['placeOrderFromLeaves', { sell: X, want: Y, amount: '1000', rate_num: '1', rate_den: '1' }], ['getLeafTakes', {}], ['getLeafOrders', {}], ['getLeafOperator', {}]]) {
      const r = await call(troom, m, p);
      check(`user mode: ${m} is refused before any window`, !r.ok && /developer-mode rail/.test(r.e) && (await approvals(taker)) === 0, r.e);
    }
    await setMode(tmo, 'developer');
    await tmo.waitFor("!document.querySelector('#leafCard').classList.contains('hide')", 30000);
    await troom.waitFor("!!document.querySelector('#pOrders')", 30000);
    const r1 = await call(troom, 'takeOrder', { order: { offer_id: 'x' } });
    check('takeOrder of something that is not an on-chain order is refused before any window', !r1.ok && /covenant terms/.test(r1.e) && (await approvals(taker)) === 0, r1.e);
    const r2 = await call(troom, 'takeOrder', { order: served });
    check('takeOrder of an order filled and gone is refused before any window, in the library\'s words', !r2.ok && (await approvals(taker)) === 0, r2.e);

    // ---- the service workers once more ----
    for (const b of [maker, taker]) {
      const late = b.problems.splice(0);
      check(`${b.name}: no exception or console error from the extension's contexts during the drive`, late.length === 0, late.length ? late : undefined);
    }
  } finally {
    for (const b of [maker, taker]) { try { await b.close(); } catch {} }
    box.server.close();
    relay.kill();
    writeFileSync(join(out, 'box-requests.log'), box.log.join('\n') + '\n');
  }
}

main().then(() => {
  note(failures ? `${failures} check(s) failed` : 'all passed');
  for (const n of ['maker', 'taker']) rmSync(join(work, n + '-profile'), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  process.exit(failures ? 1 : 0);
}).catch((e) => {
  note('ERROR ' + (e.stack || e));
  process.exit(1);
});
