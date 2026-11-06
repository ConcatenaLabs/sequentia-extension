// Receive in default mode (the web wallet's docs/DEFAULT_MODE.md, Receive): New code, the
// Confidential switch, an amount in an asset, and the payment name. The rules themselves are the
// vendored modules' (receive-index.js, pay-code.js, lnaddr.js), tested in the web wallet; this checks
// that the extension takes them, and test/default/receive-drive.mjs runs them on the live testnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextReceiveIndex, shownReceiveIndex } from '../vendor/receive-index.js';
import { buildPayCode, readPayCode, nameLnurlUrl } from '../vendor/pay-code.js';
import { DEFAULT_WORDS } from '../vendor/default-arca.js';
import { NAME_WORDS } from '../vendor/lnaddr.js';
import { forbiddenIn } from '../vendor/user-trade.js';
import { LNADDR_DOMAIN } from '../src/config.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('New code and New address move by the shared rule; the kept index stays within the window', () => {
  const engine = read('src/engine.js');
  assert.match(engine, /export function newAddress\(confidential = false\) \{\n[^\n]*\n  addrIndex = nextReceiveIndex\(addrIndex, unifiedNextUnused\(\)\);/);
  assert.match(engine, /addrIndex = shownReceiveIndex\(addrIndex, unifiedNextUnused\(\)\);/, 'after a sync');
  assert.match(engine, /addrIndex = shownReceiveIndex\(s\.index, unifiedNextUnused\(\)\);/, 'the index kept from before');
  assert.equal(nextReceiveIndex(19, 0), 0);
  assert.equal(shownReceiveIndex(25, 3), 3);
  // New code asks a new address of the engine.
  assert.match(read('src/default-mode.js'), /const address = \(fresh \? engine\.newAddress\(false\) : engine\.currentAddress\(false\)\)\.address;/);
});

test('Confidential: the confidential address alone, before any other part is asked', () => {
  const dm = read('src/default-mode.js');
  const i = dm.indexOf('export async function receiveCode(');
  const body = dm.slice(i, dm.indexOf('\n}\n', i));
  const conf = body.indexOf('if (confidential) {');
  assert.ok(conf > 0 && conf < body.indexOf('leafCode(') && conf < body.indexOf("arkHost('invoice'"));
  assert.match(body, /const c = engine\.currentAddress\(true\)\.address;\n    return \{ code: c, qr: qr\(c\), isCode: true, confidential: true \};/);
  // Off whenever Receive is left; the words are the contract's.
  const pop = read('popup/popup.js');
  assert.match(pop, /function tab\(name\) \{\n[^\n]*\n  if \(name !== 'receive'\) \{ recvConf0 = false; recvFull = false; \}/);
  for (const w of [DEFAULT_WORDS.confidential, DEFAULT_WORDS.confidentialTip, DEFAULT_WORDS.confidentialNote, DEFAULT_WORDS.receiveTipConf]) assert.deepEqual(forbiddenIn(w), [], w);
  assert.match(DEFAULT_WORDS.confidentialNote, /BTC is never confidential/);
});

test('without an amount the picture is the name; the full code carries its LNURL-pay; with an amount, the invoice', () => {
  const dm = read('src/default-mode.js');
  assert.match(dm, /if \(named && !full\) \{\n    const text = nameQrText\(nm\.address\);\n    return \{ code: text, shown: nm\.display \|\| text, qr: qr\(text\), isCode: true, isName: true, named: true \};/);
  assert.match(dm, /if \(n === 0n\) \{ try \{ nm = await nameState\(\); \} catch \{ nm = null; \} \}/, 'only without an amount');
  assert.ok(dm.indexOf('if (named && !full)') > dm.indexOf('if (confidential) {'), 'Confidential gives its own address first');
  assert.match(dm, /if \(n === 0n && named\) lnurl = nameLnurlUrl\(nm\.name, LNADDR_DOMAIN\);/);
  assert.match(dm, /leaves\.runUser\('lightning_receive', \{ asset: kind, amount: String\(n\), description: 'Receive' \}\)/);
  const code = buildPayCode({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', lnurl: nameLnurlUrl('alice', LNADDR_DOMAIN) });
  const c = readPayCode(code);
  assert.equal(c.lnurl, 'https://sequentiatestnet.com/.well-known/lnurlp/alice');
  assert.equal(c.lightning, null, 'Send never takes it for an invoice');
});

test('the payment name: its link in the offscreen document, its code from the service worker, Send pays a name', () => {
  const ark = read('offscreen-ark.js');
  assert.match(ark, /mountLnAddress\(\{\n    base: LSP\.url, domain: LNADDR_DOMAIN,/);
  assert.match(ark, /case 'name': return await name\(args\);/);
  assert.match(ark, /sw\('default\.nameCode', \{ index \}\)/);
  assert.match(ark, /if \(!A\.idx\) return null;/, 'no stock code before the indices are known');
  assert.match(read('src/default-mode.js'), /if \(!\(await leafOpen\(\)\)\) return null;\n  const address = engine\.addressAt\(index\);/);
  const bg = read('background.js');
  for (const m of ['default.name', 'default.nameRegister', 'default.nameRelease', 'default.nameCode', 'default.receiveChoices', 'default.assetInvoiceState']) assert.ok(bg.includes(`'${m}': async`), m);
  assert.ok(bg.includes("'default.nameIndices': async"));
  assert.match(bg, /const PASSIVE_UI = new Set\(\['default\.nameCode', 'default\.nameIndices',/, "a payer's request is not a person using the wallet");
  assert.match(read('src/default-mode.js'), /if \(parseLnAddress\(text\)\) \{[\s\S]*?resolveLnAddress\(\{ text, asset, msat, domain: LNADDR_DOMAIN, base: LSP\.url, decode: \(x\) => decodeBolt11\(x\), pins: await namePins\(\) \}\)/);
  for (const k of ['label', 'tip', 'none', 'choose', 'save', 'cancel', 'copy', 'remove']) assert.deepEqual(forbiddenIn(NAME_WORDS[k]), [], k);
  assert.match(read('popup/popup.html'), /placeholder="a receive code, a payment name, an address or an invoice"/);
});
