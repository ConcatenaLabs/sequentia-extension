import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSigningRequest } from '../src/tagpolicy.js';

const hex32 = 'a'.repeat(64);
const ctl = (n) => String.fromCharCode(n);

test('a tagged statement is encoded as its UTF-8 bytes', () => {
  const r = checkSigningRequest({ tag: 'openamp-challenge-v1', statement: 'hello' });
  assert.equal(r.kind, 'statement');
  assert.equal(r.tag, 'openamp-challenge-v1');
  assert.equal(r.messageHex, '68656c6c6f');
});

test('a document hash is signed as its raw bytes', () => {
  const r = checkSigningRequest({ tag: 'openamp-document-v1', hash: hex32.toUpperCase() });
  assert.equal(r.kind, 'hash');
  assert.equal(r.messageHex, hex32);
});

test('non-ASCII statements survive as UTF-8', () => {
  const r = checkSigningRequest({ tag: 'seqpal-ubo-v1', statement: 'Avila' + ctl(233) });
  assert.equal(Buffer.from(r.messageHex, 'hex').toString('utf8'), 'Avila' + ctl(233));
});

// The whole safety argument: the wallet must never be steerable at a digest
// some consensus rule also computes.
for (const tag of ['TapSighash', 'tapsighash', 'TapLeaf', 'TapTweak', 'BIP0340/challenge',
                   'bip340-nonce', 'ElementsSighash', 'my-sighash-v1']) {
  test(`refuses the reserved tag ${tag}`, () => {
    assert.throws(() => checkSigningRequest({ tag, hash: hex32 }), /reserved tag/);
  });
}

test('refuses an empty or oversized tag', () => {
  assert.throws(() => checkSigningRequest({ tag: '', statement: 'x' }), /1-64 printable/);
  assert.throws(() => checkSigningRequest({ tag: 'a'.repeat(65), statement: 'x' }), /1-64 printable/);
});

test('refuses a tag with spaces or non-printable characters', () => {
  assert.throws(() => checkSigningRequest({ tag: 'my tag', statement: 'x' }), /1-64 printable/);
  assert.throws(() => checkSigningRequest({ tag: 'my' + ctl(9) + 'tag', statement: 'x' }), /1-64 printable/);
});

test('refuses both or neither of statement and hash', () => {
  assert.throws(() => checkSigningRequest({ tag: 'ok-v1' }), /exactly one/);
  assert.throws(() => checkSigningRequest({ tag: 'ok-v1', statement: 'x', hash: hex32 }), /exactly one/);
});

test('refuses a hash that is not 32 bytes', () => {
  assert.throws(() => checkSigningRequest({ tag: 'ok-v1', hash: 'ab' }), /32-byte hex/);
  assert.throws(() => checkSigningRequest({ tag: 'ok-v1', hash: 'z'.repeat(64) }), /32-byte hex/);
});

// A statement the approval window cannot render is a statement the user cannot
// read, and reading it is their only defence against signing something that
// means more than they thought.
test('refuses a statement carrying control characters', () => {
  assert.throws(() => checkSigningRequest({ tag: 'ok-v1', statement: 'pay me ' + ctl(7) + 'hidden' }), /readable text/);
  assert.throws(() => checkSigningRequest({ tag: 'ok-v1', statement: 'ab' + ctl(0) }), /readable text/);
});

test('allows the whitespace that formats a statement', () => {
  const r = checkSigningRequest({ tag: 'ok-v1', statement: 'line one' + ctl(10) + 'line two' + ctl(9) + 'tabbed' });
  assert.equal(r.kind, 'statement');
});

test('refuses an empty or oversized statement', () => {
  assert.throws(() => checkSigningRequest({ tag: 'ok-v1', statement: '' }), /exactly one|1-4096/);
  assert.throws(() => checkSigningRequest({ tag: 'ok-v1', statement: 'x'.repeat(4097) }), /1-4096/);
});

// The node's own tags are consensus instructions, not statements, and are only
// ever produced by the method that decodes and displays what it is signing.
for (const tag of ['Sequentia/SupervisionRecord', 'sequentia/SupervisionUnfreeze', 'Sequentia/Anything']) {
  test(`refuses the node tag ${tag}`, () => {
    assert.throws(() => checkSigningRequest({ tag, hash: hex32 }), /reserved tag/);
  });
}

test('an ordinary application tag mentioning sequentia is still fine', () => {
  const r = checkSigningRequest({ tag: 'sequentia-app-v1', statement: 'hello' });
  assert.equal(r.kind, 'statement');
});

// The policy server's own authorisations are never a site's to ask for:
// one "sign this hash" approval would otherwise hand a site the holder's
// request for a co-sign of a trade it let expire.
for (const tag of ['openamp-cosign-v1', 'openamp-dvp-v1', 'OpenAMP-Cosign-v1', 'openamp-rotation-v1', 'openamp-next-v2']) {
  test(`refuses the OpenAMP protocol tag ${tag}`, () => {
    assert.throws(() => checkSigningRequest({ tag, hash: hex32 }), /OpenAMP protocol tag/);
  });
}
test('a site still has the challenge and document tags', () => {
  assert.equal(checkSigningRequest({ tag: 'openamp-challenge-v1', statement: 'x' }).kind, 'statement');
  assert.equal(checkSigningRequest({ tag: 'openamp-document-v1', hash: hex32 }).kind, 'hash');
});
