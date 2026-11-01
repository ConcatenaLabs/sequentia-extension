#!/usr/bin/env node
// Drives what default mode shows of a vesting allocation, in Chromium with this extension
// loaded, against a local regtest operator building batches without a sweep (the harness
// started with ARCA_OPERATOR_NO_SWEEP), the wallet in default mode throughout:
//
//  1. two vesting distributions (`arca distribute --vest`) from a command-line payer: one to
//     the key of the address the Receive tab shows, vesting a few minutes on; one a day later
//     to the staking key a site's sign-in names (`signStakerMessage`), and to the key
//     `signMessage` signs with (the master key, which the wallet does not look claims up
//     under: its claim must not show);
//  2. before either date: the asset's row, its one figure counting what vests, a line for each
//     date, and Send and Trade refused with the sentence, nothing signed;
//  3. the chain's median time moved past the first date: the claim taken up by itself, its line
//     gone, and the coins sent to another wallet's receive code.
//
// Needs, running: the operator harness (arca repository,
// bark-cli/tests/arca_operator_for_browsers.rs) with ARCA_OPERATOR_NO_SWEEP set, and that
// repository's command-line wallet (`arca`). The wallet's phrase is read from PHRASE_FILE and
// written nowhere else. Start the harness fresh for each run: the drive moves the chain's
// median time.
//
//   CHROME=… ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca PHRASE_FILE=… \
//     node test/leaves/vesting-drive.mjs <evidence-dir> <work-dir>
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from './cdp.mjs';
import { HDKey, mnemonicToSeedSync } from '../../vendor/btc.js';
import { developerWordsIn } from '../../src/balance-view.js';
import { forbiddenIn } from '../../vendor/user-trade.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const CHROME = process.env.CHROME;
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const cliBin = process.env.ARCA_CLI;
const phraseFile = process.env.PHRASE_FILE;
const out = resolve(process.argv[2] || 'vesting-evidence');
const work = resolve(process.argv[3] || mkdtempSync('/tmp/vesting-drive-'));
if (!CHROME || !cliBin || !phraseFile) { console.error('set CHROME, ARCA_CLI and PHRASE_FILE'); process.exit(2); }
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
const ui = (pop, method, params = {}) => pop.eval(`chrome.runtime.sendMessage({scope:'ui', method:${JSON.stringify(method)}, params:${JSON.stringify(params)}})`);
const setMode = async (pop, m) => {
  await pop.click('[data-tab=settings]');
  await pop.eval(`(()=>{const s=document.querySelector('#setMode'); s.value=${JSON.stringify(m)}; s.dispatchEvent(new Event('change')); return true})()`);
  await pop.waitFor(`document.querySelector('#leafCard').classList.contains('hide') === ${m !== 'developer'}`, 30000);
};
const rowOf = (pop, key) => pop.eval(`(()=>{ const r=document.querySelector('#assetList .asset-row[data-key=${JSON.stringify(key)}]'); return r ? { figure: r.querySelector('.fig').innerText.trim(), vests: [...r.querySelectorAll('.vests-line')].map(v=>v.textContent), text: r.innerText.replace(/\\s+/g,' ').trim() } : null })()`);
const unlock = async (pop) => {
  await pop.waitFor("document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null && !!document.querySelector('#btnUnlock').onclick", 60000);
  await pop.set('unlockPw', 'drive-password'); await pop.click('#btnUnlock');
  await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
};
const digits = (s) => BigInt(String(s || '').replace(/[^\d]/g, '') || 0);

async function main() {
  const srv = spawn(process.execPath, [join(here, 'dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] });
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]); }));
  try {
    const st = await ctl('/state');
    const X = st.x;
    note(`operator ${st.server}; asset X ${X}`);
    const create = ['create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca'];
    const phrase = readFileSync(phraseFile, 'utf8').trim();

    // --- The wallet: imported from the fixed test phrase, joined, then default mode ---
    await b.launch('start 1');
    await b.serviceWorker();
    const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    await pop.waitFor("document.querySelector('#btnStartImport') && document.querySelector('#btnStartImport').offsetParent !== null && !!document.querySelector('#btnStartImport').onclick", 60000);
    await pop.click('#btnStartImport');
    await pop.set('importPhrase', phrase);
    await pop.set('importPw', 'drive-password'); await pop.set('importPw2', 'drive-password');
    await pop.click('#btnImportGo');
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    await setMode(pop, 'developer');
    await pop.set('leafServer', base + 'operator'); await pop.set('leafNodeUrl', base + 'node');
    await pop.set('leafNodeUser', st.node_user); await pop.set('leafNodePassword', st.node_password);
    await pop.set('leafDelay', '1'); await pop.set('leafMinDelay', '1');
    await pop.click('#btnLeafJoin');
    await pop.waitFor("!document.querySelector('#leafJoined').classList.contains('hide') || /refused|error|could not|failed/i.test(document.querySelector('#leafStatus').innerText)", 180000);
    check('the wallet joined the operator', !(await pop.eval("document.querySelector('#leafJoined').classList.contains('hide')")), await pop.text('#leafStatus'));
    await pop.eval("chrome.storage.local.get(['ext.walletTag','ext.leaves.byWallet']).then((o)=>{const t=o['ext.walletTag'], all=o['ext.leaves.byWallet']; all[t]={...all[t], tick_ms: 4000, care_ms: 5000}; return chrome.storage.local.set({'ext.leaves.byWallet': all})})");
    await setMode(pop, 'user');
    const recv = await ui(pop, 'receive', { confidential: false });
    const stake = await ui(pop, 'stakingOverview');
    await b.close();

    // The keys: the Receive tab's address key; the staking key `signStakerMessage` signs a site's
    // sign-in with (the wallet's own answer); the master key `signMessage` signs with.
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase));
    const index = Number(recv.result.index) || 0;
    const recvKey = Buffer.from(root.derive(`m/84'/1'/0'/0/${index}`).publicKey).toString('hex');
    const stakerKey = String(stake.result && stake.result.stakerKey || '').toLowerCase();
    const stakerDerived = Buffer.from(root.derive('m/2/0').publicKey).toString('hex');
    const masterKey = Buffer.from(root.publicKey).toString('hex');
    check('the staking key the wallet signs a sign-in with is m/2/0', stakerKey === stakerDerived, stakerKey);
    note(`     keys: receive index ${index} ${recvKey}; staking key ${stakerKey}; signMessage's master key ${masterKey}`);

    // --- The payer and the two distributions ---
    cli('payer', ...create);
    await ctl('/fund', { script: cli('payer', 'address').script_pubkey, asset: X, amount: 40000000 });
    await ctl('/produce');
    cli('payer', 'board', X, '30000000');
    await ctl('/produce'); await ctl('/bury');
    for (let i = 0; i < 120 && cli('payer', 'boards')[0]?.server?.state !== 'credited'; i++) await sleep(500);
    cli('payer', 'sync');
    // The other wallet accepts the short exit delays the browser wallet's coins carry here.
  cli('other', ...create, '--min-exit-delay-units', '1');
    const now0 = (await ctl('/advance', { seconds: 1 })).median_time;
    const v1 = now0 + 600, v2 = now0 + 86400 + 600;
    const distribute = async (name, lines, vest) => {
      const file = join(work, name + '.txt');
      writeFileSync(file, '# key amount\n' + lines.map(([k, v]) => `${k} ${v}`).join('\n') + '\n');
      const q = cli('payer', 'distribute', file, '--asset', X, '--quote');
      const d = cli('payer', 'distribute', file, '--asset', X, '--shown', String(q.fee), '--vest', String(vest), '--days', '7');
      check(`${name}: the payer distributes vesting on ${d.vests}`, d.state === 'pending' && d.vest === vest, { state: d.state, vests: d.vests, error: d.error });
      const built = await ctl('/build');
      cli('payer', 'sync');
      await ctl('/pass'); await ctl('/produce'); await ctl('/bury');
      note(`     ${name}'s round ${JSON.stringify(built).slice(0, 300)}`);
      for (let i = 0; i < 60; i++) { const s = (cli('payer', 'distributions').find((x) => x.vest === vest) || {}).state; if (s === 'released') break; await ctl('/settle'); cli('payer', 'sync'); await sleep(1000); }
      const s = cli('payer', 'distributions').find((x) => x.vest === vest);
      check(`${name} is released`, s && s.state === 'released', s && s.state);
      return d;
    };
    const d1 = await distribute('first', [[recvKey, 3000000]], v1);
    const d2 = await distribute('second', [[stakerKey, 3500000], [masterKey, 1000000]], v2);

    // --- 2. Before either date ---
    await b.launch('start 2');
    await b.serviceWorker();
    const pop2 = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    await unlock(pop2);
    await pop2.click('[data-tab=balance]');
    let row = null;
    for (let i = 0; i < 90; i++) { row = await rowOf(pop2, X); if (row && row.vests.length === 2) break; await sleep(2000); }
    const tk = row ? row.text.split(' ')[0] : '?';
    const ov = (await ui(pop2, 'overview', { withLn: false })).result;
    const xr = ov.rows.find((r) => r.key === X) || {};
    // The popup writes an amount as its asset's precision gives it (an asset the registry does not
    // know: whole units, ungrouped).
    const want1 = `3000000 ${xr.ticker} vests on ${d1.vests}`, want2 = `3500000 ${xr.ticker} vests on ${d2.vests}`;
    check('default mode: the asset held only as what vests has its row, a line for each date', !!row && row.vests.length === 2 && row.vests[0] === want1 && row.vests[1] === want2, row);
    check('the second line is the staking key\'s claim alone (3500000): the claim under signMessage\'s master key is not found', !!row && row.vests[1] === want2);
    check('the figure counts what vests: 6,500,000, of which nothing can be spent', digits(row && row.figure) === 6500000n && xr.vestingAtoms === '6500000', { figure: row && row.figure, vestingAtoms: xr.vestingAtoms });
    check('the row carries no developer word and none of the words default mode never says', !!row && developerWordsIn(row.text).length === 0 && forbiddenIn(row.text).length === 0, row && [developerWordsIn(row.text), forbiddenIn(row.text)]);
    note(`     ticker ${tk}; headline ${(await pop2.text('#headline'))}`);
    await shot(pop2, 'vesting-lines-default-mode');

    // Send: to another wallet's receive code.
    const code = cli('other', 'receive').request;
    await pop2.click('[data-tab=send]');
    await sleep(800);
    await pop2.eval(`(()=>{ const s=document.querySelector('#sendDAsset'); s.value=${JSON.stringify(X)}; s.dispatchEvent(new Event('change')); return s.value })()`);
    await pop2.set('sendDTo', code); await pop2.set('sendDAmt', '10');
    note(`     the send form: ${(await pop2.text('#sendDAvail'))}`);
    await pop2.click('#btnDReview');
    await pop2.waitFor("document.querySelector('#sendDErr').textContent.length > 0 || !!document.querySelector('.modal')", 60000).catch(() => {});
    const sendErr = await pop2.text('#sendDErr');
    check('Send before the date: refused with the sentence, nothing signed', sendErr === `10 ${xr.ticker} of this vests on ${d1.vests}, and can be used from then. Nothing has moved.` && !(await pop2.eval("!!document.querySelector('.modal')")), sendErr);
    await shot(pop2, 'send-refused');

    // Trade: pay the asset for BTC.
    await pop2.click('[data-tab=trade]');
    await pop2.waitFor("!!document.querySelector('#ucPay')", 60000);
    const pick = async (id, hex) => {
      await pop2.click('#' + id);
      await pop2.waitFor(`!!document.querySelector('[data-hex=${JSON.stringify(hex)}]')`, 10000);
      await pop2.eval(`document.querySelector('[data-hex=${JSON.stringify(hex)}]').click()`);
      await sleep(500);
    };
    await pick('ucPay', X);
    await pick('ucGet', 'BTC');
    await pop2.eval("(()=>{ const i=document.querySelector('#ucAmount'); i.value='5'; i.dispatchEvent(new Event('input')); return true })()");
    await sleep(800);
    await pop2.click('#ucReview');
    await pop2.waitFor("document.querySelector('#userComposerRoot').innerText.includes('of this vests on')", 60000).catch(() => {});
    const tradeText = (await pop2.text('#userComposerRoot')).replace(/\s+/g, ' ');
    check('Trade before the date: refused with the sentence', tradeText.includes(`5 ${xr.ticker} of this vests on ${d1.vests}, and can be used from then. Nothing has moved.`), tradeText.slice(0, 600));
    await shot(pop2, 'trade-refused');

    // --- 3. Past the first date: taken up by itself, then sent ---
    await pop2.click('[data-tab=balance]');
    await ctl('/advance', { seconds: v1 - (await ctl('/advance', { seconds: 1 })).median_time + 3600 });
    await ctl('/produce'); await ctl('/bury');
    let after = null;
    for (let i = 0; i < 90; i++) { after = await rowOf(pop2, X); if (after && after.vests.length === 1 && !/arriving/.test(after.text) && digits(after.figure) >= 6490000n) break; if (i % 10 === 9) await ctl('/settle'); await sleep(2000); }
    check('past the first date: the claim taken up by itself, one line left, the figure unchanged but for the take-up\'s fee', !!after && after.vests.length === 1 && after.vests[0] === want2 && digits(after.figure) >= 6490000n, after);
    await shot(pop2, 'after-first-date');
    let ov2 = null;
    for (let i = 0; i < 30; i++) { ov2 = ((await ui(pop2, 'overview', { withLn: false })).result.rows || []).find((r) => r.key === X); if (ov2 && ov2.arriving === '0') break; await sleep(2000); }
    note(`     the overview row: ${JSON.stringify({ total: ov2 && ov2.total, leaves: ov2 && ov2.leaves, arriving: ov2 && ov2.arriving, vestingAtoms: ov2 && ov2.vestingAtoms })}`);
    const code2 = cli('other', 'receive').request;
    await pop2.click('[data-tab=send]');
    await sleep(800);
    await pop2.eval(`(()=>{ document.querySelector('#sendDErr').textContent=''; const s=document.querySelector('#sendDAsset'); s.value=${JSON.stringify(X)}; s.dispatchEvent(new Event('change')); return s.value })()`);
    await pop2.set('sendDTo', code2); await pop2.set('sendDAmt', '1000000');
    await pop2.click('#btnDReview');
    await pop2.waitFor("document.querySelector('#sendDErr').textContent.length > 0 || !!document.querySelector('.modal button.primary')", 60000);
    const err2 = await pop2.text('#sendDErr');
    if (!err2) {
      await shot(pop2, 'send-review');
      await pop2.eval("document.querySelector('.modal button.primary').click()");
      await pop2.waitFor("[...document.querySelectorAll('.modal .status')].some(s=>/^Sent |declined|refused|nothing/i.test(s.textContent))", 120000).catch(() => {});
    }
    const sent = await pop2.eval("[...document.querySelectorAll('.modal .status')].map(s=>s.textContent).join(' | ')");
    check('past the date: 1,000,000 sent to another wallet\'s receive code', /^Sent 1,?000,?000 /.test(sent), err2 || sent);
    await shot(pop2, 'sent-after-vesting');
    let got = [];
    for (let i = 0; i < 20; i++) { const mb = cli('other', 'mailbox'); if (i === 0 || i === 19) note(`     the other wallet's mailbox: ${JSON.stringify(mb).slice(0, 600)}`); got = [...((mb && mb.accepted) || []), ...((cli('other', 'coins') || []))].filter((c) => c && c.asset === X); if (got.length) break; await sleep(2000); }
    check('the other wallet holds what was sent', got.some((c) => String(c.value) === '1000000'), got.map((c) => [c.value, c.state]));
    const late = b.problems.splice(0);
    check('no exception or console error from the extension\'s contexts during the drive', late.length === 0, late.length ? late : undefined);
    await b.close();
  } finally {
    srv.kill();
  }
}

main().then(() => {
  note(failures ? `${failures} check(s) failed` : 'all passed');
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  process.exit(failures ? 1 : 0);
}).catch(async (e) => {
  note('ERROR ' + (e.stack || e));
  try { await b.close(); } catch {}
  try { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  process.exit(1);
});
