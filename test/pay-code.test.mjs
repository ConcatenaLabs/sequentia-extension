// pay-code.js: the one receive code, written and read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPayCode, readPayCode, compactRequest, expandRequest, readShortRequest, libraryRequest, bech32mEncode, bech32mDecode, lnurlEncode, lnurlDecode, nameLnurlUrl, RECORD_FORMATS } from '../vendor/pay-code.js'

const TB1 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
// Bark's testnet ark address, as the Bitcoin ark gives one (131 characters, bech32m).
const ARK = bech32mEncode('tark', Array.from({ length: 76 }, (_, i) => (i * 7) & 255))
const hexOf = (s) => Buffer.from(s, 'utf8').toString('hex')
const h = (c, n) => c.repeat(2 * n)
const INFO = { operator: 'ab'.repeat(32), genesis_hash: 'cd'.repeat(32) }
// A receive request as the leaf library spells it (`receive` in bark/src/arca/pay.rs).
const REQ = { kind: 'request', genesis_hash: INFO.genesis_hash, operator: INFO.operator, owner: h('1', 32),
  owner_nonce: h('2', 32), mailbox: h('3', 32), exit_delay_units: 4096, until: 1793350000, landing: h('4', 20), template: 'vtxo-2' }
const LIB = 'arca:' + hexOf(JSON.stringify(REQ))

test('bech32m: what is written is read back; a changed character is not', () => {
  const s = bech32mEncode('sqr', [0, 1, 2, 255, 128])
  assert.deepEqual(Array.from(bech32mDecode(s).bytes), [0, 1, 2, 255, 128])
  assert.deepEqual(Array.from(bech32mDecode(s.toUpperCase()).bytes), [0, 1, 2, 255, 128])
  const bad = s.slice(0, -1) + (s.endsWith('q') ? 'p' : 'q')
  assert.equal(bech32mDecode(bad), null)
  // BIP350's own test vector.
  assert.ok(bech32mDecode('a1lqfn3a'))
})

test('the receive request goes short, and the payer on its operator gets the library\'s request back', () => {
  const short = compactRequest(LIB)
  assert.match(short, /^sqr1[02-9ac-hj-np-z]+$/)
  assert.ok(short.length < 240, `short form ${short.length} chars`)
  assert.ok(LIB.length > 2.5 * short.length, `library ${LIB.length} vs short ${short.length}`)
  const back = expandRequest(short, INFO)
  assert.deepEqual(libraryRequest(back), REQ)
  // Upper case, as the picture holds it, is the same request.
  assert.deepEqual(libraryRequest(expandRequest(short.toUpperCase(), INFO)), REQ)
})

test('a short request is never paid on another operator or chain', () => {
  const short = compactRequest(LIB)
  assert.equal(expandRequest(short, { ...INFO, operator: 'ef'.repeat(32) }), null)
  assert.equal(expandRequest(short, { ...INFO, genesis_hash: '00'.repeat(32) }), null)
  assert.equal(expandRequest(short, null), null)
  // The library's own spelling is checked the same way.
  assert.equal(expandRequest(LIB, INFO), LIB)
  assert.equal(expandRequest(LIB, { ...INFO, operator: 'ef'.repeat(32) }), null)
})

test('every optional field travels: asset, value, channels; a request with anything else stays as it is', () => {
  const full = { ...REQ, asset: h('5', 32), value: '18446744073709551615', channels: { [h('6', 32)]: h('7', 32), [h('8', 32)]: h('9', 32) } }
  const s = compactRequest('arca:' + hexOf(JSON.stringify(full)))
  assert.deepEqual(libraryRequest(expandRequest(s, INFO)), full)
  const plain = { ...REQ }; delete plain.landing; delete plain.template
  assert.deepEqual(libraryRequest(expandRequest(compactRequest('arca:' + hexOf(JSON.stringify(plain))), INFO)), plain)
  assert.equal(compactRequest('arca:' + hexOf(JSON.stringify({ ...REQ, something_new: 1 }))), null)
  assert.equal(compactRequest('arca:' + hexOf(JSON.stringify({ ...REQ, until: undefined }))), null)
  assert.equal(compactRequest('arca:' + hexOf(JSON.stringify({ ...REQ, channels: { [h('6', 32)]: '12:0' } }))), null)
  // A short form cut or padded is not read.
  const d = bech32mDecode(compactRequest(LIB))
  assert.equal(readShortRequest(bech32mEncode('sqr', Array.from(d.bytes).slice(0, -1))), null)
  assert.equal(readShortRequest(bech32mEncode('sqr', [...d.bytes, 0])), null)
  assert.equal(readShortRequest(bech32mEncode('xyz', Array.from(d.bytes))), null)
})

// The library writes `reads` in every request: the record formats it takes coins in
// (arca covenant/src/batch.rs RECORD_FORMATS), which a payer must see.
const LIVE_READS = ['leaf-2', 'leaf-3', 'accumulator-1', 'accumulator-4', 'coin-2', 'landing-2']

test('reads travels in the short form: the library\'s list in two bytes, and back exactly', () => {
  assert.deepEqual([...RECORD_FORMATS], LIVE_READS)
  const req = { ...REQ, reads: LIVE_READS }
  const lib = 'arca:' + hexOf(JSON.stringify(req))
  const short = compactRequest(lib)
  assert.ok(short, 'a request with reads goes short')
  assert.deepEqual(libraryRequest(expandRequest(short, INFO)), req)
  assert.equal(bech32mDecode(short).bytes.length - bech32mDecode(compactRequest(LIB)).bytes.length, 3, 'two bytes of mask, one count')
  // A shorter list, a list with a name the table does not hold, and an empty one, each back as written.
  for (const reads of [['leaf-2', 'coin-2'], [...LIVE_READS, 'coin-9'], ['coin-9'], []]) {
    const r = { ...REQ, reads }
    assert.deepEqual(libraryRequest(expandRequest(compactRequest('arca:' + hexOf(JSON.stringify(r))), INFO)), r, JSON.stringify(reads))
  }
  // A list the short form could not give back as written stays in the library's spelling.
  for (const reads of [['coin-2', 'leaf-2'], ['leaf-2', 'leaf-2'], ['coin-9', 'leaf-2'], ['Leaf 2'], 'leaf-2', [7]]) {
    assert.equal(compactRequest('arca:' + hexOf(JSON.stringify({ ...REQ, reads }))), null, JSON.stringify(reads))
  }
  // A mask naming a bit past the table is not read.
  const d = Array.from(bech32mDecode(short).bytes)
  d[d.length - 3] |= 0x80
  assert.equal(readShortRequest(bech32mEncode('sqr', d)), null)
})

// A receive request exactly as the live leaf library made it (the testnet's operator and chain, the
// page's leaves/pkg), read back from a wallet's kept code.
const LIVE = 'request:7b22657869745f64656c61795f756e697473223a3235342c2267656e657369735f68617368223a2264646431316435346338376132626439343430306664333163653035643865313131306262346237386537313033663733383334323038366663346561393265222c226b696e64223a2272657175657374222c226c616e64696e67223a2236313039643437353038663732613036613162303533303561303637326339653430383530663332222c226d61696c626f78223a2230353966656533663030383630393164376439623562393138383539613331383130626132353466363661366662353061353865636138623438656630643234222c226f70657261746f72223a2262366634633539323461643831393437363538636638356262393364393236376566633534633766636232653435373765386339353463363866613038376262222c226f776e6572223a2230356139613531613236653363303463363035393231353339393362383664343231386438386566343566386361376639613139633132306630383031316634222c226f776e65725f6e6f6e6365223a2234343938353938326433313135623661313063366234313265373835393865633966623332623232653962316564313933633161656536303738393164316134222c227265616473223a5b226c6561662d32222c226c6561662d33222c22616363756d756c61746f722d31222c22616363756d756c61746f722d34222c22636f696e2d32222c226c616e64696e672d32225d2c22756e74696c223a313739373139353238327d'

test('the live library\'s request goes short, under 300 characters, and comes back exactly', () => {
  const r = libraryRequest(LIVE)
  assert.deepEqual(r.reads, LIVE_READS)
  const short = compactRequest(LIVE)
  assert.ok(short, 'the live request has nothing the short form leaves out')
  assert.ok(short.length < 300, `short form ${short.length} chars`)
  assert.ok(LIVE.length > 4 * short.length, `library ${LIVE.length} vs short ${short.length}`)
  assert.deepEqual(libraryRequest(expandRequest(short, { operator: r.operator, genesis_hash: r.genesis_hash })), r)
  const code = buildPayCode({ address: TB1, ark: ARK, sequentia: LIVE })
  assert.match(code, /&sequentia=SQR1[0-9A-Z]+$/)
})

test('the code is upper case wherever a QR code can hold it so; read back in lower case', () => {
  const code = buildPayCode({ address: TB1, ark: ARK, sequentia: LIB })
  const short = compactRequest(LIB)
  assert.equal(code, `BITCOIN:${TB1.toUpperCase()}?ark=${ARK.toUpperCase()}&sequentia=${short.toUpperCase()}`)
  const r = readPayCode(code)
  assert.equal(r.address, TB1); assert.equal(r.ark, ARK); assert.equal(r.sequentia, short)
  assert.deepEqual(libraryRequest(expandRequest(r.sequentia, INFO)), REQ)
  assert.deepEqual(r.other, {})
  // Everything outside the separators is QR alphanumeric (0-9 A-Z $%*+-./: and space).
  for (const part of code.split(/[?&=]/)) assert.match(part, /^[0-9A-Z $%*+\-./:a-z]*$/)
  assert.ok(code.length < 450, `code ${code.length} chars`)
})

test('a code made before the short form is still read and paid', () => {
  const old = `bitcoin:${TB1}?ark=${ARK}&sequentia=${LIB}`
  const r = readPayCode(old)
  assert.equal(r.address, TB1); assert.equal(r.ark, ARK); assert.equal(r.sequentia, LIB)
  assert.equal(expandRequest(r.sequentia, INFO), LIB)
})

test('an invoice is upper case in the code and lower case read back', () => {
  const inv = 'lntb20u1pjexample' // not a real invoice: kept as it is
  assert.match(buildPayCode({ address: TB1, lightning: inv }), /lightning=lntb20u1pjexample/)
  const real = bech32mEncode('lntb', [1, 2, 3]) // any checksummed bech32 part is upper-cased
  assert.match(buildPayCode({ address: TB1, lightning: real }), new RegExp('lightning=' + real.toUpperCase()))
  assert.equal(readPayCode(buildPayCode({ address: TB1, lightning: real })).lightning, real)
})

test('a plain address is a plain bitcoin: request', () => {
  assert.equal(buildPayCode({ address: TB1 }), 'BITCOIN:' + TB1.toUpperCase())
  assert.equal(readPayCode('bitcoin:' + TB1).address, TB1)
  assert.equal(readPayCode('BITCOIN:' + TB1.toUpperCase()).address, TB1)
  // A base58 address is never changed in case.
  assert.equal(buildPayCode({ address: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn' }), 'BITCOIN:mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')
})

test('values that need it are escaped and read back whole', () => {
  const code = buildPayCode({ address: TB1, label: 'Ana & Bo', message: 'rent 50%', sequentia: 'x:y z' })
  assert.match(code, /label=Ana%20%26%20Bo/)
  assert.match(code, /message=rent%2050%25/)
  const r = readPayCode(code)
  assert.equal(r.label, 'Ana & Bo'); assert.equal(r.message, 'rent 50%'); assert.equal(r.sequentia, 'x:y z')
})

test('other parameters are kept; an unknown required one is refused', () => {
  const r = readPayCode(`bitcoin:${TB1}?pj=https://x.test/pj&amount=0.001`)
  assert.equal(r.amount, '0.001'); assert.deepEqual(r.other, { pj: 'https://x.test/pj' })
  assert.throws(() => readPayCode(`bitcoin:${TB1}?req-pj=https://x.test/pj`), /cannot do \(pj\)/)
  // A known one marked required is honoured.
  assert.equal(readPayCode(`bitcoin:${TB1}?req-ark=${ARK}`).ark, ARK)
})

test('what is not a request, or names nothing to pay, is not read', () => {
  assert.equal(readPayCode(TB1), null)
  assert.equal(readPayCode(LIB), null)
  assert.equal(readPayCode(''), null)
  assert.throws(() => readPayCode('bitcoin:?label=x'), /no way to pay/)
  assert.throws(() => readPayCode(`bitcoin:${TB1}?ark=a&ark=b`), /twice/)
  assert.throws(() => buildPayCode({ ark: ARK }), /address/)
})

test('an address-less request with an ark address is read (BIP321 allows an empty path)', () => {
  const r = readPayCode('bitcoin:?ark=' + ARK)
  assert.equal(r.address, null); assert.equal(r.ark, ARK)
})

// LUD-01's own example.
const LUD01_URL = 'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df'
const LUD01 = 'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS'

test('LNURL: LUD-01\'s example is read and written back; anything else is not an LNURL', () => {
  assert.equal(lnurlDecode(LUD01), LUD01_URL)
  assert.equal(lnurlDecode('lightning:' + LUD01.toLowerCase()), LUD01_URL)
  assert.equal(lnurlEncode(LUD01_URL).toUpperCase(), LUD01)
  assert.equal(lnurlDecode(LUD01.slice(0, -1) + 'Q'), null)
  assert.equal(lnurlDecode(ARK), null)
  assert.equal(lnurlDecode('lntb10u1pjexample'), null)
  assert.equal(nameLnurlUrl('Alice', 'SequentiaTestnet.com'), 'https://sequentiatestnet.com/.well-known/lnurlp/alice')
})

test('a code without an amount carries the payment name\'s LNURL-pay; readers hand it on apart from any invoice', () => {
  const url = nameLnurlUrl('alice', 'sequentiatestnet.com')
  const code = buildPayCode({ address: TB1, ark: ARK, sequentia: LIB, lnurl: url })
  const lightning = /[?&]lightning=([^&]*)/.exec(code)[1]
  assert.match(lightning, /^LNURL1[0-9A-Z]+$/, 'upper case: the QR code holds it as alphanumeric')
  assert.equal(lnurlDecode(lightning), url)
  const c = readPayCode(code)
  assert.equal(c.lnurl, url)
  assert.equal(c.lightning, null, 'never taken for an invoice')
  assert.equal(c.address, TB1); assert.equal(c.ark, ARK); assert.ok(c.sequentia)
  // An invoice, when the code has one, is the code's `lightning`; the LNURL is not added beside it.
  const inv = 'lntb210u1pjexampleinvoice'
  const withInv = buildPayCode({ address: TB1, lightning: inv, lnurl: url })
  assert.equal((withInv.match(/lightning=/g) || []).length, 1)
  assert.equal(readPayCode(withInv).lnurl, null)
  // A code that holds nothing but the name's LNURL still names a way to pay.
  assert.equal(readPayCode('bitcoin:?lightning=' + lnurlEncode(url)).lnurl, url)
  // Its size: about 140 characters more than the code without it, all alphanumeric.
  const plain = buildPayCode({ address: TB1, ark: ARK, sequentia: LIB })
  assert.ok(code.length - plain.length < 160, `${code.length - plain.length} more characters`)
})
