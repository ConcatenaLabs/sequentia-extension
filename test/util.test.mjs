import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtAtoms, parseAtoms, looksLikeBolt11, hexToBytes, bytesToHex, lnInvoiceKind } from '../src/util.js';

test('fmtAtoms / parseAtoms round-trip', () => {
  assert.equal(fmtAtoms(150000000n, 8), '1.5');
  assert.equal(fmtAtoms(0n, 8), '0');
  assert.equal(fmtAtoms(-2n, 0), '-2');
  assert.equal(parseAtoms('1.5', 8), 150000000n);
  assert.equal(parseAtoms('0.00000001', 8), 1n);
  assert.equal(parseAtoms('42', 0), 42n);
  for (const s of ['1.23', '0.5', '1000', '0.00000001']) {
    assert.equal(fmtAtoms(parseAtoms(s, 8), 8), s);
  }
});

test('parseAtoms rejects bad input', () => {
  assert.throws(() => parseAtoms('abc', 8));
  assert.throws(() => parseAtoms('-1', 8));
  assert.throws(() => parseAtoms('1.234', 2), /max 2 decimals/);
  assert.throws(() => parseAtoms('', 8));
});

test('looksLikeBolt11', () => {
  assert.ok(looksLikeBolt11('lntb1u1p0xyzabc'));
  assert.ok(looksLikeBolt11('lnbc10n1pxxxxxx'));
  assert.ok(!looksLikeBolt11('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'));
  assert.ok(!looksLikeBolt11(''));
});

test('hex round-trip', () => {
  const b = hexToBytes('00ff10');
  assert.deepEqual([...b], [0, 255, 16]);
  assert.equal(bytesToHex(b), '00ff10');
  assert.throws(() => hexToBytes('abc'));
});

test('lnInvoiceKind: the node an invoice is paid from', () => {
  // An invoice SeqLN made on sequentia-regtest, in the asset d024…efdb.
  const seq = 'lnsqrt2500u1p4vw55msp5ff8xy2dtczxuhsjctsn57f7f496jkz434hkp9jkq89rgem6zwnxspp53xx98drfa537svcqkhhhtl8tee729wsn20z86s32mmml9mdtgz3qdq2wejkxar0wgap56qj03x5pr8vyane3lj4us77ffc4h67txh3raldmtvgm7whedaldsxqyjw5qcqz959qxpqysgqhe48tu4zx3q0c0v0wfj23zndyyhw5m09npxgjs3v7etjm0kh3lhrxmj4ny0hkhsrw5xcd2jf76dacmfsshqykdcvyy4y37klh3x023cp8756dq';
  assert.deepEqual(lnInvoiceKind(seq), { kind: 'd024f89a8119d84ecf31fcabc87bc94e2b7d7966bc47dfb76b6237e75f2defdb' });
  assert.ok(looksLikeBolt11(seq));
  // BOLT 11's example on Bitcoin.
  const btc = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
  assert.deepEqual(lnInvoiceKind(btc), { kind: 'BTC' });
  // A Sequentia invoice made before invoices named their asset: refused, as the node refuses it.
  const old = 'lnsqrt300m1p4vqc54sp55mylrq4dfn3cjs7zxjg0urxrpxxnzxhkdx7rdwefsf2m57elkk9qpp5z63d3a3qx6qs73qvuth2pvmz9khh3jy6um87fy9hueuxse8mlw8sdq9da6hgxqyjw5qcqz959qxpqysgqhk7a8uc3wl6vu0mgxc4d59q0y3qkfjpxqe3t06w5ks5caha8xsp8rrt3fqvj7favpmpge79amfserdywnsy8g3jkqe43a7jjx7wj6esq387l4s';
  assert.match(lnInvoiceKind(old).error, /a: missing/);
  assert.match(lnInvoiceKind(seq.slice(0, -1)).error, /checksum/);
});
