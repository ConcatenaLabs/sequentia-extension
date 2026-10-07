# Ambra for Chromium — the Sequentia browser extension wallet

A non-custodial Chromium (Manifest V3) extension wallet for the Sequentia
network and Bitcoin testnet4, built on [SWK](https://github.com/ConcatenaLabs/SWK)
(the Sequentia Wallet Kit).

Like every Sequentia wallet it is **dual-chain**: one BIP39 seed drives a full
Bitcoin testnet4 wallet and the Sequentia wallet side by side, and both chains
share the **same `tb1…` address** (Sequentia is transparent by default;
confidential `tsqb1…` addresses are an explicit opt-in).

## Features

- **Balances** — BTC (parent chain, always shown) plus every held Sequentia
  asset and OpenAMP restricted asset, one uniform row each, with a portfolio
  headline in a user-chosen reference currency. No asset is privileged; the
  Sequence token (tSEQ) is one row among equals.
- **Send / receive** — on-chain sends on both chains with any-asset fees
  (fee rates in the fee asset's own units per vByte), OpenAMP transfers with
  local sighash verification (never blind-signs), QR receive with the bare
  address as payload.
- **Transaction history** — Sequentia, Bitcoin, and restricted-asset transfers.
- **Lightning** — send and receive BTC and fee-priced Sequentia assets over
  the hosted SeqLN rail (Tier-2: keyless hosted nodes, this device co-signs
  everything; the LSP can route but never move funds), plus non-custodial
  move-to-Lightning / move-to-chain channel management.
- **Website connections** — injects `window.sequentia` so sites (the SeqDEX
  site at https://sequentiatestnet.com/dex/ among them) can connect, read
  balances, request signatures, and take or place DEX orders
  (`dexFillOnchain`, `dexSwapLn`, `dexMarketOrder`, `dexPlaceLimit`), behind
  per-origin permissions and per-request approval windows. A site can also work
  against the wallet's own OpenAMP account (`openampGetIdentity`,
  `openampSignTagged`, `openampSignSpend`, `openampSignSupervision`), so an
  issuance or transfer-agent platform uses the account the user already holds
  restricted assets in rather than a second identity generated in a browser tab.
  Protocol spec: [doc/PROVIDER.md](doc/PROVIDER.md).
- **Staking pool delegation** — the Stake tab lends an existing stake's weight
  to a pool, moves it to another pool, and takes it back. The staked coins
  never move. Delegating puts a small record on-chain (0.001 of the Sequence
  token, which leaving returns less its fee), and the network accepts that
  record only from a coin of the wallet's staking key, so joining is two
  transactions mined together: a payment from the wallet to its staking key,
  then the record created from that coin. If the second is refused, joining
  again reuses the payment.

Not included in the popup (use the [web wallet](https://sequentiatestnet.com/wallet)
or the desktop node wallet): creating or unbonding a stake, running a pool,
asset issuance, and a DEX trading UI.

## Security model

- The mnemonic is stored AES-256-GCM-encrypted under a password
  (PBKDF2-SHA256, 310k iterations) in `chrome.storage.local`; while unlocked
  the plaintext lives only in `chrome.storage.session` (memory-backed,
  extension-only, cleared when the browser exits). Auto-lock defaults to
  30 minutes.
- Sites never see the seed and cannot sign anything themselves; every
  signature request opens an approval window showing the decoded effect.
- OpenAMP transfers recompute every sighash locally from explorer-resolved
  prevouts and abort on any mismatch. This holds for spends a website asks the
  wallet to co-sign too: the site supplies the transaction, never a digest, and
  the wallet signs only what it recomputed and displayed.
- A website may only ever have a statement signed under a domain-separation
  tag, and never one naming a digest a consensus rule computes. The enclave key
  is half of a 2-of-2, and a digest signer over it would be a signing oracle
  that drains the account.

## Install (developer load)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this repository's root directory.

The wasm artifacts (`pkg/`, `vendor/lightning/pkg/`) are committed, so no
build step is needed to load the extension.

## Development

- Plain ES modules, no bundler, no framework (same constraint as the web
  wallet). The background service worker owns wallet state and routing; the
  popup and approval pages are thin RPC clients; long Lightning and DEX jobs
  run in a persistent offscreen document so a service-worker death cannot
  lose their outcome.
- Tests: `node --test 'test/*.test.mjs'`
- Staking against a private chain: `SEQUENTIAD=/path/to/sequentiad node
  test/regtest/stake-records.mjs block-one` (and `fork`) starts a regtest
  node, serves it through a small esplora stand-in (`test/regtest/esplora-shim.mjs`),
  and drives join, move and leave through the service worker's own message
  handlers, checking every transaction into a block.
- Service-worker console: `CHROME=/path/to/chrome node scripts/sw-console-check.mjs`
  loads the unpacked extension in a headless Chromium twice and fails on any
  exception or console error the worker raises. Run it after any change to a
  module or to `pkg/`.
- Icons: `node scripts/gen-icons.mjs`
- Rebuild the SWK wasm (needs the SWK checkout + clang):
  ```sh
  cd ../SWK/lwk_wasm
  CARGO_PROFILE_RELEASE_OPT_LEVEL=z wasm-pack build --target web --release --out-dir pkg_ext
  cp pkg_ext/{lwk_wasm.js,lwk_wasm.d.ts,lwk_wasm_bg.wasm,package.json} ../../sequentia-extension/pkg/
  ```

## Repository layout

```
manifest.json          MV3 manifest (module SW, wasm-unsafe-eval CSP)
background.js          service worker: message router, lifecycle, overview
src/                   engine (SWK wasm, dual-chain), vault, assets, openamp,
                       ln, dex, staking, permissions, provider router
offscreen.html/.js     persistent offscreen document: long Lightning and DEX
offscreen-boot.js      jobs (taker swaps, wallet-as-maker), survives SW death
content/               inpage provider (MAIN world) + relay (isolated world)
popup/                 wallet UI     approval/  site-request approval window
vendor/                modules copied from sequentia-web-wallet (btc.js,
                       seqln.js, seqln-keys.js, seqob.js, covenant.js,
                       covenant-order.js, covenant-fill-host.js,
                       noble-ciphers.js, lightning/ signer SDK)
pkg/                   SWK lwk_wasm build (committed)
doc/PROVIDER.md        the website provider protocol
```

Part of the Sequentia testnet ecosystem: https://sequentiatestnet.com
