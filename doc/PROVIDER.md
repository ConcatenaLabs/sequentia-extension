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
  methods: [...], features: [...],
  events: ['accountsChanged', 'disconnect', 'modeChanged', 'leafArrived', 'leafSyncDue', 'leafTake'] }
```

### `getNetwork()` — silent
`{ network: 'sequentia-testnet', genesis: 'ddd11d54…a92e' }`: the network's name
and its genesis block hash, which a contract instance names as its chain.

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

### `signContractSpend({ templateHash | descriptor+sources, instance, drip | request, fund?, broadcast? })` — approval per request
A spend of a contract written with
[`sequentia-contracts`](https://github.com/ConcatenaLabs/sequentia-contracts),
under the five-point rule. The kit's contract engine (SWK `lwk_contracts`)
does every step; the wallet signs only when all five hold:

1. the template is on the wallet's list, which is the templates the kit carries
   (`sequentia/one-key`, `sequentia/one-key-exit`, `sequentia/faucet-drip`,
   `pignus/vault`, `pignus/offer`, `sequentia/capped-sale`,
   `sequentia/subscription-escrow`), and so is every template an output opens; a
   site can pass a template it wrote (`descriptor` and `sources`, each source
   with its includes resolved), which is read and checked but never signed for;
2. the engine recomputed the output from the template and the instance, and the
   coin pays it, and recomputed every contract an output opens or returns to;
3. the engine ran the program of every Simplicity input against the final
   transaction;
4. the approval window showed the template (by the registry's name, which the
   wallet looks up itself, else its commitment root), the path, every
   parameter by role, every input by what it is, the wallet's balance change in
   every asset (what its own inputs pay included), the contracts an output
   opens, where the coins go, and the checks;
5. the key is a contract key, the one the path names (`m/8383h/1h/0h/0/0`),
   or none on a path that takes no signature; the wallet's funding keys sign
   only its own inputs. On a capped sale's purchase the buyer's key is a value
   of the request (`spender.BUYER_KEY`), and the wallet signs only when it is
   this wallet's contract key (`getContractKey`): its signature is over the
   program's `sig_all_hash`, so it is the buyer's signature over that purchase
   and no other. A purchase past the key's cap is refused before any window
   opens, and the approval says what is bought, against which cap, and what
   the treasury is paid.

The approval window signs the digest of what it showed; a request changed
after it was shown is another digest, and nothing is signed.

Parameters:

- `templateHash`: a template the kit carries; or `descriptor` (the
  descriptor JSON) and `sources` (`{"<name>.simf": "<text>"}`).
- `instance`: the instance record, `{instance, template_hash, params, slots,
  genesis}`; `genesis` is the chain's (`getNetwork`).
- `drip`: for the faucet drip covenant, `{coin, amount, to?, ratePerKvb?}`:
  the reserve coin (`{txid, vout, script_pubkey, asset, amount}`, asset in
  display hex), the atoms to drip, the address paid (this wallet's by
  default), and the fee rate in atoms of the dripped asset per 1,000 vB
  (1,000 by default). The wallet plans the drip at its real size.
- `request`: for any other spend, the engine's request: `{path, coin,
  inputs?, sequence?, lock_time?, outputs: [{to, address | script, asset,
  amount, open?, input?}], spender?, next_slots?}`.
  - `inputs` lists every input in order: `{is: 'contract'}` (the `coin`,
    exactly once); `{is: 'wallet', txid, vout, asset, amount}`, one of this
    wallet's coins, spent only when the wallet's own record of that coin says
    the same; `{is: 'foreign', txid, vout, script_pubkey, asset, amount,
    witness, sequence?, label?}`, a coin spent through a script leaf with the
    witness given (hex items, the leaf and its control block last), spent only
    when the chain's record of the coin, which the wallet reads itself, agrees
    and the leaf is committed in the coin's output key; `{is: 'sibling', coin,
    instance}`, another coin of the same template spent by the same tapscript
    path (each subscription coin of an escrow's release), with its own
    instance, spent only when the chain's record agrees and its instance names
    the same key and locks, and signed with the same contract key. Without
    `inputs` the contract coin is the only input.
  - Each output says what it does: `contract` (back to the contract, or to its
    next state), `wallet`, `pay`, `fee`, `open` (a new contract, `open` its
    instance record, of a template the kit carries) or `foreign` (foreign
    input `input` recreated).
  - `spender` holds the values the spender chooses: hex of their width, or a
    SimplicityHL literal for a composite type (`Left(Left(()))`).
- `fund`: `true` lets the wallet add its own explicit coins for what the
  request's inputs do not cover, and the change to its own address. Pignus
  uses it for a take, a repayment and a top-up.
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

### `getContractKey()` — silent, requires connection and an unlocked wallet
`{ contract_key, path }`: the wallet's contract key, x-only hex, at
`m/8383h/1h/0h/0/0`. It is the key a project puts on a capped sale's
allocation list for this buyer, and the key an issuer names as a subscription
escrow's release key. Only `signContractSpend` signs with it, through the
approval.

### `signContractStatement({ tag, statement? , hash?, label? })` — approval per request
`{ signature, xonly }`: a BIP340 signature with the contract key over the
tagged hash `sha256(sha256(tag) || sha256(tag) || message)`, the same form and
the same tag policy as `openampSignTagged` (no `tap…`, `bip340…`, `elements…`,
`sequentia/…` tag, nothing with `sighash`, refused by the kit as well). It
proves the contract key to a platform that names it in a contract, such as an
escrow's release key. A Simplicity spend's signature hash begins with the
chain's genesis hash twice, where a statement's begins with `sha256(tag)`
twice, so a statement's signature cannot stand for a spend.

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

## The wallet's mode

### `getWalletMode()` — silent, no connection needed
`{ mode: 'developer' | 'user' }`. The wallet has one mode setting (Settings →
Mode), kept for each wallet and `'user'` until the user changes it. The words
are the same in every Sequentia wallet:

- **User mode**: One figure per asset, and the wallet chooses how value moves.
- **Developer mode**: Every rail by name, side by side (on-chain, leaves and
  Lightning), each with its balance and its manual controls, and the developer
  tools.

A site reads the mode and follows it, with an override of its own if it wants
one: a site's developer features (leaves, a rail picker, contract tools) are
shown in developer mode, and in user mode the site shows one figure per asset
and one action. The read needs no connection, so a site can choose its layout
before it asks to connect. While the wallet is locked it answers the mode of the
wallet last opened.

The `modeChanged` event (`{ mode }`) fires on every page that listens when the
user changes the setting.

## Leaves (developer mode)

A leaf is a coin of a Sequentia asset held in an operator's tree off the chain:
paid and received without a transaction, and taken on-chain by the wallet alone
whenever it must be. Leaves are one rail among the wallet's rails (on-chain,
leaves, Lightning), and a developer-mode one: in user mode every method in this
section refuses, and no leaf event reaches a site. A wallet that joined an
operator keeps its leaf wallet open and syncing in either mode all the same,
since its coins have dates to keep, and their value counts in each asset's
figure and in the headline (`getBalances` is unchanged: it answers the
on-chain and Lightning rails).

What the wallet does by itself, in either mode and with no window: once after
the leaf wallet opens, and after a sync at most every ten minutes, it runs the
library's `care`. That takes up every open claim of a distribution named for one
of the wallet's receive keys (the main wallet's addresses handed out so far, and
20 more), so the asset counts in its figure with no click; cancels each refresh
plan whose coin has moved; signs a refresh plan for each coin whose refresh step
could run within ten days, so a wallet closed across that coin's expiry keeps
it; and sends a coin no round made (a board, a coin received or claimed out of
round) into a round's refresh, so that a later run can plan the new one. A
plan's fee is taken from the coin in the coin's own asset, never another; a
coin the operator will not plan stays unplanned and is refreshed by `sync`
while the wallet is open. A coin younger than that stays free to pay; a wallet
closed within a coin's first two weeks or so and kept closed through its step
window can lose the coin to the operator's sweep, as any absent holder can.
A coin a plan names pays nothing until it is refreshed in a round: the popup's
developer mode lists the plans with Cancel and Release (cancel, then refresh in
the next round), and none of this shows in user mode.

The wallet runs the operator's wallet library, compiled to wasm, in a worker of
its offscreen document (`leaves/`). Every script, record, check, fee and
refusal is the library's; the extension shows what it answers and refuses in its
words. The user joins an operator in Settings (its server, and a node that
validates anchors and keeps a transaction index); the wallet pins the
operator's key and the node's chain when it joins, and refuses any server that
names another.

Every asset is a leaf asset on equal terms; none is a default, so a send names
its asset or pays a request that names one. Native BTC is not a leaf: a tree on
Sequentia holds no BTC, which stays on its own chain and its own rail
(`getBalances().btc`, Lightning).

While the browser runs and the wallet is unlocked, the offscreen document keeps
the leaf wallet open and syncs it on the library's own schedule (when a coin's
refresh window opens, while a receive request waits, while anything is moving),
without the service worker waiting on it. Locking the wallet closes the leaf
wallet; unlocking opens it again and syncs at once if anything fell due.

Errors common to the methods below, besides the connection and lock errors
above:

- `'leaves are a developer-mode rail: turn developer mode on in the wallet\'s Settings'`
- `'this wallet has not joined a leaf operator: join one in the wallet\'s Settings'`
- `'the leaf wallet did not start: …'` with the reason (for example its storage
  held by another browser profile's worker).
- A refusal of the library, as the library words it: its kind, a colon, and its
  reason (`refused: …`, `the server refused …`; examples below).

### `getLeafBalances()` — silent, requires connection and developer mode
What the leaf wallet holds, as the library's `balance` answers it:
```js
{ leaves: { '<assetHexId>': { total: '<atoms>',
                              states: { 'live': '<atoms>', 'operator-confirmed': '<atoms>', 'pending': '<atoms>', … } } },
  onchain: { '<assetHexId>': '<atoms>' },  // the leaf wallet's own on-chain coins (its boarding address)
  value: { value: '<atoms of the reference unit>' | null, unit: 'reference', values: {…}, unvalued?: [...], note },
  schedule: { now, next_sync_at, due } }   // median times, seconds
```
A coin's state is the library's: `live` (in a tree whose round is final),
`operator-confirmed` (received out of round and not yet refreshed, which holds
on the operator's co-signature until then), `pending` (boarded, waiting for its
round), and the transitional `sending`, `given`, `forfeited`, `exiting`. `total`
sums them. `value` is the library's headline: every asset held, leaves and the
leaf wallet's on-chain coins together, valued at the rates of the wallet's own
node, with any asset the node has no rate for listed in `unvalued` and left out.
No asset comes first.

### `getLeafAddress()` — silent, requires connection and developer mode
`{ address, script_pubkey }`: an on-chain address of the leaf wallet on
Sequentia (an unblinded `tb1…`, the same key type as the wallet's own
addresses). Pay it to give the leaf wallet a coin to board, or a coin to pay an
exit's fees with. It is the same address each time it is asked, so a site
cannot grow the wallet's address scan by asking again.

### `boardLeaves({ asset, amount, fee_asset? })` — approval per request
Boards `amount` atoms of `asset` from the leaf wallet's on-chain coins into the
operator's tree: one transaction, which the operator registers before it is
broadcast, so a refused board spends nothing. The coin is a leaf, spendable,
once the transaction is final. The fee is paid in `fee_asset`, or in the asset
boarded when none is named; no other asset is ever chosen for it.

Before the window opens the library quotes the board (`board_quote`): its fee,
its size and the coins it spends, signing and asking nothing. The window shows
the asset, the amount, the fee in the fee asset's own atoms and the size. On
approval the library boards only on the fee shown; if the fee has changed (the
coins or the node's rate moved), nothing is registered or signed and the
request fails with
`refused: the board's fee changed since it was shown; it is now {…}`.
Returns the library's answer:
```js
{ leaf_id, txid, vsize, asset, value: '<atoms>', fee: { asset, amount: '<atoms>' },
  state: 'pending',
  exit_fee?: { fee_coin: 'missing', note } }  // the wallet holds no coin to pay this coin's exit with
```
Refusals before the window, besides the common ones: `asset` or `fee_asset` not
a 64-hex id, `amount` not a positive integer, and the library's quote refusals,
for example `refused: a board of 500 is below the server's smallest leaf in
asset <id>, 1000`, `refused: asset <id> is not accepted for fees by the node
now; …`, `refused: the wallet holds <n> of asset <id> on-chain that it can
spend, and needs <m>`.

### `exitLeaf({ leaf_id, fee_asset? })` — approval per request
Takes one leaf home on-chain by the wallet alone, without the operator: the
transactions of its path still missing, then, once the leaf's transaction is in
a block and its exit delay has run, the claim to one of the wallet's addresses.
After the first run the wallet carries the exit on by itself (each sync takes
it as far as the chain allows) until the claim is final. Fees come from what
each transaction carries for them (a node's reserve, a margin) where that pays
the node's floor, and otherwise from an on-chain coin of the leaf wallet's in
`fee_asset`, or, when none is named, the asset the library chooses among those
the node accepts (the asset moved first).

Before the window opens the library quotes the exit (`exit_quote`), broadcasting
and writing nothing. The window shows the coin, each transaction to broadcast
now with its size, its fee and what pays it, the claim's fee at the node's floor
now, and the exit delay. On approval the library broadcasts the path only on the
fees shown; if they have changed, nothing is broadcast and the request fails
with `refused: the exit's fees changed since they were shown; they are now {…}`.
The claim's fee is the floor when the claim is made. Returns the library's
answer:
```js
{ leaf_id, state: 'unrolling' | 'waiting' | 'claimed',
  broadcast: [{ txid, vsize, fee: [{ asset, amount }] }, …],
  leaf?: '<txid:vout>', next?: '<what happens next>', error?: '<a broadcast refused, in the node's words>',
  claim?: { txid, vsize, pays, to } }
```
Refusals before the window, besides the common ones: `leaf_id` missing,
`fee_asset` not a 64-hex id, and the library's, for example `refused: no coin
<id>`, `refused: coin <id> is spent: there is nothing of the wallet's to exit`,
`refused: the wallet holds no on-chain coin of asset <id> to pay the exit's
fees with`.

### `requestLeafReceive({ asset?, amount? })` — approval per request
A single-use receive request: a fresh key, this wallet's mailbox, and the exit
delay the wallet asks for. `asset` is a 64-hex asset id the operator serves;
`amount` is an atoms string. Both may be left out (the payer then names them).
Returns the library's answer:
```js
{ request: 'request:…',   // the text to hand the payer
  details: { owner, mailbox, exit_delay_units, until, asset?, value?, … } }
```
`until` is the median time at which the request lapses; nobody pays it after
that. The payment arrives in the wallet's mailbox. For an hour after a request
is handed out the wallet reads its mailbox about once a minute; after that the
library's schedule reads it at least daily until the request is paid or lapses.
Each coin read fires `leafArrived`.

The approval window says the site asks for a receive request for leaves, and
shows the asset and the amount, or "any" for each left out.

Refusals before the window: `asset` not a 64-hex id, `amount` not a positive
integer, user mode, no operator joined. Refusals of the library after approval,
for example an asset the operator does not serve
(`refused: the server does not serve asset <id>`).

### `sendLeaves({ request, asset?, amount? })` — approval per request
Pays a receive request from this wallet's leaves, out of round: no transaction
and no round. `request` is the text a receiver handed out (`request:…`, or any
other prefix the library reads). `asset` and `amount` are needed only when the
request leaves them out; a request that names an asset is paid in that asset
alone.

Before the window opens the wallet reads the request and refuses one it cannot
pay as asked: not a receive request (`the receive request: the text is not
one`), for another chain or operator (`the receive request is for operator
<key>, not this wallet's`), an asset other than the request's (`the request
asks for asset <a>, not <b>`), no asset or no amount from either side. The
window shows the asset and the amount paid, the receiver's key and mailbox, and
when the request lapses; what is approved is what is paid, since the wallet
passes the shown asset and amount to the library, which refuses a mismatch with
the request. Returns the library's answer:
```js
{ sent: { asset, value, to },          // `to`: the receiver's leaf key
  inputs: ['<leaf id>', …],            // this wallet's coins spent
  margins: { asset, checkpoints: ['<atoms>', …], reassignment: '<atoms>' },
  change: '<atoms>' | null,
  transfer: { … } }                    // the operator's co-signed transfer
```
The margins are atoms of the asset moved, left in the tree for the fees of
taking the coins on-chain; nothing is paid to the operator for a payment out of
round. Refusals of the library after approval, in its words, for example:

- `refused: the request lapsed at <t> (a median time; the chain's is <now>): ask the receiver for a new one`
- `refused: <amount> is below the operator's smallest leaf in asset <id>, <min>`
- `refused: the wallet holds <n> of asset <id> in live coins, and paying <amount> takes …`
  (not enough live leaves of the asset, with what the margins need);
- the operator's refusal, with its code and status, for example
  `the server refused cosign_transfer (409 key_reused): …` for a second payment
  of one request.

### Leaf events

Delivered to connected sites only, and only in developer mode:

- `leafArrived` — `{ leaf_id, asset, value, kind }` for each coin a sync
  accepted from the mailbox (`value` in atoms). It fires once per coin, from
  the sync that accepted it, whoever asked for that sync. A claim of a
  distribution, which the wallet takes up by itself (see below), arrives with
  `kind: 'claim'`, `leaf_id` the coin it was paid on to.
- `leafSyncDue` — `{ now, next_sync_at, why? }` when the library's schedule
  falls due, just before the wallet runs the sync it asks for. `why` is the
  library's reason when something holds the time (a waiting receive request).

`getCapabilities().features` carries `leaves` on builds that serve this
section (`getLeafBalances`, `getLeafAddress`, `requestLeafReceive`,
`sendLeaves`, `boardLeaves`, `exitLeaf`), and `events` lists `modeChanged`, `leafArrived` and `leafSyncDue`.

## On-chain orders filled from leaves and placed from them (developer mode)

A site's on-chain room (the SeqDEX site's leaves room first) uses these to fill an
ordinary on-chain order, a SeqDEX covenant order resting on the chain, with the
wallet's leaves, and to place such an order from leaves. They are leaf methods: in
user mode each refuses with the developer-mode error above, and `leafTake` reaches no
site. Every check, price, fee and refusal is the leaf wallet library's; the wallet
takes nothing on the site's or the relay's word.

### `getLeafOperator()` — silent, requires connection and developer mode
The operator this wallet joined, as a room names it:
```js
{ operator: '<x-only key hex>', server: '<url>', genesis_hash,
  assets: [{ asset, min_leaf, fees: { refresh_ppm, refresh_base, offboard_ppm, offboard_base, … } }],
  fills: { order_margin_seconds, forfeit_window_seconds, block_seconds },
  forfeit_window_seconds }
```
A take pays the operator its offboard fee (`offboard_ppm`, `offboard_base`) in the asset
it pays with. The operator takes an order only while its refund lies more than
`order_margin_seconds` ahead.

### `takeOrder({ order, amount?, max_fee_ppm? })` — approval per request
Fills `amount` atoms of an on-chain order (all of what it holds when left out) from
this wallet's leaves, through the operator's round: the round spends the order, pays
its maker on the chain, and pays this wallet a leaf of what it fills. `order` is the
relay's offer as its order book serves it (the covenant terms with the outpoint
where the order rests). `max_fee_ppm` raises the wallet's bound on the operator's
fee, in millionths of the price (the library's default otherwise).

Before the window opens the library quotes the take (`take_quote`): it rebuilds the
order's script from the terms, finds it on its own node at the outpoint, unspent,
final and holding what the terms sell, and prices the fill by the covenant's own
arithmetic. The window shows what is got (a leaf of the filled amount, once the round
is final), what is given (the price and the operator's fee, in the asset the order is
paid in), the price paid to the maker, the fee, what rests of the order after the
fill, the operator, whether the wallet first pays itself a coin of exactly that much
out of round, and the wallet's part: once the operator builds the round, the wallet
hands over the forfeit of the coin it gives within the operator's forfeit window
(`forfeit_window_seconds`). On approval the library takes only on the fill, price and
fee shown (`refused: the take's fee changed since it was shown: it is now …` otherwise, and the same for its fill and price).
Returns the library's answer:
```js
{ take: '<id>', state: 'pending', order: '<txid:vout>', filled, remainder, price, fee,
  asset_a, asset_b, gives: ['<leaf id>'], wants: [{ nonce, asset, value }], paid_itself?, note }
```
The wallet then carries the take on by itself, with no window open: its offscreen
document syncs every few seconds while the take waits on its forfeits, hands them over
as soon as the round is built, and takes the new leaf once the round is final. The
take, and the record the wallet keeps of it, survive the popup closing and a browser
restart; after a restart the wallet must be unlocked again before the window runs
out (the toolbar badge shows `!` while a take waits on a locked wallet). A take whose
forfeits do not come in time is voided by the operator, and its coins are the
wallet's again.

The fee is paid in the asset the order is paid in, as the operator's schedule for that
asset asks; no other asset is chosen for it.

Refusals before the window, besides the common ones: `order` not an object carrying
covenant terms, `amount` or `max_fee_ppm` not a whole number, and the library's quote
refusals, for example `refused: order <txid:vout> is confirmed: a round takes an order
once its transaction is final`, `refused: order <txid:vout> is spent, in a block or in
the node's mempool: it was filled or refunded`, `refused: … leaves 5000 resting, below
the order's min_lot of 10000: …`, `refused: the operator's fee … is …, above the
wallet's bound of … ppm of the price …`, `refused: order <txid:vout>: the terms do not
make the script on the chain there: …`. After approval, the operator's refusals, for
example `the server refused take_order (409 order_taken): …` for an order another take
holds.

### `getLeafTakes()` — silent, requires connection and developer mode
The takes this site made, each as the wallet knows it now:
```js
{ takes: [{ take, stage, state, round, order, offer_id, pair, asset_a, asset_b,
            filled, price, fee, remainder, leaf: { leaf_id, asset, value, state } | null,
            forfeit_window_seconds, at }] }
```
`state` is the library's participation state; `stage` says it in a room's words:
`submitted` (the operator holds the take; no round fills it yet), `handing-over` (the
round is built; the wallet hands over its forfeits), `forfeits-in` (the round goes out
once every take in it has handed its forfeits over), `released` (the round is final and
the wallet holds the leaf), `void` (the take did not happen; its coins are the
wallet's again). Whether the round is in a block, final or undone is the relay's fill
record of `round` (`GET /v1/market/{base}/{quote}/fills`): a fill is final once its
block is certified and its Bitcoin anchor buried, and a fill whose block leaves the
chain is undone until the round is mined again.

### `placeOrderFromLeaves({ sell, amount, want, rate_num, rate_den, min_lot?, expiry?, max_fee_ppm? })` — approval per request
Places an ordinary on-chain order from this wallet's leaves: it sells `amount` atoms of
`sell` for `want`, `rate_num` atoms of `want` for every `rate_den` atoms sold (each
fill's price rounded up), in fills of at least `min_lot` atoms, refundable once the
chain's median time passes `expiry` (unix seconds; a day ahead when left out). The
operator's round pays exactly `amount` into the address the order's terms make; once
that round is final and the payment unlocked into the address, the order rests there
with its maker offline, and anyone fills it. It cannot be cancelled before `expiry`:
what rests then is taken back by its refund. Its credits are paid to a key of the
wallet's own, never to a leaf.

Before the window opens the library quotes the placement (`order_quote`): the coins
given up, the fee (each coin's refresh fee, the offboard's fee and the margin the
offboard output keeps for its unlock), the change, and the order's full price. The
window shows these, the refund time, and the relay it is listed at. The fee is paid in
the asset sold, from the coins given up. On approval the library places the order only
on the fee and the coins shown (`refused: the order's fee changed since it was shown: it
is now …` otherwise). Returns the library's answer with the offer id the wallet lists it
under:
```js
{ order: '<id>', state, terms, amount, fee, gives, change, offer_id, note }
```
Once the order rests, the wallet lists it on the on-chain relay by itself (after every
sync of the leaf wallet): it reads the output at the order's outpoint from the explorer
and posts the offer only when that output pays the terms' script, in the clear,
holding exactly the order's amount, signed with a key derived for that order alone.
It posts it again before the relay's listing runs out, for as long as the order rests.

Refusals before the window, besides the common ones: an asset that is not a 64-hex id,
the same asset sold and wanted, an amount, rate, lot, expiry or fee bound that is not a
positive whole number, and the library's quote refusals, for example a refund too soon
for the operator's order margin, or too few live leaves of the asset sold.

### `getLeafOrders()` — silent, requires connection and developer mode
The orders this site placed from leaves, as the library reads them from the chain each
time, and where the wallet listed them:
```js
{ orders: [{ order, offer_id, state, rests_at, holds, terms, fills, credits, refund_from, note,
             posted: { at, outpoint, relay_expires, maker_pubkey } | null, post_error }] }
```
`state` is the library's: `waiting` and `in_round` (its round), `unlocking`, `resting`,
`filled`, `refunded`, `spent`, or `not_placed`.

### `leafTake` event
`{ take, stage, state, round, … }` as `getLeafTakes` answers a take, to the site that
made it, each time the take changes; in developer mode only.

`getCapabilities().features` carries `leaf-orders` on builds that serve this section.

## The in-tree swap between two wallets that hold leaves

Two wallets that hold leaves of one operator swap two assets in one reassignment in
the operator's tree: nothing goes on the chain until a round settles it, and neither
wallet can take the other's asset without giving its own. The two wallets pass two
texts between them, which the site carries: the maker's offer, then the taker's
acceptance. These methods are refused in user mode, and to a wallet that has joined no
operator, with the same words as the other leaf methods. BTC is never a leaf: both
assets are Sequentia assets.

### `leafSwapOffer({ give_asset, give, want_asset, want })` — approval per request
Offers `give` atoms of `give_asset` for `want` atoms of `want_asset`. The library makes
the offer first (`swap_offer`): it holds the coins the offer spends and signs nothing.
The window shows what is given, what is got, and what the maker pays: the
reassignment's margin and the margins its coins leave, in the asset given. Rejecting
cancels the offer at once and frees the coins. Returns:
```js
{ swap: '<id>', offer: '<text>', gives: { asset, value }, gets: { asset, value },
  pays: { asset, margin, margins } }
```
The site hands `offer` to the other wallet.

### `leafSwapAccept({ offer })` — approval per request
Accepts another wallet's offer. The library reads it first (`swap_read`): it checks the
maker's coins as a receiver checks a coin, that they keep exactly what the offer gives,
its change and its margin, and that the first output is what the maker wants; it signs,
holds and stores nothing. The window shows what is got (a leaf), what is given, what
this wallet pays (the margins its coins leave), what the maker pays, the change, and
the date by which the coins got must be taken on the chain at the latest (every coin a
swap makes rests on every coin it spends). On approval the library signs only on the
terms shown (`refused: the swap's terms changed since they were shown; they are now …`
otherwise). Returns:
```js
{ swap: '<id>', accept: '<text>', gets, gives, pays }
```
The site hands `accept` back to the maker.

### `leafSwapComplete({ accept })` — approval per request
Completes a swap this site offered from this wallet with the other wallet's acceptance.
The window shows the offer it completes as the library answered it when it was made.
On approval the library checks that the acceptance keeps the maker's coins and outputs
exactly as offered, signs the maker's side, and has the operator co-sign; both wallets'
new leaves then wait for them at the operator. Returns `{ swap, done: true }`.

### `getLeafSwaps()` — silent, requires connection and developer mode
The swaps this site started from this wallet, as the library lists them:
```js
{ swaps: [{ swap, role: 'maker' | 'taker', state: 'open' | 'accepted' | 'done' | 'cancelled',
            gives, gets, offer? }] }
```
`offer` is an open offer's text, to hand to a taker again.

### `leafSwapCancel({ swap })` — approval per request
Cancels a swap this site started. An offer frees its coins. An acceptance has the
taker's signatures in it, so the wallet spends the coins it signed to a fresh leaf of
its own, after which the acceptance can never complete; the library's answer says so,
or that the coins are already spent by the maker completing the swap.

`getCapabilities().features` carries `leaf-swaps` on builds that serve this section.

## Orders resting as leaves in the operator's tree (developer mode)

An order can rest as a leaf of the operator's tree: its maker rests it and leaves, and
takers fill it there, each fill one transfer in the tree that the operator co-signs and
the leaf's own program holds to the order's terms: the maker is paid at least its
price, in a leaf under one of four keys of the maker's wallet, and what a part fill
leaves rests again at a new coin under the same terms. The maker cancels it with the
operator. The relay lists such an order (offer member `resting_leaf`) only while the
operator's state view says it rests at the coin the listing names, holding what the
listing says, and follows it from coin to coin. These methods are refused in user mode,
and to a wallet that has joined no operator, with the same words as the other leaf
methods. BTC is never a leaf: both assets are Sequentia assets.

### `restOrder({ sell, amount, want, rate_num, rate_den, min_lot?, expiry?, max_fee_ppm? })` — approval per request
Rests an order selling `amount` atoms of `sell` for `want`, `rate_num` atoms of `want`
for every `rate_den` atoms sold (each fill's price rounded up), in fills of at least
`min_lot` atoms (the whole amount when left out). `amount × rate_num / rate_den` must be
a whole number of atoms: the listing states the order's whole price. `expiry` (unix
seconds, a median time; a week ahead of the chain's when left out) is when the order,
if its leaf is ever taken on the chain and lands as an on-chain order for the same
terms, may be refunded; the operator co-signs no fill within its order margin (six
hours) of it.

Before the window opens the library quotes the rest (`order_rest_quote`): the coins
given up, the fee (their refresh fee, in the asset sold) and the change. The window
shows what is given, what is got if filled whole, the smallest fill, the fee, the
change, the operator and the relay it is listed at; on approval the library rests the
order only on the fee and the coins shown. Returns the library's answer with the offer
id the wallet lists it under:
```js
{ order: '<participation id>', state, terms, amount, fee, gives, change, landed_pays, offer_id, note }
```
The next round makes the order's leaf. While its participation waits, the wallet syncs
every few seconds, so its forfeits go in as soon as the round is built; once the round
is final the library publishes the order to the operator, and the wallet lists it on
the on-chain relay by itself (after every sync), at the coin it rests at and what that
coin holds, signed with a key derived for that order alone, and posts it again before
the listing runs out while it rests. The wallet must stay open, unlocked, until then;
after that it may close, and takers fill the order while it is away. Each fill's credit
is the wallet's at its next sync.

### `fillRestingOrder({ order, amount? })` — approval per request
Fills `amount` atoms (all of what rests when left out) of an order resting in the tree
of the operator this wallet joined. `order` is the relay's offer of it, as served
(its `resting_leaf` member). Before the window opens the library quotes the fill from
the operator's own view of the order (`order_fill_resting_quote`): the coin it rests at
now, what the fill takes and pays, the fee (the fill transaction's margin, in the asset
paid), the coins given up, the change and what rests after. The window shows these,
the order and the operator; on approval the fill is made of the order as the quote
served it, only on what it showed. If another taker filled the order first, it rests at
another coin and the operator refuses the fill (`order_moved`), giving the coins back:
the wallet then asks for a new quote and fills the order where it rests now when that
takes the same amount at the same price for no more fee, and refuses otherwise. Returns:
```js
{ order, filled, paid, fee, change, gives, coin, answer: { transfer_id, coins }, moved_from?, refused_first? }
```
`moved_from` is the coin the order rested at when the window showed it, when it moved.
The leaf got is operator-confirmed, as any coin paid in the tree, and final once the
round the order rests on is final.

Refused before the window, besides the common ones: an offer without a `resting_leaf`
member, an order of another operator, and the library's quote refusals (a fill below the
lot, one leaving less than a lot, an order not resting, too few leaves of the asset paid
that expire no later than the order's coin).

### `cancelRestingOrder({ order })` — approval per request
Cancels an order this site rested from this wallet (`order`: its id). The library quotes
the cancel first (`order_cancel_resting_quote`): the coin it rests at, what that holds,
what comes back as a leaf of the wallet's own and the fee (the transfer's margin, in the
asset sold). The window shows these; on approval the coin is spent into that leaf, only
as quoted, and the wallet withdraws its listing from the relay (which delists the order
from the operator's view in any case). Fills made before stand. Returns
`{ order, state: 'cancelled', coin, transfer }`.

### `getRestingOrders()` — silent, requires connection and developer mode
The orders this site rested from this wallet, as the library and the operator show them:
```js
{ orders: [{ order, rested_by, offer_id, at, amount, state, coin, holds, fills_left, fills, credits,
             listed: { at, coin, relay_expires, maker_pubkey } | null, post_error }] }
```
`state` is the operator's (`resting`, `filled`, `cancelled`, `exhausted`, …), or the
library's while the order has no leaf yet (`participating`, `not_rested`). `credits` are
the leaves the wallet holds of the order's fills.

`getCapabilities().features` carries `resting-orders` on builds that serve this section.

## Events

Subscribe with `window.sequentia.on(event, handler)` and unsubscribe with
`window.sequentia.removeListener(event, handler)`; both return the provider:

- `accountsChanged` — `{ accounts: [] }` fires when the wallet locks (site
  should treat the session as suspended).
- `disconnect` — `{}` fires when the user revokes this site in Settings.
- `modeChanged` — `{ mode }` fires on every page when the user changes the
  wallet's mode (see "The wallet's mode").
- `leafArrived`, `leafSyncDue` — connected sites only (see "Leaf events").
- `leafTake` — the site that made a take, in developer mode (see "On-chain orders
  filled from leaves and placed from them").

The mode and leaf events reach a page through its tab, so a page that
subscribed keeps hearing them after the wallet's service worker has slept.

The provider also carries `isSequentia: true` and `network:
'sequentia-testnet'` as plain properties, readable without a request.

## Market and limit orders the wallet settles its own way

A site names a market, a side and an amount, and the wallet does the rest: it reads
the book itself, chooses which orders to take and how the trade settles, shows one
approval, and keeps the site's resting orders and trades. Nothing in these methods
names a rail, and they work the same in either mode, so a site in user mode needs
nothing else to trade. The wallet takes only orders it can settle in one step:

- **Between two Sequentia assets**: the covenant orders on the on-chain book (both
  ways round: an order selling the quote for the base, listed on the reversed
  market, is a bid). Each order taken is one transaction that pays its maker on the
  chain and this wallet in the same transaction, or does nothing; no maker has to be
  online. What the order holds is read from the chain, not from the relay's listing.
  What a limit order does not fill rests on the book as an order of the same kind,
  funded from this wallet at the limit price and listed on the relay by the wallet
  itself; it fills with the wallet closed, its maker credits count in the asset's
  figure and are moved into the wallet's own coins, and what is left of it can be
  taken back once its time has run out (a day after it is placed, by the chain's
  median time). Every fee is paid in the asset the wallet gives, never in another.
- **In developer mode, with an operator joined**: an order resting as a leaf in that
  operator's tree is one more order of the market. When the best of them prices at least
  as well as every covenant order and holds the whole trade, the trade fills it in the
  tree from the wallet's leaves (as `fillRestingOrder` does, one transfer the operator
  co-signs, its fee in the asset given), and nothing goes on the chain. In user mode the
  wallet does not take such an order.
- **Against BTC** (`quote: 'BTC'`): the quotes of makers who settle instantly over
  Lightning, through this wallet's own channels. Such a trade does not rest: a limit
  order against BTC trades what the book offers at the price or better, and the rest
  is not placed. A trade the wallet's channels cannot carry is refused before any
  approval, with what they hold.

### `placeOrder({ type, base, quote, side, amount, price? })` — approval per request

- `type`: `'market'` or `'limit'`.
- `base`: 32-byte hex asset id. `quote`: 32-byte hex asset id, or `'BTC'`.
- `side`: `'buy'` or `'sell'` of the base asset. `amount`: base atoms (decimal string).
- `price` (limit only): quote atoms per one whole base unit (10^precision base atoms),
  a decimal string; the limit order trades at that price or better and rests the
  rest exactly at it.

A market order goes no further than 5% past the best order on the book and takes at
most six orders; what the book does not reach near the best price is not traded, and
the approval says so. The approval lists what is given, what is got (now, and later
as others fill a resting order), the fees, and the resting order with when it can be
taken back, each amount also in the reference currency. Returns
`{ trade, filled, failed, order, order_error, gave, got }`: `filled` is how many orders
were taken (an order taken by someone else first is skipped, its error in `failed`, and
nothing of the wallet moves for it), `order` the id of the order left resting or
`null`. Refused before any approval: an unknown or unpriced asset, a market with
nothing to take, a limit order with no price, an amount and price too large to rest
together, a balance short of the trade and its fees, and a trade against BTC the
wallet's channels cannot carry.

### `getOrders()` — silent, requires connection

This site's resting orders and trades, and where each stands, read each time: how much
of an order has filled from the chain (the order followed from where it was placed,
through each spend that pays its maker), and whether each fill is final from the
relay's records of the chain:

```js
{ orders: [{ order, market: { base, quote }, side, price, at, amount, filled, holds, sell,
             state,            // 'placing' | 'open' | 'filling' | 'filled' | 'withdrawn'
             settled,          // every fill of it final
             take_back_from, take_back_from_text, can_take_back,
             fills: [{ txid, filled, credit, state, standing }], note }],
  trades: [{ trade, at, market, side, type, kind, order,
             state,            // 'sent' | 'settled' (| 'failed' for a trade against BTC)
             fills: [{ txid, base, quote, state }] }] }
```

`amount` and `filled` are in base atoms. A fill is `'settled'` only once the relay
calls it final (its block certified and its Bitcoin anchor buried); until then it is
`'sent'`, and a fill whose block leaves the chain is `'sent'` again. A trade against BTC
is `'settled'` when its swaps have. The wallet also lists, on each call, any order
whose funding has reached a block.

### `cancelOrder({ order })` — approval per request

Takes back what is left of one of this site's resting orders, once its time has run
out: the order leaves the book and its coins return to the wallet, the fee paid in
the asset it holds. Before then an order cannot be taken back by anyone, since the
chain lets only a taker paying its price spend it: the call is refused with the words
`this order can be taken back from <time> UTC; until then it stays on the book for anyone
to fill at your price`. Returns `{ order, txid }`.

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
