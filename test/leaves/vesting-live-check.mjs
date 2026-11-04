#!/usr/bin/env node
// What default mode shows of a vesting holding, on the live network, read only: this extension
// in headless Chromium with the phrase in PHRASE_FILE imported, the row of ASSET (hex) and its
// "<amount> <TICKER> vests on <date>" line, checked against the developer words and the words
// default mode never says; then Send asked for AMOUNT of it, which needs what has not vested: it
// must be refused with the sentence, nothing signed.
//
// After the date (AFTER=1, with TO a receive code to pay): the line is gone, the figure still
// holds the coins (taken up by the wallet itself), and Send of AMOUNT to TO is sent.
//
//   CHROME=… PHRASE_FILE=… ASSET=<hex> TICKER=EURX AMOUNT=0.05 \
//     node test/leaves/vesting-live-check.mjs <evidence-dir> <work-dir>
//
// The phrase is read from its file and written nowhere else.
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from './cdp.mjs';
import { developerWordsIn } from '../../src/balance-view.js';
import { forbiddenIn } from '../../vendor/user-trade.js';
const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const ASSET = process.env.ASSET, TICKER = process.env.TICKER || '', AMOUNT = process.env.AMOUNT || '';
if (!process.env.CHROME || !process.env.PHRASE_FILE || !ASSET || !TICKER || !AMOUNT) { console.error('set CHROME, PHRASE_FILE, ASSET, TICKER and AMOUNT'); process.exit(2); }
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const out = resolve(process.argv[2]); const work = resolve(process.argv[3]);
mkdirSync(out, { recursive: true }); mkdirSync(work, { recursive: true });
const log = join(out, 'drive.log');
const note = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); appendFileSync(log, l + '\n'); };
let failures = 0;
const check = (w, ok, d) => { note(`${ok ? 'ok  ' : 'FAIL'} ${w}${d !== undefined ? ': ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) failures++; };
const b = new Browser({ chrome: process.env.CHROME, profile: join(work, 'chrome-profile'), ext: EXT, consoleLog: join(out, 'console.log'), headless: true });
const rowOf = (pop, key) => pop.eval(`(()=>{ const r=document.querySelector('#assetList .asset-row[data-key=${JSON.stringify(key)}]'); return r ? { figure: r.querySelector('.fig').innerText.trim(), vests: [...r.querySelectorAll('.vests-line')].map(v=>v.textContent), text: r.innerText.replace(/\\s+/g,' ').trim() } : null })()`);
async function main() {
  const phrase = readFileSync(process.env.PHRASE_FILE, 'utf8').trim();
  await b.launch('live');
  await b.serviceWorker();
  const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
  await pop.waitFor("document.querySelector('#btnStartImport') && document.querySelector('#btnStartImport').offsetParent !== null && !!document.querySelector('#btnStartImport').onclick", 60000);
  await pop.click('#btnStartImport');
  await pop.set('importPhrase', phrase);
  await pop.set('importPw', 'drive-password'); await pop.set('importPw2', 'drive-password');
  await pop.click('#btnImportGo');
  await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 180000);
  note('version ' + (await pop.eval('chrome.runtime.getManifest().version')));
  await pop.click('[data-tab=balance]');
  let row = null;
  if (process.env.AFTER === '1') return after(pop);
  for (let i = 0; i < 150; i++) { row = await rowOf(pop, ASSET); if (row && row.vests.length) break; await sleep(4000); }
  check(`default mode: the ${TICKER} row shows what vests, with its date`, !!row && new RegExp(`^[0-9.,]+ ${esc(TICKER)} vests on \\d{1,2} [A-Z][a-z]+ \\d{4}$`).test(row.vests[0] || ''), row);
  check('the row carries no developer word and none of the words default mode never says', !!row && developerWordsIn(row.text).length === 0 && forbiddenIn(row.text).length === 0, row && [developerWordsIn(row.text), forbiddenIn(row.text)]);
  await pop.shot(join(out, 'vesting-row.png'));
  const recv = await pop.eval("chrome.runtime.sendMessage({scope:'ui', method:'receive', params:{confidential:false}})");
  const to = (recv && (recv.result && (recv.result.address || recv.result.unconfidential))) || '';
  await pop.click('[data-tab=send]'); await sleep(800);
  await pop.eval(`(()=>{ const s=document.querySelector('#sendDAsset'); s.value=${JSON.stringify(ASSET)}; s.dispatchEvent(new Event('change')); return s.value })()`);
  await pop.set('sendDTo', to); await pop.set('sendDAmt', AMOUNT);
  await pop.click('#btnDReview');
  await pop.waitFor("document.querySelector('#sendDErr').textContent.length > 0 || !!document.querySelector('.modal')", 60000).catch(() => {});
  const err = (await pop.text('#sendDErr')).trim();
  check(`Send of ${AMOUNT} ${TICKER} before the date: refused with the sentence, nothing signed`, new RegExp(`^${esc(AMOUNT)} ${esc(TICKER)} of this vests on \\d{1,2} [A-Z][a-z]+ \\d{4}, and can be used from then\\. Nothing has moved\\.$`).test(err) && !(await pop.eval("!!document.querySelector('.modal')")), { err, to: to.slice(0, 12) });
  await pop.shot(join(out, 'send-refused.png'));
}
async function after(pop) {
  let row = null;
  for (let i = 0; i < 150; i++) {
    row = await rowOf(pop, ASSET);
    if (row && !row.vests.length && /[1-9]/.test(row.figure) && !/arriving/i.test(row.text)) break;
    await sleep(4000);
  }
  check(`after the date: no vesting line, and the ${TICKER} figure holds the coins`, !!row && !row.vests.length && /[1-9]/.test(row.figure), row);
  await pop.shot(join(out, 'after-row.png'));
  const to = process.env.TO || '';
  let sent = '', err = '';
  for (let tries = 0; tries < 10 && !/^Sent /.test(sent); tries++) {
    await pop.click('[data-tab=send]'); await sleep(800);
    await pop.eval(`(()=>{ document.querySelector('#sendDErr').textContent=''; const s=document.querySelector('#sendDAsset'); s.value=${JSON.stringify(ASSET)}; s.dispatchEvent(new Event('change')); return s.value })()`);
    await pop.set('sendDTo', to); await pop.set('sendDAmt', AMOUNT);
    await pop.click('#btnDReview');
    await pop.waitFor("document.querySelector('#sendDErr').textContent.length > 0 || !!document.querySelector('.modal button.primary')", 120000).catch(() => {});
    err = (await pop.text('#sendDErr')).trim();
    if (!err) {
      await pop.eval("document.querySelector('.modal button.primary').click()");
      await pop.waitFor("[...document.querySelectorAll('.modal .status')].some(s=>/^Sent |declined|refused|nothing|arriving/i.test(s.textContent))", 180000).catch(() => {});
      sent = await pop.eval("[...document.querySelectorAll('.modal .status')].map(s=>s.textContent).join(' | ')");
    }
    if (/^Sent /.test(sent)) break;
    note(`     try ${tries + 1}: ${err || sent}`);
    await pop.eval("document.querySelectorAll('.modal').forEach(m=>m.remove())");
    await sleep(30000);
  }
  check(`after the date: Send of ${AMOUNT} ${TICKER} is sent`, /^Sent /.test(sent), err || sent);
  await pop.shot(join(out, 'after-sent.png'));
}

main().then(async () => { await b.close().catch(() => {}); note(`done, ${failures} failed`); process.exit(failures ? 1 : 0); },
  async (e) => { note('FAIL ' + (e && e.stack || e)); await b.close().catch(() => {}); process.exit(1); });
