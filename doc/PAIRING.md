# Pairing a site with a wallet in another window or on another device

`PROVIDER.md` is the one interface between a Sequentia website and a wallet: a method
name and its params in, a result or an error out, and a few named events. This document
says how that interface travels when the wallet is not injected into the page:

- **A wallet page of the same origin** (the web wallet, open in another tab or window):
  a `BroadcastChannel`.
- **A wallet on another device, or in an app on the same phone** (Ambra): Nostr Connect
  framing over a Nostr relay, paired by a QR code or a link.

Either way the wallet is the one that asks its owner. Every method the provider protocol
puts behind an approval is shown in the wallet's own window or screen, and nothing is
signed, paid or placed until its owner approves it there. A site sends method names and
reads answers; it never holds a key.

## Why these two, and not WalletConnect

The standards for pairing a website with a separate wallet were weighed for a chain the
standards do not know (Sequentia), Bitcoin, Lightning and a leaf wallet, all behind one
method set:

| | WalletConnect v2 (Reown) | Nostr Connect (NIP-46 framing) | Nostr Wallet Connect (NIP-47) |
| --- | --- | --- | --- |
| Methods | any JSON-RPC, namespaced by CAIP-2 chain ids | fixed to Nostr event signing | fixed to Lightning payments |
| Relay | Reown's hosted relay; a project id from Reown Cloud; no supported self-hosting | any Nostr relay; open-source relays run anywhere (nostr-rs-relay, MIT) | any Nostr relay |
| Encryption | its own (X25519, ChaCha20-Poly1305) | NIP-44 v2 (secp256k1 ECDH, ChaCha20, HMAC-SHA256) | NIP-44 / NIP-04 |
| Libraries | Apache-2.0 SDKs; some packages relicensed to non-permissive terms | nostr-tools (Unlicense) for the browser, rust-nostr (MIT) | same as NIP-46 |
| Fit | Sequentia is not a CAIP-2 chain; every pairing depends on a third party's service and account | transport fits; the method set is replaced | Lightning only |

WalletConnect's relay cannot be run by us and needs an account with its operator for
every site that pairs, which a sidechain whose point is to remove intermediaries cannot
make its pairing depend on. NIP-47 is Lightning-only. NIP-46's framing is a transport and
nothing else: an encrypted JSON-RPC message in an ephemeral event, addressed by key, over
any relay, with a pairing URI that carries the relay and a one-time secret. So the remote
case keeps NIP-46's framing, its URI and its encryption, and carries the methods of
`PROVIDER.md` in place of NIP-46's. Nothing else is built.

A wallet page of the same origin needs no relay: the browser already carries messages
between pages of one origin.

## Same origin: the `sequentia-wallet` channel

The site and the wallet page share an origin (for example `https://sequentiatestnet.com/dex/`
and `https://sequentiatestnet.com/`). Both open `new BroadcastChannel('sequentia-wallet')`.

```js
// site -> wallets            { type: 'hello', from }
// wallet -> site             { type: 'here', to, wallet, provider, mode }
// site -> one wallet         { type: 'request', id, from, wallet, page, method, params }
// that wallet -> site        { type: 'answer', id, to, ok: true, result } | { ..., ok: false, error }
// wallet -> sites            { type: 'event', event, data, wallet }
```

`from` is a random id the site's page picks; `wallet` a random id each open wallet page
picks. Every open wallet page answers `hello`; the site talks to one of them by its
`wallet` id from then on, and every other wallet page ignores the request. `page` is the
site's address (`location.href` without its query), shown in the wallet's approvals. A
request with no `wallet` is answered only for `getWalletMode` (the mode, read by every
page of the origin).

The wallet page serves the methods of `PROVIDER.md` it lists in its `getCapabilities`
over the channel. `connect` shows the wallet's own approval ("SeqDEX at … wants to see your
balances and ask you to trade"); until it is approved, every other method but
`getCapabilities`, `getWalletMode` and `getAccounts` (an empty list) is refused with
`this site is not connected; call connect first`. The approval lasts while that wallet
page is open. Every method `PROVIDER.md` puts behind an approval opens the wallet page's
dialog, and the site's request waits for the answer.

A page of the same origin can read the same storage as the wallet page; the channel's
approvals guard against a page asking for something its owner did not mean to do, not
against code the origin itself serves. Serve nothing on a wallet's origin that you would
not let hold the wallet.

## Another device: Nostr Connect framing

### Pairing

1. The site makes a key pair for this pairing (`client`) and a random secret, and shows
   the pairing URI as a QR code, and as a link for a wallet app on the same phone:

   ```
   nostrconnect://<client pubkey, 64 hex>?relay=<wss url>&relay=<wss url>&secret=<hex>
     &name=<site name>&url=<site origin>&protocol=sequentia-provider-1
   ```

   `protocol=sequentia-provider-1` says the methods are `PROVIDER.md`'s, not NIP-46's; a
   wallet that does not serve them refuses the URI rather than answer as a Nostr signer.

2. The wallet scans or opens it and shows its owner what pairs: the site's `name` and
   `url`, said to be the site's own claim (any page can put any `url` in a QR code, so the
   wallet shows it as "says it is", and the owner checks it against the page in front of
   them). On approval the wallet makes a key pair for this pairing (`wallet`) and sends,
   on every relay the URI names, one event to the client:

   ```js
   { kind: 24133, pubkey: <wallet>, tags: [['p', <client>]],
     content: nip44(<wallet> -> <client>, JSON.stringify({ id: <random>, result: <secret> })) }
   ```

3. The site accepts the first such event whose decrypted `result` equals its secret, and
   from then on talks to that `wallet` key only. The secret is single-use: the site
   drops it once paired, and a second event carrying it is ignored.

The pairing is the `connect` of `PROVIDER.md`: the wallet's approval of the pairing is
its owner's approval of the site's connection. The site keeps its client key and the
wallet's key in the browser so a reload resumes the pairing; the wallet keeps its key and
the client's per paired site until its owner forgets the site, or the site sends
`disconnect`.

### Requests, answers and events

Every message is a kind-24133 event (ephemeral: relays forward it and keep nothing),
signed by its sender (NIP-01), its `content` NIP-44 v2 encrypted to the other side, and a
`p` tag naming the other side's key:

```js
// site -> wallet     { id, method, params }        // params: the PROVIDER.md object
// wallet -> site     { id, result } | { id, error }
// wallet -> site     { event, data }               // PROVIDER.md events; no id
// either -> other    { event: 'disconnect' }
```

`id` is a random string per request. Each side takes events only from the key it paired
with and addressed to its own key, decrypts them, and drops anything it cannot. The
wallet ignores a request whose `created_at` is more than five minutes from its clock, and
a request `id` it has answered before; the site ignores an answer whose `id` it is not
waiting on. A request behind an approval is answered when its owner approves or rejects
it, or with `the user rejected the request` when the wallet's approval lapses (five
minutes); the site waits that long. A wallet that is not running answers nothing: the
site says so and keeps the request open no longer than its timeout.

### Relays

Any Nostr relay that forwards kind 24133 serves. A site names one or more in the URI, and
both sides publish to each and listen on each. A relay sees the two keys, the times and
the sizes of messages, and nothing of what they say. A site that wants that metadata kept
to itself runs its own relay (nostr-rs-relay or strfry behind its web server) and names it
first.

## What a wallet serves

Every connector implements the same interface: the methods a site may call are the ones
the wallet lists in `getCapabilities().methods`, with `PROVIDER.md`'s params, answers,
refusals and approvals. A site groups them into what it offers (the extension's
`getCapabilities` is the full list; a wallet reached through a channel or a relay
typically serves the account and the market:
`connect`, `getAccounts`, `getBalances`, `getWalletMode`, `placeOrder`, `getOrders`,
`cancelOrder`).
