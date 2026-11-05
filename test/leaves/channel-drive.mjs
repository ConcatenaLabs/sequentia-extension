#!/usr/bin/env node
// Payments that arrive at once over channel leaves, between two Ambra browser wallets in default
// mode, each in its own headless Chromium, against a local regtest operator that makes channel
// leaves (the operator repository's bark-cli/tests/arca_operator_for_browsers.rs, run with
// ARCA_OPERATOR_CHANNELS):
//
//  1. two new wallets join the operator (developer mode), then go to default mode; a command-line
//     payer pays each one's receive code; `care` opens a channel in each by itself, in the next
//     round;
//  2. both browsers started again on the wallet's own schedule (care every ten minutes, the
//     schedule's own tick), the popup open in each; A pays B's receive code six times and B pays
//     A's six times, as the popup's Send does (prepareSend, then confirmSend): each "Sent", each in
//     the receiver's figure in under a second from the tap on Send, no block made meanwhile, every
//     figure right;
//  3. A pays B more than B's channel can take: the same review and "Sent", paid as any payment to a
//     receive code, B's figure moves, neither channel moved;
//  4. default mode's Balance, Send and Receive say none of the words it never says.
//
//   CHROME=… ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca \
//     node test/leaves/channel-drive.mjs <evidence-dir> <work-dir>
//
// with ARCA_OPERATOR_CHANNELS at 1000000 (at most 1900000: A's channel must hold more than B's can
// take, for step 3). Every host name but 127.0.0.1 resolves to nothing.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from './cdp.mjs';
import { forbiddenIn } from '../../vendor/user-trade.js';
import { expandRequest, readPayCode } from '../../vendor/pay-code.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const CHROME = process.env.CHROME;
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const cliBin = process.env.ARCA_CLI;
const out = resolve(process.argv[2] || 'channel-evidence');
const work = resolve(process.argv[3] || mkdtempSync('/tmp/channel-drive-'));
if (!CHROME || !cliBin) { console.error('set CHROME and ARCA_CLI'); process.exit(2); }
mkdirSync(out, { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'drive.log');
writeFileSync(logFile, '');
const note = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); appendFileSync(logFile, l + '\n'); };
const PW = 'drive-password';
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
const cliDir = join(work, 'cli-payer');
const cli = (...args) => {
  let text;
  try { text = execFileSync(cliBin, ['--datadir', cliDir, '--witness-patience', '3', ...args], { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (e) { text = e.stdout.toString(); }
  return JSON.parse(text);
};

const W = {};
function wallet(name) {
  const w = { name, profile: join(work, 'profile-' + name), b: null, pop: null };
  W[name] = w;
  w.start = async (label) => {
    w.b = new Browser({ chrome: CHROME, profile: w.profile, ext: EXT, consoleLog: join(out, `console-${name}.log`), headless: true,
      extraArgs: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    await w.b.launch(`${name} ${label}`);
    await w.b.serviceWorker();
    await sleep(1500);
    w.pop = await w.b.page(`chrome-extension://${w.b.extId}/popup/popup.html`);
    await w.pop.eval("document.body.style.width='380px'; true");
  };
  w.ui = async (method, params = {}) => {
    const r = await w.pop.eval(`new Promise((ok) => chrome.runtime.sendMessage({ scope: 'ui', method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }, (r) => ok(r)))`);
    if (!r || !r.ok) throw new Error(`${name} ${method}: ${(r && r.error) || 'no answer'}`);
    return r.result;
  };
  w.unlock = async () => {
    await w.pop.waitFor("(document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null && !!document.querySelector('#btnUnlock').onclick) || (document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide'))", 60000);
    if (await w.pop.eval("!!(document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null)")) { await w.pop.set('unlockPw', PW); await w.pop.click('#btnUnlock'); }
    await w.pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
  };
  w.channels = async () => (await w.ui('leaves.channels')).channels || [];
  // The asset's one figure, in atoms, as the overview gives the popup's Balance.
  w.figure = async (asset) => { const ov = await w.ui('overview', { withLn: false }); const r = (ov.rows || []).find((x) => x.key === asset); return r ? BigInt(r.total) : 0n; };
  w.code = async () => (await w.ui('default.receiveCode', {})).code;
  w.shot = async (what) => { step++; const f = join(out, `${String(step).padStart(2, '0')}-${name}-${what}.png`); await w.pop.shot(f); };
  w.stop = async () => { try { await w.b.close(); } catch {} };
  return w;
}
const setMode = async (w, m) => {
  await w.pop.click('[data-tab=settings]');
  await w.pop.eval(`(()=>{const s=document.querySelector('#setMode'); s.value=${JSON.stringify(m)}; s.dispatchEvent(new Event('change')); return true})()`);
  await w.pop.waitFor(`document.querySelector('#leafCard').classList.contains('hide') === ${m !== 'developer'}`, 30000);
  await w.pop.click('[data-tab=balance]');
};
// The tick and care of the leaf host, kept for the wallet (`tick_ms`, `care_ms`), or its own when null.
const setPace = (w, tick, care) => w.pop.eval(`chrome.storage.local.get(['ext.walletTag','ext.leaves.byWallet']).then((o)=>{const t=o['ext.walletTag'], all=o['ext.leaves.byWallet']; const c={...all[t]}; if (${tick} == null) { delete c.tick_ms; delete c.care_ms; } else { c.tick_ms=${tick}; c.care_ms=${care}; } all[t]=c; return chrome.storage.local.set({'ext.leaves.byWallet': all})})`);

// In the receiver's popup: the time its overview first shows `want` atoms of the asset, read on each
// change the service worker announces (the moment the popup's Balance draws it again).
const watchFigure = (w, asset, want) => w.pop.eval(`(()=>{ window.__seen = null; const want = ${JSON.stringify(String(want))};
  const look = () => chrome.runtime.sendMessage({ scope: 'ui', method: 'overview', params: { withLn: false } }, (r) => {
    const row = r && r.ok && (r.result.rows || []).find((x) => x.key === ${JSON.stringify(asset)});
    if (window.__seen === null && row && String(row.total) === want) window.__seen = Date.now(); });
  window.__watch && chrome.runtime.onMessage.removeListener(window.__watch);
  window.__watch = (m) => { if (m && m.scope === 'ui-event' && m.event === 'leaves-changed') look(); };
  chrome.runtime.onMessage.addListener(window.__watch); look(); return true })()`);

// A pays B's receive code as the popup's Send does: the review, then Send.
let opInfo = null;
async function pay(a, b, asset, atoms, expectB) {
  const code = await b.code();
  await watchFigure(b, asset, expectB);
  const plan = await a.ui('default.prepareSend', { to: code, amtS: String(atoms), asset });
  const review = [plan.title, ...(plan.lines || [])].join(' | ');
  const r = await a.pop.eval(`(async () => { const t0 = Date.now(); const r = await new Promise((ok) => chrome.runtime.sendMessage({ scope: 'ui', method: 'default.confirmSend', params: { id: ${JSON.stringify(plan.id)} } }, (x) => ok(x))); return { t0, t1: Date.now(), r }; })()`);
  if (!r.r || !r.r.ok) throw new Error(`${a.name} confirmSend: ${(r.r && r.r.error) || 'no answer'}`);
  return { review, done: r.r.result.text, t0: r.t0, sentMs: r.t1 - r.t0 };
}

async function main() {
  const srv = spawn(process.execPath, [join(here, 'dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] });
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]); }));
  try {
    const st = await ctl('/state');
    const X = st.x;
    const info = await (await fetch(base + 'operator/v1/info')).json();
    opInfo = { operator: info.operator, genesis_hash: st.genesis_hash };
    const capacity = (info.assets.find((a) => a.asset === X) || {}).channels;
    check('the operator makes channel leaves of the drive\'s asset', !!capacity, capacity);
    note(`operator ${info.operator}; server ${st.server}; asset X ${X}`);

    // The payer, with leaves of X to pay the two receive codes.
    cli('create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca', '--exit-delay-units', '1', '--min-exit-delay-units', '1');
    await ctl('/fund', { script: cli('address').script_pubkey, asset: X, amount: 30000000 });
    await ctl('/produce');
    cli('board', X, '20000000');
    await ctl('/produce'); await ctl('/bury');
    for (let i = 0; i < 120 && cli('boards')[0]?.server?.state !== 'credited'; i++) await sleep(500);
    cli('sync');

    // --- 1. Two wallets, joined, in default mode, each paid; care opens a channel in each ---
    for (const name of ['A', 'B']) {
      const w = wallet(name);
      await w.start('create');
      await w.pop.waitFor("document.querySelector('#btnStartCreate') && document.querySelector('#btnStartCreate').offsetParent !== null && !!document.querySelector('#btnStartCreate').onclick", 60000);
      await w.pop.click('#btnStartCreate');
      await w.pop.waitFor("document.querySelector('#newPhrase').dataset.phrase");
      await w.pop.set('createPw', PW); await w.pop.set('createPw2', PW);
      await w.pop.click('#btnCreateGo');
      await w.pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
      await setMode(w, 'developer');
      await w.pop.click('[data-tab=settings]');
      await w.pop.set('leafServer', base + 'operator'); await w.pop.set('leafNodeUrl', base + 'node');
      await w.pop.set('leafNodeUser', st.node_user); await w.pop.set('leafNodePassword', st.node_password);
      await w.pop.set('leafDelay', '1'); await w.pop.set('leafMinDelay', '1');
      await w.pop.click('#btnLeafJoin');
      await w.pop.waitFor("!document.querySelector('#leafJoined').classList.contains('hide') || /refused|error|could not|failed/i.test(document.querySelector('#leafStatus').innerText)", 180000);
      check(`${name} joined the operator`, !(await w.pop.eval("document.querySelector('#leafJoined').classList.contains('hide')")), await w.pop.text('#leafStatus'));
      await setPace(w, 3000, 4000);
      await setMode(w, 'user');
      let code = null;
      for (let i = 0; i < 60 && !(code && /sequentia=/.test(code)); i++) { code = await w.code().catch(() => null); if (!(code && /sequentia=/.test(code))) await sleep(2000); }
      check(`${name}'s Receive gives a receive code`, /sequentia=/.test(code || ''), (code || '').slice(0, 48) + '…');
      const req = expandRequest(readPayCode(code).sequentia, opInfo) || readPayCode(code).sequentia;
      const p = cli('send', req, '--asset', X, '--amount', '4000000');
      check(`the payer paid ${name}'s receive code 4000000`, p.route === 'leaf' && !p.error, p.error || p.route);
    }
    const A = W.A, B = W.B;
    // Default mode gives each coin received out of round up in the operator's next round
    // (`refresh_received`); care then opens a channel from the round's leaf, in the round after.
    // The drive builds a round of whatever stands, and asks care, until both hold a live channel.
    const liveChannel = async (w) => (await w.channels()).some((c) => c.coin_state === 'live' && c.final);
    // The host takes its pace when it starts: both started again, with the tick at 3 s and care at
    // most every 4 s for this part.
    for (const w of [A, B]) await w.stop();
    for (const w of [A, B]) { await w.start('fast'); await w.unlock(); }
    let rounds = 0;
    for (let i = 0; i < 60 && !((await liveChannel(A)) && (await liveChannel(B))); i++) {
      const r = await ctl('/round');
      if (r) { rounds++; note(`     a round: ${JSON.stringify(r)}`); }
      await sleep(8000);
    }
    for (const w of [A, B]) {
      const ch = (await w.channels()).find((c) => c.coin_state === 'live' && c.final);
      check(`${w.name} opened a channel by itself in default mode, live and final`, !!ch, ch ? { leaf: ch.leaf_id, balance: ch.balance, operator_side: ch.operator_side } : await w.channels());
    }
    note(`     rounds built: ${rounds}`);
    // --- 2. Both started again on the wallet's own schedule, the popup open ---
    for (const w of [A, B]) { await setPace(w, null, null); await w.stop(); }
    for (const w of [A, B]) {
      await w.start('again');
      await w.unlock();
      let ok = false;
      for (let i = 0; i < 90 && !ok; i++) { ok = (await w.channels()).some((c) => c.coin_state === 'live' && c.final); if (!ok) await sleep(2000); }
      check(`${w.name}, started again, reads its live channel`, ok);
    }
    note('     both wallets started again on their own schedule; waiting 30 s for what they do once at open');
    await sleep(30000);
    let fa = await A.figure(X), fb = await B.figure(X);
    check('each figure is what the wallet was paid, less the round\'s fee at most', fa <= 4000000n && fa > 3990000n && fb <= 4000000n && fb > 3990000n, { A: String(fa), B: String(fb) });
    const cb = (await B.channels()).find((c) => c.coin_state === 'live');
    const code0 = await B.code();
    const named = expandRequest(readPayCode(code0).sequentia, opInfo) || '';
    check('B\'s receive code names its channel', named.includes(cb.leaf_id) || JSON.stringify(named).includes(cb.leaf_id) || (() => { try { return Buffer.from(named.split(':')[1], 'hex').toString().includes(cb.leaf_id); } catch { return false; } })(), cb.leaf_id);
    await A.shot('balance-channel-open'); await B.shot('balance-channel-open');

    // --- Six payments each way ---
    const h0 = (await ctl('/state')).tip;
    const times = [];
    const plan = [];
    for (const amt of [100000n, 25000n, 5000n, 40000n, 15000n, 7000n]) plan.push([A, B, amt], [B, A, amt + 1000n]);
    for (const [p, r, amt] of plan) {
      const wantR = (r === A ? fa : fb) + amt;
      const wantP = (p === A ? fa : fb) - amt;
      const t = await pay(p, r, X, amt, wantR);
      await r.pop.waitFor('window.__seen !== null', 10000).catch(() => {});
      const seen = await r.pop.eval('window.__seen');
      const gotP = await p.figure(X), gotR = await r.figure(X);
      if (p === A) { fa = gotP; fb = gotR; } else { fb = gotP; fa = gotR; }
      const ms = seen ? seen - t.t0 : null;
      times.push(ms);
      check(`${p.name} pays ${r.name} ${amt}: Sent, in the receiver's figure in under a second, both figures right`,
        /^Sent/.test(t.done) && ms !== null && ms < 1000 && gotP === wantP && gotR === wantR && !forbiddenIn(t.review + ' ' + t.done).length,
        { review: t.review, done: t.done, sent_ms: t.sentMs, received_ms: ms, payer: [String(gotP), String(wantP)], receiver: [String(gotR), String(wantR)] });
    }
    await A.shot('balance-after-twelve'); await B.shot('balance-after-twelve');
    const h1 = (await ctl('/state')).tip;
    check('no round between: no block made while the twelve payments went', h1 === h0, { before: h0, after: h1 });
    note(`     received in (ms from Send): ${JSON.stringify(times)}`);

    // --- 3. A payment B's channel cannot take ---
    {
      const chB = (await B.channels()).find((c) => c.coin_state === 'live');
      const chA = (await A.channels()).find((c) => c.coin_state === 'live');
      const amt = BigInt(chB.operator_side) + 50000n;
      note(`     B's channel takes ${chB.operator_side} more at most; A's channel holds ${chA.balance}; A pays B ${amt}`);
      const t = await pay(A, B, X, amt, fb + amt);
      await B.pop.waitFor('window.__seen !== null', 180000).catch(() => {});
      const seen = await B.pop.eval('window.__seen');
      const gotA = await A.figure(X), gotB = await B.figure(X);
      const chA2 = (await A.channels()).find((c) => c.leaf_id === chA.leaf_id) || {};
      const chB2 = (await B.channels()).find((c) => c.leaf_id === chB.leaf_id) || {};
      check('a payment B\'s channel cannot take is paid as any other: Sent, the same review, B\'s figure moves, neither channel moved',
        /^Sent/.test(t.done) && !forbiddenIn(t.review).length && gotB === fb + amt && gotA <= fa - amt && fa - amt - gotA < 5000n &&
          String(chA2.balance) === String(chA.balance) && String(chB2.credit) === String(chB.credit),
        { review: t.review, done: t.done, received_ms: seen ? seen - t.t0 : null, payer: [String(gotA), String(fa - amt)], receiver: [String(gotB), String(fb + amt)],
          channel_a: [chA.balance, chA2.balance], channel_b_credit: [chB.credit, chB2.credit] });
    }

    // --- 4. The words default mode never says ---
    for (const w of [A, B]) {
      const parts = [];
      for (const t of ['balance', 'send', 'receive']) { await w.pop.click(`[data-tab=${t}]`); await sleep(800); parts.push(await w.pop.eval(`document.querySelector('#t${t[0].toUpperCase() + t.slice(1)}').innerText`)); }
      const words = forbiddenIn(parts.join('\n'));
      check(`${w.name}: default mode's Balance, Send and Receive say none of the words`, !words.length, words);
      await w.pop.click('[data-tab=balance]');
    }
    for (const w of [A, B]) {
      const mine = w.b.problems.splice(0);
      check(`${w.name}: no exception or console error in the extension's contexts`, mine.length === 0, mine.slice(0, 5));
    }
  } finally {
    for (const w of Object.values(W)) await w.stop();
    srv.kill();
  }
}

try { await main(); } catch (e) { failures++; note('FAIL ' + (e.stack || e.message)); }
note(failures ? `${failures} failure(s)` : 'all ok');
process.exit(failures ? 1 : 0);
