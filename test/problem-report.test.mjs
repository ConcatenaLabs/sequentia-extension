// Report a problem in Ambra browser: the web wallet's module (vendor/problem-report.js), its card
// in Settings, and the two worker methods that keep the phrase in the worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forbiddenIn } from '../vendor/user-trade.js';
import { REPORT_WORDS, buildReport, refusal } from '../vendor/problem-report.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the words of Report a problem say none of the forbidden words', () => {
  for (const w of Object.values(REPORT_WORDS)) {
    const t = typeof w === 'function' ? w(1) : w;
    assert.deepEqual(forbiddenIn(t), [], t);
  }
});

test('the card sits in Settings and every element the popup fills is there', () => {
  const html = read('popup/popup.html');
  const settings = html.indexOf('id="tSettings"');
  assert.ok(html.indexOf('id="reportCard"') > settings, 'in Settings');
  for (const id of ['reportTitle', 'reportIntro', 'reportTextLabel', 'reportText', 'reportCodeLabel', 'reportCode', 'reportCodeHint',
    'reportIncludes', 'reportAddr', 'reportAddrLabel', 'reportAddrList', 'reportAddrWill', 'reportAddrValue', 'reportPreview',
    'reportPreviewLabel', 'reportPayload', 'btnReport', 'reportStatus']) assert.ok(html.includes(`id="${id}"`), id);
});

test('the report names this wallet, and the phrase check happens in the worker', () => {
  const popup = read('popup/popup.js');
  assert.match(popup, /wallet: 'ambra-browser', version: chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(popup, /rpc\('reportCheck', \{ report: r \}\)/);
  assert.ok(!/sessionMnemonic|revealMnemonic.*report/.test(popup.slice(popup.indexOf('Report a problem (vendor'))), 'the popup never asks for the phrase');
  const bg = read('background.js');
  assert.match(bg, /'reportCheck': async \(\{ report \}\) => \(\{ refusal: reportRefusal\(report \|\| \{\}, await sessionMnemonic\(\)\) \}\)/);
  const r = buildReport({ wallet: 'ambra-browser', version: '0', mode: 'default', description: 'my words are abandon ability able' });
  assert.equal(refusal(r, 'abandon ability able about above absent absorb abstract absurd abuse access accident'), REPORT_WORDS.phrase);
});
