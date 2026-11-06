// Word names in the extension: the vendored rule (vendor/word-name.js, tested in the web wallet),
// the offscreen link's 'words' operation, and the popup's Get a name, Choose your own and Use a
// word name instead, in the web wallet's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAME_WORDS, nameKey, wordNameCandidates, displayName, nameProblem } from '../vendor/lnaddr.js';
import { forbiddenIn } from '../vendor/user-trade.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('a word name comes from the name key, lower case to read, a capital per word to show', () => {
  const k = nameKey(PHRASE);
  const c = wordNameCandidates(k.pub);
  assert.ok(c.length > 1);
  assert.equal(nameProblem(c[0].name), null, 'a valid name');
  assert.equal(c[0].name, c[0].name.toLowerCase());
  const shown = displayName(c[0].name, k.pub);
  assert.equal(shown.toLowerCase(), c[0].name);
  assert.notEqual(shown, c[0].name, 'shown with capitals');
  assert.deepEqual(wordNameCandidates(nameKey(PHRASE).pub), c, 'the same after a restore');
  for (const w of ['getName', 'getting', 'useWords', 'noWordName', 'none', 'choose']) assert.deepEqual(forbiddenIn(NAME_WORDS[w]), [], w);
});

test('Get a name and Use a word name instead take the word name through the offscreen link', () => {
  assert.match(read('offscreen-ark.js'), /else if \(op === 'words'\) await A\.name\.claimWordName\(\);/);
  assert.match(read('offscreen-ark.js'), /display: A\.name\.display\(\), isWordName: A\.name\.isWordName\(\)/);
  assert.ok(read('background.js').includes("'default.nameWords': async () => await dm.nameWords(),"));
  const html = read('popup/popup.html');
  assert.match(html, /<button id="btnNameGet" class="primary tiny">Get a name<\/button>/);
  assert.match(html, /<button id="btnNameChoose" class="quiet">Choose your own<\/button>/);
  assert.match(html, /<button id="btnNameWords" class="quiet hide">Use a word name instead<\/button>/);
  const pop = read('popup/popup.js');
  assert.match(pop, /\$\('btnNameGet'\)\.onclick = \(\) => getWordName\(\$\('btnNameGet'\)\);/);
  assert.match(pop, /vis\('btnNameWords', !!nameNow && !nameEditing && !st\.isWordName\)/);
  // Shown with capitals; the QR code and Copy keep the lower case.
  assert.match(pop, /\$\('recvDCode'\)\.textContent = r\.shown \|\| r\.code;/);
  assert.match(read('src/default-mode.js'), /return \{ code: text, shown: nm\.display \|\| text, qr: qr\(text\)/);
  assert.match(read('NOTICE'), /EFF short\nwordlist 1[\s\S]*Creative Commons Attribution 3\.0 United States/);
});
