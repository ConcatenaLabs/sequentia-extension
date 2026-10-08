#!/usr/bin/env node
// Drives a site's use of the wallet's leaf methods end to end, in a HEADED Chromium
// with this extension loaded, against a local regtest operator:
//
//  - the wallet is created and unlocked through the popup; developer mode is turned on
//    and the operator joined in its Settings;
//  - the browser is started again on the same profile (an unpacked extension's reload)
//    and the service worker's console read after each start;
//  - the test site (test/leaves/site.html) connects, reads the mode and the leaf
//    balances, asks for a receive request (approval screen shown and approved), is
//    paid by the operator repository's command-line wallet, receives `leafArrived`,
//    and asks for a send of leaves to that wallet's request (approval screen shown and
//    approved); the receiver reads the payment and refreshes it in a round, whose
//    transaction is checked in a block at the node;
//  - refusals, each in the wallet's or the library's words; `modeChanged`; and
//    `leafSyncDue` once the chain's median time is moved into a coin's refresh window.
//
// Every step is a DOM assertion (drive.log) and a screenshot; every console line of
// the extension's contexts (service worker, offscreen document, leaf wallet worker,
// popup, approval) and of the site is in console.log, and the drive fails on any
// exception or console error from the extension's own contexts.
//
// Needs, running: the operator harness (arca repository,
// bark-cli/tests/arca_operator_for_browsers.rs) at its control address, and that
// repository's command-line wallet built (`arca`), which plays the counterparty.
//
//   CHROME=… ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca \
//     node test/leaves/drive.mjs <evidence-dir> <work-dir>
//
// Every host name but 127.0.0.1 resolves to nothing: the drive reaches no public server.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const CHROME = process.env.CHROME;
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const cliBin = process.env.ARCA_CLI;
const out = resolve(process.argv[2] || 'leaves-evidence');
const work = resolve(process.argv[3] || mkdtempSync('/tmp/leaves-drive-'));
if (!CHROME || !cliBin) { console.error('set CHROME and ARCA_CLI'); process.exit(2); }
mkdirSync(out, { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'drive.log');
const consoleLog = join(out, 'console.log');
writeFileSync(logFile, ''); writeFileSync(consoleLog, '');
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

const cliDir = join(work, 'cli');
const cli = (...args) => {
  let text;
  try {
    text = execFileSync(cliBin, ['--datadir', cliDir, '--witness-patience', '3', ...args],
      { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) { text = e.stdout.toString(); }
  return JSON.parse(text);
};

const profile = join(work, 'chrome-profile');
const b = new Browser({
  chrome: CHROME, profile, ext: EXT, consoleLog,
  extraArgs: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
});
async function shot(p, name) {
  step++;
  const f = join(out, `${String(step).padStart(2, '0')}-${name}.png`);
  await p.shot(f);
  note(`     screenshot ${f.split('/').pop()}`);
}

// The service worker's console, read after a start: its problems so far.
async function readConsole(label) {
  await b.serviceWorker();
  await sleep(3000);
  const mine = b.problems.splice(0);
  check(`${label}: the service worker started (${b.extId}) and its console shows no exception or error`, mine.length === 0, mine.length ? mine : undefined);
}

// One approval: the window opens as a tab; its screen is checked and shot, then decided.
async function approve(name, expect, decide = true) {
  const t = await b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), 60000);
  const a = await b.pageOf(t.targetId);
  await a.waitFor("document.querySelector('#reqCard') && !document.querySelector('#reqCard').classList.contains('hide')", 30000);
  const title = await a.text('#reqTitle');
  const body = await a.text('#reqCard');
  check(`approval screen "${title}" shown`, expect.every((re) => re.test(body)), body.replace(/\s+/g, ' ').slice(0, 600));
  await shot(a, name);
  await a.click(decide ? '#btnApprove' : '#btnReject');
  // The window closes itself once decided.
  for (let i = 0; i < 100 && (await b.targets()).some((x) => x.targetId === t.targetId); i++) await sleep(100);
  return body;
}

async function main() {
  const srv = spawn(process.execPath, [join(here, 'dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] });
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]); }));
  try {
    const st = await ctl('/state');
    const X = st.x, Y = st.y;
    note(`site ${base}; operator ${st.server}; node ${st.node_url}; asset X ${X} (listed for fees), Y ${Y}`);

    // --- The counterparty: the command-line wallet, with leaves of X ---
    cli('create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca', '--exit-delay-units', '1', '--min-exit-delay-units', '1');
    const cliInfo = cli('info');
    await ctl('/fund', { script: cli('address').script_pubkey, asset: X, amount: 5000000 });
    await ctl('/produce');
    const cb = cli('board', X, '3000000');
    if (cb.error) throw new Error('the CLI wallet could not board: ' + cb.error.message);
    await ctl('/produce'); await ctl('/bury');
    for (let i = 0; i < 120 && cli('boards')[0]?.server?.state !== 'credited'; i++) await sleep(500);
    cli('sync');
    note(`counterparty: operator ${cliInfo.operator}; boarded ${cb.txid}`);

    // --- First start: create the wallet, developer mode, join the operator ---
    await b.launch('start 1');
    await readConsole('start 1');
    const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    // Visible, and wired by the popup's module (the page shows it before the module runs).
    await pop.waitFor("document.querySelector('#btnStartCreate') && document.querySelector('#btnStartCreate').offsetParent !== null && !!document.querySelector('#btnStartCreate').onclick", 60000);
    await pop.click('#btnStartCreate');
    await pop.waitFor("document.querySelector('#newPhrase').dataset.phrase");
    await pop.set('createPw', 'drive-password'); await pop.set('createPw2', 'drive-password');
    await pop.click('#btnCreateGo');
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    check('the wallet is created through the popup', true);
    await pop.click('[data-tab=settings]');
    await pop.waitFor("document.querySelector('#setMode').value === 'user'", 30000);
    check('the mode is user until it is changed', true);
    check('no Leaves card in user mode', await pop.eval("document.querySelector('#leafCard').classList.contains('hide')"));
    await pop.eval("(()=>{const s=document.querySelector('#setMode'); s.value='developer'; s.dispatchEvent(new Event('change')); return true})()");
    await pop.waitFor("!document.querySelector('#leafCard').classList.contains('hide')", 30000);
    await pop.set('leafServer', base + 'operator'); await pop.set('leafNodeUrl', base + 'node');
    await pop.set('leafNodeUser', st.node_user); await pop.set('leafNodePassword', st.node_password);
    await pop.set('leafDelay', '1'); await pop.set('leafMinDelay', '1');
    await pop.click('#btnLeafJoin');
    await pop.waitFor("!document.querySelector('#leafJoined').classList.contains('hide') || /refused|error|could not|failed/i.test(document.querySelector('#leafStatus').innerText)", 180000);
    const op = await pop.text('#leafOperator');
    check('joined in Settings: the operator key shown equals the command-line wallet\'s pin', op.trim() === cliInfo.operator, { shown: op.trim(), status: await pop.text('#leafStatus') });
    await shot(pop, 'popup-joined');
    // The drive's only shortcut: the host's tick, 60 s in use, is 4 s here.
    await pop.eval("chrome.storage.local.get('ext.leaves').then((o)=>chrome.storage.local.set({'ext.leaves': {...o['ext.leaves'], tick_ms: 4000}}))");
    await b.close();

    // --- Second start (the extension reloaded): unlock; the leaf wallet opens again ---
    await b.launch('start 2');
    await readConsole('start 2');
    let pop2 = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    await pop2.waitFor("document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null && !!document.querySelector('#btnUnlock').onclick", 60000);
    await pop2.set('unlockPw', 'drive-password'); await pop2.click('#btnUnlock');
    await pop2.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    await pop2.click('[data-tab=settings]');
    await pop2.waitFor("!document.querySelector('#leafJoined').classList.contains('hide')", 60000);
    check('after the restart and unlock, the leaf wallet is open again from its store', (await pop2.text('#leafOperator')).trim() === cliInfo.operator, await pop2.text('#leafStatus'));

    // --- The site ---
    const site = await b.page(base + 'site.html');
    await site.waitFor('window.siteEvents', 30000);
    const done = (method) => site.waitFor(`document.querySelector('#out').dataset.method === ${JSON.stringify(method)} && document.querySelector('#out').dataset.ok !== ''`, 180000);
    const answer = async () => ({ ok: await site.eval("document.querySelector('#out').dataset.ok === '1'"), text: await site.eval("document.querySelector('#out').textContent") });
    const press = async (btn, method) => { await site.eval(`document.querySelector('#out').dataset.method=''`); await site.click(btn); };

    await press('#btnMode'); await done('getWalletMode');
    let a = await answer();
    check('getWalletMode before connecting: developer', a.ok && JSON.parse(a.text).mode === 'developer', a.text);
    await press('#btnBalances'); await done('getLeafBalances');
    a = await answer();
    check('getLeafBalances before connecting is refused', !a.ok && /not connected/.test(a.text), a.text);

    await press('#btnConnect');
    await approve('approval-connect', [/wants to connect/]);
    await done('connect'); a = await answer();
    check('connected', a.ok, a.text.slice(0, 200));

    await press('#btnBalances'); await done('getLeafBalances'); a = await answer();
    check('getLeafBalances: no leaves yet, no approval asked', a.ok && Object.keys(JSON.parse(a.text).leaves).length === 0, a.text);

    // A receive request, paid by the counterparty.
    await site.set('asset', X); await site.set('amount', '300000');
    await press('#btnReceive');
    await approve('approval-receive', [/receive request for leaves/, /300000|0\.003/]);
    await done('requestLeafReceive'); a = await answer();
    const recv = a.ok ? JSON.parse(a.text) : null;
    check('requestLeafReceive answers the library\'s request', !!recv && /^request:/.test(recv.request) && recv.details.asset === X && recv.details.value === '300000',
      recv ? { request: recv.request.slice(0, 40) + '…', until: recv.details.until } : a.text);
    await shot(site, 'site-request');
    const paid = cli('send', recv.request);
    check('the command-line wallet paid the request', !!paid.sent && paid.sent.value === '300000', paid.sent || paid);
    await site.waitFor("window.siteEvents.some((e) => e.event === 'leafArrived')", 180000);
    const arrived = await site.eval("window.siteEvents.find((e) => e.event === 'leafArrived').data");
    check('the site received leafArrived for the payment', arrived.asset === X && arrived.value === '300000', arrived);
    await shot(site, 'site-arrived');
    await press('#btnBalances'); await done('getLeafBalances'); a = await answer();
    const bal = a.ok ? JSON.parse(a.text) : null;
    check('getLeafBalances shows the leaf, by the library\'s state', !!bal && bal.leaves[X] && bal.leaves[X].total === '300000', bal ? bal.leaves : a.text);

    // A receive request in an asset the operator does not serve: approved, then
    // refused by the library.
    const Z = 'cd'.repeat(32);
    await site.set('asset', Z); await site.set('amount', '');
    await press('#btnReceive');
    await approve('approval-receive-unserved', [/receive request for leaves/]);
    await done('requestLeafReceive'); a = await answer();
    check('a receive request in an asset the operator does not serve is refused in the library\'s words', !a.ok && /does not serve asset/.test(a.text), a.text);

    // Refusals before any window.
    const approvals = async () => (await b.targets()).filter((x) => x.url.includes('/approval/approval.html')).length;
    const cliReq = cli('receive', '--asset', X, '--amount', '100000');
    await site.set('request', cliReq.request); await site.set('asset', Y); await site.set('amount', '');
    await press('#btnSend'); await done('sendLeaves'); a = await answer();
    check('a send in another asset than the request\'s is refused before any window', !a.ok && /asks for asset/.test(a.text) && (await approvals()) === 0, a.text);
    await site.set('request', 'not a request'); await site.set('asset', '');
    await press('#btnSend'); await done('sendLeaves'); a = await answer();
    check('a text that is not a request is refused before any window', !a.ok && /no prefix/.test(a.text) && (await approvals()) === 0, a.text);

    // The send.
    await site.set('request', cliReq.request);
    await press('#btnSend');
    await approve('approval-send', [/Pay from your leaves/, /You send/, /100000|0\.001/, new RegExp(cliReq.details.mailbox)]);
    await done('sendLeaves'); a = await answer();
    const sent = a.ok ? JSON.parse(a.text) : null;
    check('sendLeaves answers the library\'s payment', !!sent && sent.sent.value === '100000' && sent.sent.asset === X, sent ? { sent: sent.sent, margins: sent.margins, change: sent.change } : a.text);
    await shot(site, 'site-sent');

    // The receiver reads it, and refreshes it in a round confirmed at the node.
    const rs = cli('sync');
    const got = ((rs.mailbox && rs.mailbox.accepted) || []).find((c) => c.value === '100000');
    check('the receiver\'s mailbox accepted the payment', !!got, rs.mailbox);
    const part = cli('participate');
    check('the receiver asks for its refresh', !part.error, part.error || part.participations?.map((p) => p.participation_id || p.id));
    const round = await ctl('/round');
    const roundTx = round && round.round;
    const rtx = roundTx ? await rpc('getrawtransaction', [roundTx, true]) : null;
    check('node: the round that refreshes the paid leaf is in a block', !!rtx && rtx.confirmations >= 1, { round: roundTx, confirmations: rtx && rtx.confirmations });
    cli('sync');
    const cliBal = cli('balance');
    check('the receiver holds the refreshed leaf live', cliBal.arca && cliBal.arca[X] && BigInt(cliBal.arca[X].live || 0) >= 100000n, cliBal.arca);

    // A second payment of one request: shown, approved, refused by the operator.
    await press('#btnSend');
    await approve('approval-send-again', [/You send/]);
    await done('sendLeaves'); a = await answer();
    check('a second payment of one request is refused in the library\'s words', !a.ok && a.text.length > 0, a.text);

    // The mode: changed in the popup, followed by the site.
    await pop2.front();
    await pop2.eval("(()=>{const s=document.querySelector('#setMode'); s.value='user'; s.dispatchEvent(new Event('change')); return true})()");
    await site.waitFor("window.siteEvents.some((e) => e.event === 'modeChanged' && e.data.mode === 'user')", 30000);
    check('the site received modeChanged {mode: user}', true);
    await press('#btnBalances'); await done('getLeafBalances'); a = await answer();
    check('in user mode the leaf methods refuse', !a.ok && /developer-mode rail/.test(a.text), a.text);
    await press('#btnReceive'); await done('requestLeafReceive'); a = await answer();
    check('in user mode a receive request is refused before any window', !a.ok && /developer-mode rail/.test(a.text) && (await approvals()) === 0, a.text);
    await pop2.eval("(()=>{const s=document.querySelector('#setMode'); s.value='developer'; s.dispatchEvent(new Event('change')); return true})()");
    await site.waitFor("window.siteEvents.some((e) => e.event === 'modeChanged' && e.data.mode === 'developer')", 30000);
    check('the site received modeChanged {mode: developer}', true);

    // The schedule falls due: move the chain's median time into the change leaf's
    // refresh window, and the site hears leafSyncDue.
    const ls = await pop2.eval("chrome.runtime.sendMessage({scope:'ui', method:'leaves.state'})");
    const sch = ls.result.schedule;
    const first = (sch.coins || []).map((c) => c.refresh_from).filter((t) => typeof t === 'number').sort((p, q) => p - q)[0];
    note(`     schedule: now ${sch.now}, next ${sch.next_sync_at}, first refresh_from ${first}`);
    if (check('the wallet\'s schedule names a refresh window', typeof first === 'number', sch)) {
      await ctl('/advance', { seconds: first - sch.now + 60 });
      await ctl('/produce');
      await site.waitFor("window.siteEvents.some((e) => e.event === 'leafSyncDue')", 180000);
      const due = await site.eval("window.siteEvents.find((e) => e.event === 'leafSyncDue').data");
      check('the site received leafSyncDue', typeof due.now === 'number' && due.now >= first, due);
      await shot(site, 'site-sync-due');
    }
    await b.close();

    // --- Third start: the console once more, and the leaves still there ---
    await b.launch('start 3');
    await readConsole('start 3');
    const pop3 = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    await pop3.waitFor("document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null && !!document.querySelector('#btnUnlock').onclick", 60000);
    await pop3.set('unlockPw', 'drive-password'); await pop3.click('#btnUnlock');
    await pop3.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    const site3 = await b.page(base + 'site.html');
    await site3.waitFor('window.siteEvents', 30000);
    await site3.eval("document.querySelector('#out').dataset.method=''"); await site3.click('#btnBalances');
    await site3.waitFor("document.querySelector('#out').dataset.method === 'getLeafBalances' && document.querySelector('#out').dataset.ok !== ''", 180000);
    const end = await site3.eval("document.querySelector('#out').textContent");
    check('after a third start the site reads the leaves again', /"leaves"/.test(end) && end.includes(X), JSON.parse(end).leaves);
    await shot(site3, 'site-after-restart');
    const late = b.problems.splice(0);
    check('no exception or console error from the extension\'s contexts during the drive', late.length === 0, late.length ? late : undefined);
    await b.close();
  } finally {
    srv.kill();
  }
}

main().then(() => {
  note(failures ? `${failures} check(s) failed` : 'all passed');
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  process.exit(failures ? 1 : 0);
}).catch(async (e) => {
  note('ERROR ' + (e.stack || e));
  try { await b.close(); } catch {}
  process.exit(1);
});
