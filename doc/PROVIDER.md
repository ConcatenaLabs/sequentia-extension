# The Sequentia website provider protocol

The extension injects `window.sequentia` into every page. Websites (for
example the SeqDEX site at https://sequentiatestnet.com/dex/) use it to
connect to the user's wallet, read balances, and request signatures. There is
no other wallet-to-site channel: sites never see the mnemonic, never sign
anything themselves, and every sensitive operation opens an approval window
the user must confirm.

This document is the contract between the extension
(`src/provider-router.js`) and site authors. Keep the two in sync.

## Detection

```js
if (window.sequentia?.isSequentia) { /* wallet available */ }
window.addEventListener('sequentia#initialized', () => { /* injected late */ });
```

## Calling convention

Every call goes through `request`:

```js
const result = await window.sequentia.request({ method, params });
```

Errors reject with an `Error` whose `message` explains the failure (`'the user
rejected the request'`, `'the wallet is locked'`, `'this site is not
connected; call connect first'`, …).

All amounts are **strings of atoms** (the asset's smallest unit; BigInt does
not survive JSON). Asset identifiers are 64-hex Sequentia asset ids, the
literal `'BTC'` for parent-chain Bitcoin, or `'oamp:<assetId>'` for OpenAMP
restricted assets.

## Connection model

- `connect` prompts the user once per origin; the grant persists until revoked
  in the wallet's Settings tab.
- Read methods (`getBalances`, `getAddress`) require the origin to be
  connected AND the wallet unlocked; they never prompt.
- Signing / paying methods additionally open an approval window per request.
- If the wallet is locked when a prompt-worthy request arrives, the approval
  window doubles as an unlock screen.

## Methods

### `getCapabilities()` — silent
Returns provider metadata; safe to call before connecting.
```js
{ provider: 'sequentia-wallet-extension', version, network: 'sequentia-testnet',
  methods: [...], events: ['accountsChanged', 'disconnect'] }
```

### `getNetwork()` — silent
`{ network: 'sequentia-testnet' }`

### `connect()` — prompts once per origin
```js
{ network: 'sequentia-testnet',
  address: 'tb1…',        // the shared dual-chain address: receives Sequentia assets AND parent-chain BTC
  openampAid: '…' | null } // the wallet's OpenAMP account id, if registered
```

### `getAccounts()` — silent
Same account object inside `{ accounts: [...] }`, or `{ accounts: [] }` when
not connected or locked. Use it to restore a session without prompting.

### `getBalances()` — silent, requires connection
```js
{ assets: { '<assetHexId>': '<atoms>' },   // Sequentia on-chain, tSEQ included under its id
  btc: '<sats>',                           // parent-chain Bitcoin testnet4
  openamp: { 'oamp:<id>': '<atoms>' } }    // restricted assets
```

### `getAddress({ confidential? })` — silent, requires connection
`{ address, index }`. Default is the standard `tb1…` form (identical on both
chains); `confidential: true` returns the opt-in blinded `tsqb1…` form.

### `signPset({ pset })` — approval per request
`pset` is a base64 PSET (Elements partially signed transaction). The wallet
shows the transaction's effect on the user's balances, signs the inputs it
owns, and returns `{ pset }` — signed but **not** finalized or broadcast, so a
DEX can compose partial signatures (resting orders, swaps). Per-input sighash
flags embedded in the PSET are honored, which is what makes signed resting
orders (SINGLE|ANYONECANPAY-style intents) possible.

A site builds a PSET knowing which outputs it spends but not which of them
belong to this wallet: it has no xpub and no derivation paths. The wallet fills
its own key origins in before signing and takes them back out afterwards, so
the PSET a site sends needs nothing beyond `PSBT_IN_WITNESS_UTXO` per input.
An input the site pre-witnessed (a covenant spend, which needs no signature) is
left exactly as it arrived. `getCapabilities().features` carries
`pset-site-built` on builds that do this; a site that must know can check for
it. When none of the inputs belong to this wallet the call fails with "this
wallet holds none of the inputs in that transaction".

A fully transparent PSET — what a covenant settlement looks like — is described
from its bytes, since the wallet's own decoder handles blinded transactions
only. The approval window shows the same "You send / You receive" lines either
way.

### `signContractSpend({ templateHash | descriptor+sources, instance, drip | request, broadcast? })` — approval per request
A spend of a contract written with
[`sequentia-contracts`](https://github.com/ConcatenaLabs/sequentia-contracts),
signed by this wallet's contract key (`m/8383h/1h/0h/0/0`) under the five-point
rule. The kit's contract engine (SWK `lwk_contracts`) does every step; the
wallet signs only when all five hold:

1. the template is on the wallet's list, which is the templates the kit carries
   (`sequentia/one-key`, `sequentia/one-key-exit`, `sequentia/faucet-drip`); a
   site can pass a template it wrote (`descriptor` and `sources`, each source
   with its includes resolved), which is read and checked but never signed for;
2. the engine recomputed the output from the template and the instance, and the
   coin pays it;
3. the engine ran the program against the final transaction;
4. the approval window showed the template (by the registry's name, which the
   wallet looks up itself, else its commitment root), the path, every
   parameter by role, the wallet's balance change in every asset, where the
   coins go, and the checks;
5. the key is a contract key, the one the path names.

Parameters:

- `templateHash`: a template the kit carries; or `descriptor` (the
  descriptor JSON) and `sources` (`{"<name>.simf": "<text>"}`).
- `instance`: the instance record, `{instance, template_hash, params, slots,
  genesis}`.
- `drip`: for the faucet drip covenant, `{coin, amount, to?, ratePerKvb?}`:
  the reserve coin (`{txid, vout, script_pubkey, asset, amount}`, asset in
  display hex), the atoms to drip, the address paid (this wallet's by
  default), and the fee rate in atoms of the dripped asset per 1,000 vB
  (1,000 by default). The wallet plans the drip at its real size.
- `request`: for any other spend, the engine's request: `{path, coin,
  sequence?, lock_time?, outputs: [{to, address | script, asset, amount}],
  spender?, next_slots?}`. Each output says what it does: `contract` (back to
  the contract, or to its next state), `wallet`, `pay`, or `fee`.
- `broadcast`: `false` returns the signed transaction without broadcasting it.

Returns `{ txid, hex }` (or `{ hex }`). A spend the engine refuses is refused
to the site, with the engine's reason, before any window opens: an output that
does not do what the request says, a confidential output, outputs that do not
balance the coin, a relative lock or lock time the chain would refuse now, an
amount or output the program forbids (naming the check that fails), a key
that is not the one the path names, and a template not on the wallet's list.
Approving signs the digest of the summary the window showed, and nothing else.
`getCapabilities().features` carries `contract-spend` on builds that do this.

### `signMessage({ message })` — approval per request
`{ signature }` over the given UTF-8 message with the wallet's key.

### `getStakerPublicKey()` — silent, requires connection and an unlocked wallet
`{ staker_pubkey }`: the wallet's staking key (derivation `m/2/0`), the key a
stake is bonded to.

### `signStakerMessage({ message })` — approval per request
`{ signature, staker_pubkey }`: a signature over the UTF-8 message under the
staking key, in the same base64 form `signMessage` returns. It proves control
of the key a stake is bonded to, which a master-key signature cannot. It
authorises no payment and cannot move a stake; only a transaction can do
either.

### `broadcast({ pset? , hex?, chain? })` — silent, requires connection
Relays an already-signed transaction: either a finalized-able `pset` (base64)
or a raw `hex`; `chain: 'bitcoin'` sends `hex` to testnet4 instead of
Sequentia. Returns `{ txid }`. No prompt: signing was the approved step.

### `createInvoice({ amount, asset?, memo? })` — approval per request
Creates a Lightning invoice on the user's own hosted node. `asset` omitted or
`'BTC'` → BTC over Lightning; else a fee-priced Sequentia asset id (OpenAMP
assets cannot travel over Lightning). Returns `{ bolt11 }`.

### `payInvoice({ bolt11, asset? })` — approval per request
Pays a bolt11 invoice from the user's Lightning balance for that asset
(default BTC). Returns `{ paid: true, preimage }`.

## v0.2 methods (added for the SeqDEX site)

### `getUtxos({ asset? })` — silent, requires connection
The wallet's unspent outputs, optionally filtered to one asset:
```js
{ utxos: [{ txid, vout, asset, value, scriptPubkey, address, height }] }
```
`value` is an atoms string. The DEX composes swap PSETs from these and sends
them back through `signPset`, where the user approves the actual spend — so
this read reveals holdings the origin could already infer from
`getBalances`, never spend authority.

### `lnChannels()` — silent, requires connection
Per-asset Lightning capacity on the user's own channels — the LNDEX
prerequisite check:
```js
{ deployed: true, channels: [{ kind: 'BTC' | '<assetHex>', scid, state,
                               spendable: '<atoms>', receivable: '<atoms>' | null }] }
```

### `lnRequestInbound({ amount, asset? })` — approval per request
Requests inbound Lightning capacity (JIT liquidity from the LSP) so the
wallet can RECEIVE up to `amount` atoms of `asset` (default BTC) over
Lightning. May provision or extend a channel to the user's hosted node.
Phase one of the channel marketplace.

## DEX taker methods

For both methods the wallet NEVER trusts the site's numbers: the site names
an offer (pair + `offerId` + take size) and the wallet re-fetches that offer
from the order-book relay itself, recomputes the exact amounts with the
daemon's proRata / slice math, and shows those in the approval window.

### `dexFillOnchain({ base, quote, offerId, takeBase, mount? })` — approval per request
Fills a resting same-chain order (maker co-signs over the relay courier; the
wallet signs and broadcasts the atomic swap transaction). `takeBase` is the
take size in base-asset atoms (partial fills settle at the offer's exact
ratio). `mount: 'conf'` fills on the confidential book instead: the wallet
receives to a blinded address and the trade settles as a blinded
transaction. Returns `{ txid, paid: {asset, atoms}, received: {asset, atoms} }`.

### `dexSwapLn({ base, quote, offerId, takeAtoms? })` — approval per request
LNDEX taker swap: both legs travel over the user's OWN hosted Lightning
nodes (device-co-signed; the LSP routes but cannot move funds). `quote` is
`'BTC'` for a cross-chain market or an asset id for asset-to-asset. Omitting
`takeAtoms` lifts the whole offer. After approval the swap runs in the
wallet's persistent engine and the call returns `{ jobId, pending: true }`;
poll `dexJobResult({ jobId })` until it answers
`{ done: true, result: { settled, direction, baseAtoms, quoteAtoms, preimage, paymentHash } }`.
Instant and final on settlement; on a stall nothing moves.

### `dexJobResult({ jobId? })` — silent, requires connection
The outcome of a dispatched DEX job (`dexSwapLn`, `dexMarketOrder`,
`dexPlaceLimit`): `{ done: false }` while it runs, then
`{ done: true, ok: true, result }` with the `result` shape each method
documents, or `{ done: true, ok: false, error }` when it failed. Without a
`jobId` it returns the newest job (plus its `jobId`), so a page that lost the
id to a restart can still recover the outcome; `{ done: false, none: true }`
means no job exists.

## OpenAMP account methods

The wallet holds OpenAMP restricted assets in an enclave account derived at
`m/5/0`: the x-only public key of that derivation is registered with the policy
server, which derives the account id (AID) and the 2-of-2 enclave address the
assets live in from it. These methods let a site work against **that** account —
the one the user can already see in their wallet — instead of asking them to
generate a second identity in a browser tab.

What a site may ask for is deliberately narrow, and the boundary is not a
matter of taste. The enclave key is the user's half of a 2-of-2; a party who
could choose the 32 bytes it signs would hold a signing oracle over transfer
sighashes and could drain the account. So there is no method that signs a digest
the site supplies, and there must never be one. A site gets the public identity,
a **domain-tagged** statement, and a co-signature on a transaction it hands over
in full.

### `openampGetIdentity()` — silent, requires connection and an unlocked wallet
`{ aid, xonly }`: the account id and the x-only enclave public key. Registration
with the policy server is idempotent and is retried here, so this succeeds on a
wallet whose enclave was unreachable at startup.

### `openampSignTagged({ tag, statement? , hash?, label? })` — approval per request
`{ signature, xonly }`: a BIP340 signature over the **tagged** hash
`sha256(sha256(tag) || sha256(tag) || message)`, which is what a verifier
recomputes.

Give exactly one of:

- `statement` — UTF-8 text, up to 4096 characters. The message is its UTF-8
  bytes. This is the form for login challenges, mandates and declarations.
- `hash` — a 64-hex, 32-byte content address. The message is those raw bytes.
  This is the form for an e-signature over a document. Pass `label` to name the
  document in the approval window; it is shown as the site's claim, not as fact.

The tag is the domain separator, and the wallet enforces what it may be: 1–64
printable non-space characters, and never one that names a digest a consensus
rule already computes (anything beginning `tap`, `bip0340`, `bip340`, `bip322`
or `elements`, or containing `sighash`). A statement carrying control characters
is refused too — the approval window has to be able to show the user exactly
what they are signing, because reading it is their defence against a statement
that means more than they assumed.

### `openampSignSpend({ asset, tx, toSign, recipientAid? })` — approval per request
`{ sigs }`, a map of input index to 128-hex signature, for an enclave spend the
**site's backend** built and will complete. Use this where the site is the
transfer agent: the wallet signs and returns, it never submits.

- `asset` — the 64-hex restricted asset id being spent.
- `tx` — the full transaction hex the policy server built.
- `toSign` — the policy server's list, `[{ input, sighash?, pubkey? }]`.
- `recipientAid` — optional; the account the site says is being paid.
- `leaf` — which leaf of the enclave's taproot tree this spend takes:
  `'transfer'` (the default) for a holder moving their own balance, or
  `'claw'` for an issuer sweeping under a disclosed clawback.
- `fromAid` — required for `'claw'`: the account id whose enclave output is
  swept. A clawback spends *that holder's* address, so its leaf and control
  block come from theirs, while the signature comes from the issuer's key.

The wallet does not trust any of it. It decodes `tx`, resolves every prevout
from the explorer, recomputes each sighash itself from its own enclave leaf and
control block, and refuses on any mismatch with a `sighash` the site sent along;
the signature is over its own recomputation regardless. An input whose `pubkey`
is not this wallet's enclave key is refused outright. If `recipientAid` is
given, the wallet asks the policy server for that account's enclave address and
tells the user whether an output actually pays it — shown, not enforced, so a
policy server that derives the output script another way cannot break a
legitimate transfer.

The approval window shows what leaves the account, decoded from the transaction
rather than described by the site.

### `openampSignSupervision({ kind, asset, address?, txid, vout })` — approval per request
`{ signature, xonly }`: the authorization for a supervised asset's freeze, pause
or lift, signed with this wallet's enclave key in its role as the asset's
**operational key**. Use it where the wallet holds the key a supervised asset
committed to at issuance.

- `kind` — `'freeze'`, `'unfreeze'` or `'pause'`.
- `asset` — the 64-hex supervised asset id.
- `address` — the holder's address being frozen or unfrozen. Omitted for a
  pause, which names every script at once.
- `txid` / `vout` — for a freeze or pause, the first input the record's
  transaction will spend, which is what stops a freeze signature being lifted
  off the chain and replayed. For a lift, the freeze record's own outpoint,
  since spending the record is what lifts it.

The site does not choose the bytes. The node's message is a BIP340 tagged hash
over a short, fixed layout, so the wallet rebuilds it from these fields — it
derives the script from the address itself and hashes it — and signs its own
reconstruction, having shown the fields in the approval window. A site that
misdescribes any of them produces a signature the network rejects, rather than a
freeze the issuer did not intend.

For the same reason the node's own tag namespace (`sequentia/…`, which is where
`Sequentia/SupervisionRecord` and `Sequentia/SupervisionUnfreeze` live) is
refused by `openampSignTagged`: a message under one of those is a consensus
instruction rather than a statement, and only the method that can decode and
display it may produce one.

## Events

Subscribe with `window.sequentia.on(event, handler)` and unsubscribe with
`window.sequentia.removeListener(event, handler)`; both return the provider:

- `accountsChanged` — `{ accounts: [] }` fires when the wallet locks (site
  should treat the session as suspended).
- `disconnect` — `{}` fires when the user revokes this site in Settings.

The provider also carries `isSequentia: true` and `network:
'sequentia-testnet'` as plain properties, readable without a request.

## Design notes for the DEX

- Match rail-blind, settle by rail: the provider deliberately exposes both the
  on-chain surface (`signPset`/`broadcast`) and the Lightning surface
  (`createInvoice`/`payInvoice`), so the DEX site can implement same-chain
  atomic swaps, covenant resting orders, and LN legs against one wallet API.
- The wallet enforces first principles the site must not fight: no privileged
  asset (fee selection is the wallet's), transparent-by-default addresses,
  amounts always in atoms.
- Anything not yet covered here (for example HTLC secret management for
  cross-chain swaps) should be proposed as a protocol extension in this file
  before being built into the site.

## dexMarketOrder

`request({ method: 'dexMarketOrder', params: { room, base, quote, side, baseAtoms } })`

One-approval market order. The wallet re-fetches the room's order book itself,
plans a walk across the opposing resting orders best-first (bounded at 5% past
the best price), and shows a single aggregate approval: total paid, total
received, number of orders walked. After approval the walk executes inside the
wallet's persistent engine; the call returns `{ jobId, pending: true }` and the
site polls `dexJobResult` exactly as for `dexSwapLn`. The finished result is
`{ market: true, baseAtoms, quoteAtoms, slices: [{ ok, offerId, ... }] }` —
a failed slice is skipped, never retried blind, and never fails the whole
order while any slice settled.

- `room`: `'ln'` (pure-Lightning book) — other rooms not yet served.
- `base`: 32-byte hex asset id. `quote`: 32-byte hex or `'BTC'`.
- `side`: `'buy' | 'sell'` of the base asset. `baseAtoms`: decimal string.

## dexPlaceLimit

`request({ method: 'dexPlaceLimit', params: { room, base, quote, side, baseAtoms, limitQuoteAtoms } })`

Limit order, fill-then-rest. `limitQuoteAtoms` is the quote-side total for the
whole `baseAtoms` (the exact integer price). Anything the book already crosses
at your price or better fills immediately (same engine as a market order,
bounded by the limit instead of slippage); the remainder RESTS on the book as
a live offer served by the wallet itself: the wallet answers lifts, registers
holds on its own node, pays the counter-leg, settles — the full maker
choreography, atomically per fill. One approval covers both halves.

Presence is honest: the resting offer lives while the wallet's engine lives
(offers expire within the hour otherwise). Poll `dexJobResult` for state:
`{ resting: true, remaining, filledAtoms, ... }` while resting, then a final
`{ done: true, result: { rested, baseAtoms, quoteAtoms, fills } }` when fully
matched.
