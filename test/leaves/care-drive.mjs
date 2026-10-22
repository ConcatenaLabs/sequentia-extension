#!/usr/bin/env node
// Drives what the wallet does by itself with leaves, in Chromium with this extension
// loaded, against a local regtest operator, the wallet in user mode throughout except
// where developer mode is the thing checked:
//
//  1. a distribution to three holders, one of them this wallet named by the compressed
//     key of its receive address (m/84'/1'/0'/0/i): the leaf host takes the claim up with
//     no click, and the asset appears in its one figure in the popup's Balance tab;
//  2. the claimed coin, a coin of no round, sent into a round's refresh by itself once
//     its refresh could run within ten days, and the round's new coin planned by itself
//     at the next care (every leaf of a round is planned); developer mode lists the plan,
//     with Cancel and Release, and marks the planned leaf; Release gives the leaf up in
//     the next round (`plan_release`); the round's new leaf is planned again, and Cancel
//     cancels that;
//  3. the popup's user-mode screens (Balance, Send, Receive, Stake) free of the
//     developer words, and the split one tap away in plain words.
//
// Every step is a DOM assertion (drive.log) and a screenshot; every console line of the
// extension's contexts is in console.log, and the drive fails on any exception or
// console error from them.
//
// Needs, running: the operator harness (arca repository,
// bark-cli/tests/arca_operator_for_browsers.rs) at its control address, and that
// repository's command-line wallet built (`arca`), which plays the payer and the two
// other holders. Start the harness fresh for each run: the drive moves the chain's
// median time.
//
//   CHROME=… ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca \
//     node test/leaves/care-drive.mjs <evidence-dir> <work-dir>
//
// Every host name but 127.0.0.1 resolves to nothing: the drive reaches no public server.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from './cdp.mjs';
import { HDKey, mnemonicToSeedSync } from '../../vendor/btc.js';
import { developerWordsIn } from '../../src/balance-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const CHROME = process.env.CHROME;
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const cliBin = process.env.ARCA_CLI;
const out = resolve(process.argv[2] || 'care-evidence');
const work = resolve(process.argv[3] || mkdtempSync('/tmp/care-drive-'));
if (!CHROME || !cliBin) { console.error('set CHROME and ARCA_CLI'); process.exit(2); }
mkdirSync(out, { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'drive.log');
const consoleLog = join(out, 'console.log');
writeFileSync(logFile, ''); writeFileSync(consoleLog, '');
const note = (s) => { console.log(s); appendFileSync(logFile, s + '\n'); };
const DAY = 86_400;

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
const wallets = {};
const cli = (name, ...args) => {
  wallets[name] = wallets[name] || join(work, 'cli-' + name);
  let text;
  try {
    text = execFileSync(cliBin, ['--datadir', wallets[name], '--witness-patience', '3', ...args],
      { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) { text = e.stdout.toString(); }
  return JSON.parse(text);
};

const profile = join(work, 'chrome-profile');
const b = new Browser({
  chrome: CHROME, profile, ext: EXT, consoleLog, headless: process.env.HEADLESS === '1',
  extraArgs: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
});
async function shot(p, name) {
  step++;
  const f = join(out, `${String(step).padStart(2, '0')}-${name}.png`);
  await p.shot(f);
  note(`     screenshot ${f.split('/').pop()}`);
}
async function readConsole(label) {
  await b.serviceWorker();
  await sleep(3000);
  const mine = b.problems.splice(0);
  check(`${label}: the service worker started (${b.extId}) and its console shows no exception or error`, mine.length === 0, mine.length ? mine : undefined);
}
const ui = (pop, method, params = {}) => pop.eval(`chrome.runtime.sendMessage({scope:'ui', method:${JSON.stringify(method)}, params:${JSON.stringify(params)}})`);
const setMode = async (pop, m) => {
  await pop.click('[data-tab=settings]');
  await pop.eval(`(()=>{const s=document.querySelector('#setMode'); s.value=${JSON.stringify(m)}; s.dispatchEvent(new Event('change')); return true})()`);
  await pop.waitFor(`document.querySelector('#leafCard').classList.contains('hide') === ${m !== 'developer'}`, 30000);
};
// The popup's user-mode screens, as a person reads them.
const userScreensText = async (pop) => {
  const parts = [];
  for (const t of ['balance', 'send', 'receive', 'stake']) {
    await pop.click(`[data-tab=${t}]`); await sleep(800);
    parts.push(await pop.eval(`document.querySelector('#t${t[0].toUpperCase() + t.slice(1)}').innerText`));
  }
  parts.push(await pop.eval("(document.querySelector('.hdr')||{}).innerText||''"));
  await pop.click('[data-tab=balance]');
  return parts.join('\n');
};
const rowOf = (pop, key) => pop.eval(`(()=>{ const r=document.querySelector('#assetList .asset-row[data-key=${JSON.stringify(key)}]'); return r ? { figure: r.querySelector('.fig').innerText.trim(), text: r.innerText.replace(/\\s+/g,' ').trim(), split: (r.querySelector('.rail-split')||{}).innerText||'' } : null })()`);
const unlock = async (pop) => {
  await pop.waitFor("document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null && !!document.querySelector('#btnUnlock').onclick", 60000);
  await pop.set('unlockPw', 'drive-password'); await pop.click('#btnUnlock');
  await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
};

async function main() {
  const srv = spawn(process.execPath, [join(here, 'dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] });
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]); }));
  try {
    const st = await ctl('/state');
    const X = st.x;
    note(`operator ${st.server}; node ${st.node_url}; asset X ${X}`);
    const create = ['create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca'];

    // --- The wallet: created in the popup, joined in developer mode, then user mode ---
    await b.launch('start 1');
    await readConsole('start 1');
    const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    await pop.waitFor("document.querySelector('#btnStartCreate') && document.querySelector('#btnStartCreate').offsetParent !== null && !!document.querySelector('#btnStartCreate').onclick", 60000);
    await pop.click('#btnStartCreate');
    await pop.waitFor("document.querySelector('#newPhrase').dataset.phrase");
    const mnemonic = await pop.eval("document.querySelector('#newPhrase').dataset.phrase");
    await pop.set('createPw', 'drive-password'); await pop.set('createPw2', 'drive-password');
    await pop.click('#btnCreateGo');
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    await setMode(pop, 'developer');
    await pop.set('leafServer', base + 'operator'); await pop.set('leafNodeUrl', base + 'node');
    await pop.set('leafNodeUser', st.node_user); await pop.set('leafNodePassword', st.node_password);
    await pop.set('leafDelay', '1'); await pop.set('leafMinDelay', '1');
    await pop.click('#btnLeafJoin');
    await pop.waitFor("!document.querySelector('#leafJoined').classList.contains('hide') || /refused|error|could not|failed/i.test(document.querySelector('#leafStatus').innerText)", 180000);
    check('the wallet joined the operator (developer mode)', !(await pop.eval("document.querySelector('#leafJoined').classList.contains('hide')")), await pop.text('#leafStatus'));
    // The drive's shortcuts: the host's tick, 60 s in use, is 4 s here, and care, at most
    // every ten minutes in use, at most every 5 s.
    await pop.eval("chrome.storage.local.get(['ext.walletTag','ext.leaves.byWallet']).then((o)=>{const t=o['ext.walletTag'], all=o['ext.leaves.byWallet']; all[t]={...all[t], tick_ms: 4000, care_ms: 5000}; return chrome.storage.local.set({'ext.leaves.byWallet': all})})");
    await setMode(pop, 'user');
    const recv = await ui(pop, 'receive', { confidential: false });
    await b.close();

    // The key of the address the Receive tab shows: m/84'/1'/0'/0/i.
    const index = Number(recv.result.index) || 0;
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
    const key = Buffer.from(root.derive(`m/84'/1'/0'/0/${index}`).publicKey).toString('hex');
    note(`     the wallet's receive address ${recv.result.address}, index ${index}, key ${key}`);

    // --- The payer, and two other holders (command-line wallets) ---
    cli('payer', ...create);
    await ctl('/fund', { script: cli('payer', 'address').script_pubkey, asset: X, amount: 30000000 });
    await ctl('/produce');
    cli('payer', 'board', X, '22000000');
    await ctl('/produce'); await ctl('/bury');
    for (let i = 0; i < 120 && cli('payer', 'boards')[0]?.server?.state !== 'credited'; i++) await sleep(500);
    cli('payer', 'sync');
    const holders = [['extension', key, 3000000]];
    for (const h of ['holder-b', 'holder-c']) { cli(h, ...create); holders.push([h, cli(h, 'address').key, 2000000]); }
    const file = join(work, 'claims.txt');
    writeFileSync(file, '# key amount\n' + holders.map(([, k, v]) => `${k} ${v}`).join('\n') + '\n');
    const q = cli('payer', 'distribute', file, '--asset', X, '--quote');
    const d = cli('payer', 'distribute', file, '--asset', X, '--shown', String(q.fee));
    check('the payer distributes to three holders, this wallet one of them', d.state === 'pending' && (d.claims || []).length === 3, { fee: q.fee, state: d.state, error: d.error });
    const r1 = await ctl('/round');
    note(`     the distribution's round ${JSON.stringify(r1)}`);
    cli('payer', 'sync');

    // --- 1. Taken up with no click, in user mode: the asset in its one figure ---
    await b.launch('start 2');
    await readConsole('start 2');
    const pop2 = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    await unlock(pop2);
    await pop2.click('[data-tab=balance]');
    let row = null;
    // The claim of 3,000,000 is paid on to a leaf of the wallet's, less that payment's fee.
    const atLeast = 2_990_000n;
    const figureOf = (r) => BigInt((r && r.figure.replace(/[^\d]/g, '')) || 0);
    for (let i = 0; i < 90 && !(figureOf(row) >= atLeast); i++) {
      await sleep(2000);
      row = await rowOf(pop2, X);
    }
    check('user mode: the claim taken up with no click shows in X\'s one figure', figureOf(row) >= atLeast, row);
    const ov = (await ui(pop2, 'overview', { withLn: false })).result;
    const xr = ov.rows.find((r) => r.key === X);
    check('the figure counts the claimed leaf: on-chain + leaves + Lightning + staked', !!xr && BigInt(xr.total) === BigInt(xr.onchain) + BigInt(xr.leaves) + BigInt(xr.ln) + BigInt(xr.staked) && BigInt(xr.leaves) >= atLeast, xr);
    check('user mode: no rail split and no Move shown', (await pop2.eval("document.querySelectorAll('#assetList .rail-split, #assetList .bal-acts').length")) === 0);
    await shot(pop2, 'claim-taken-up-user-mode');
    for (const h of ['holder-b', 'holder-c']) {
      const t = cli(h, 'care');
      check(`${h} takes its claim up by care`, Array.isArray(t.claims) && t.claims.some((c) => c.taken_up), (Array.isArray(t.claims) ? t.claims : [t.claims]).map((c) => (c && c.taken_up ? 'taken up' : (c && (c.state || c.error)))));
    }
    const words1 = developerWordsIn(await userScreensText(pop2));
    check('user mode: Balance, Send, Receive, Stake and the header carry no developer word', words1.length === 0, words1);
    await shot(pop2, 'balance-user-mode');

    // --- 2. Sent into a round once its refresh could run within ten days; then planned ---
    await setMode(pop2, 'developer');
    await pop2.waitFor("!document.querySelector('#leafJoined').classList.contains('hide')", 60000);
    const lastCare = async () => (await ui(pop2, 'leaves.state')).result;
    let ls = await lastCare();
    note(`     care so far: ${JSON.stringify(ls.status && ls.status.lastCare && ls.status.lastCare.summary)}`);
    const claims = ((ls.status && ls.status.lastCare && ls.status.lastCare.value) || {}).claims;
    check('developer mode: care reports the claim taken (claimed, or taken up in this run)', Array.isArray(claims) && claims.some((c) => c.taken_up || c.state === 'claimed'), claims);
    const coins = (await ui(pop2, 'leaves.state')).result.schedule.coins || [];
    note(`     schedule coins: ${JSON.stringify(coins.map((c) => [c.leaf_id && c.leaf_id.slice(0, 12), c.state, c.exit_by, c.refresh_from]))}`);
    // A coin's expiry is three days after its exit date.
    const expiryOf = (c) => (typeof c.exit_by === 'number' ? c.exit_by + 3 * DAY : null);
    const expiry = Math.max(...coins.map(expiryOf).filter((e) => e != null));
    const now0 = ls.schedule.now;
    // Ten days before its step window (five days before expiry) opens, and a day more. The
    // claim is a leaf of no round: care first sends it into a round's refresh, whose new
    // leaf is planned once it, too, is that near its window.
    await ctl('/advance', { seconds: Math.max(1, expiry - 5 * DAY - 10 * DAY + DAY - now0) });
    await ctl('/produce');
    let refreshed = false;
    for (let i = 0; i < 90 && !refreshed; i++) {
      await sleep(2000);
      ls = await lastCare();
      refreshed = ((ls.status && ls.status.lastCare && ls.status.lastCare.summary) || {}).refreshing >= 1;
    }
    check('care sent the claimed leaf into a round\'s refresh by itself', refreshed, ls.status && ls.status.lastCare && ls.status.lastCare.value);
    const rr = await ctl('/round');
    note(`     its round ${JSON.stringify(rr)}`);
    let fresh = [];
    for (let i = 0; i < 90; i++) {
      ls = await lastCare();
      fresh = ((ls.schedule && ls.schedule.coins) || []).filter((c) => c.state === 'live' && expiryOf(c) > expiry);
      if (fresh.length) break;
      await sleep(2000);
    }
    check('the new leaf of the round is live, a horizon later', fresh.length >= 1, fresh.map((c) => [c.leaf_id, c.state, c.exit_by]));
    const expiry2 = Math.max(...fresh.map(expiryOf));
    // Every leaf of a round is planned at the next care: no time moves for it.
    await pop2.click('[data-tab=settings]');
    let plans = [];
    for (let i = 0; i < 90; i++) {
      plans = await pop2.eval("[...document.querySelectorAll('#leafPlans .leaf-plan')].map(p=>({ plan: p.dataset.plan, state: p.dataset.state, text: p.innerText.replace(/\\s+/g,' ') }))");
      if (plans.some((p) => p.state === 'open')) break;
      await sleep(2000);
      await pop2.eval("document.querySelector('[data-tab=settings]').click()");
    }
    const open = plans.find((p) => p.state === 'open');
    check('developer mode: the round\'s leaf planned by itself at once, with Cancel and Release', !!open && /Cancel/.test(open.text) && /Release/.test(open.text), plans);
    const marked = await pop2.eval("[...document.querySelectorAll('#leafCoins .leaf-coin')].filter(d=>d.dataset.planned).map(d=>d.dataset.leaf)");
    check('developer mode: the planned leaf is marked under Leaves and their dates', marked.length >= 1, marked);
    await pop2.eval("document.querySelector('#leafCare').scrollIntoView()");
    await shot(pop2, 'plan-developer-mode');
    // Release, from the card: the plan's leaf given up in the next round for a leaf no
    // plan names (plan_release); the plan ends once that round is final.
    const planOf = (id) => `[...document.querySelectorAll('#leafPlans .leaf-plan')].find(p=>p.dataset.plan===${JSON.stringify(id)})`;
    let expiry3 = null;
    if (open) {
      await pop2.eval(`${planOf(open.plan)}.querySelectorAll('button')[1].click()`);
      await pop2.waitFor("!/Releasing/.test(document.querySelector('#leafStatus').innerText)", 60000);
      check('Release gives the planned leaf up in the next round with no refusal', !(await pop2.text('#leafStatus')), await pop2.text('#leafStatus'));
      await shot(pop2, 'release-asked');
      const rr2 = await ctl('/round');
      check('the operator builds the round that releases it', !!rr2.round, rr2);
      let fresh2 = [];
      for (let i = 0; i < 90; i++) {
        ls = await lastCare();
        fresh2 = ((ls.schedule && ls.schedule.coins) || []).filter((c) => c.state === 'live' && expiryOf(c) > expiry2);
        if (fresh2.length) break;
        await sleep(2000);
      }
      check('the released leaf is live again in a new round, a horizon later', fresh2.length >= 1, fresh2.map((c) => [c.leaf_id, c.state, c.exit_by]));
      expiry3 = fresh2.length ? Math.max(...fresh2.map(expiryOf)) : null;
    }
    // Planned again by care once the day the library leaves a released leaf free to pay
    // has passed (RELEASE_HOLD), and cancelled from the card this time.
    if (expiry3) {
      await ctl('/advance', { seconds: DAY + 600 });
      await ctl('/produce');
      let again = null;
      for (let i = 0; i < 90 && !again; i++) {
        await sleep(2000);
        await pop2.eval("document.querySelector('[data-tab=settings]').click()");
        await sleep(500);
        again = await pop2.eval(`(()=>{ const p=[...document.querySelectorAll('#leafPlans .leaf-plan')].find(p=>p.dataset.state==='open'); return p ? p.dataset.plan : null })()`);
      }
      check('care plans the new leaf by itself', !!again, again);
      if (again) {
        await pop2.eval(`${planOf(again)}.querySelector('button').click()`);
        await pop2.waitFor(`(()=>{ const p=${planOf(again)}; return p && p.dataset.state !== 'open' })()`, 60000).catch(() => {});
        const after = await pop2.eval(`(()=>{ const p=${planOf(again)}; return p ? p.dataset.state : null })()`);
        check('Cancel cancels the plan', after === 'cancelled', { state: after, status: await pop2.text('#leafStatus') });
        await pop2.eval("document.querySelector('#leafCare').scrollIntoView()");
        await shot(pop2, 'plan-cancelled');
      }
    }
    await setMode(pop2, 'user');
    await pop2.click('[data-tab=balance]');
    await sleep(1500);
    const words2 = developerWordsIn(await userScreensText(pop2));
    check('user mode after planning: still no developer word', words2.length === 0, words2);
    const tapped = await pop2.eval(`(()=>{ const r=document.querySelector('#assetList .asset-row[data-key=${JSON.stringify(X)}]'); if (r && r.classList.contains('tappable')) r.click(); return !!r })()`);
    await sleep(500);
    note(`     the row tapped: ${JSON.stringify(await rowOf(pop2, X))} (tappable: ${tapped})`);
    await shot(pop2, 'balance-user-mode-end');
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
