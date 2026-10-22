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
  Sequence token (tSEQ) is one row among equals. Each asset's figure counts
  everything of it the wallet holds, in both modes: on-chain, leaves, Lightning
  (the wallet's share of its own channels, reserve included) and, for tSEQ,
  what is staked (each stake of the wallet's key under either lock, each
  unbonding output not yet withdrawn, and the delegation record); the headline
  is the sum of every figure. User mode shows that one figure per asset, and a
  tap on a row opens its parts in plain words (On-chain, Off-chain, Lightning,
  Staked); developer mode names every rail under the row, with the controls that
  move an asset to and from Lightning.
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
  balances, request signatures, and trade: a market or limit order the wallet
  settles its own way (`placeOrder`, with the site's resting orders and trades in
  `getOrders` and a resting order taken back by `cancelOrder`), or an order of one
  room taken by hand (`dexFillOnchain`, `dexSwapLn`, `dexMarketOrder`, `dexPlaceLimit`), behind
  per-origin permissions and per-request approval windows. A site can also work
  against the wallet's own OpenAMP account (`openampGetIdentity`,
  `openampSignTagged`, `openampSignSpend`, `openampSignSupervision`), so an
  issuance or transfer-agent platform uses the account the user already holds
  restricted assets in rather than a second identity generated in a browser tab.
  A site can ask for a spend of a contract (`signContractSpend`), with the
  wallet's own coins and a foreign coin beside the contract's (a Pignus take,
  repayment or top-up, which the wallet funds), a capped sale's purchase signed
  with the wallet's contract key as the buyer's, or an escrow's release of many
  coins signed with it as the issuer's (`getContractKey` names the key, and
  `signContractStatement` proves it to a platform): the kit's contract engine
  builds and checks it, the approval window shows the template, the path, the
  parameters, every input and the wallet's balance change, and the wallet
  signs only what it showed.
  Protocol spec: [doc/PROVIDER.md](doc/PROVIDER.md).
- **Mode, and leaves** — one setting (Settings → Mode), kept for each wallet.
  User mode: one figure per asset, and the wallet chooses how value moves.
  Developer mode: every rail by name, side by side (on-chain, leaves and
  Lightning), each with its balance and its manual controls, and the developer
  tools. Sites read it (`getWalletMode`, the `modeChanged` event) and follow it.
  In developer mode the wallet can join an operator (joining restores what the
  operator holds of this phrase's leaves, wherever they were made) and hold Sequentia assets as
  leaves of the operator's tree, paid and received off the chain: a site reads
  the leaf balances (`getLeafBalances`) and the leaf wallet's address
  (`getLeafAddress`), asks for a receive request (`requestLeafReceive`), a
  payment to one (`sendLeaves`), a board (`boardLeaves`) or an exit
  (`exitLeaf`), each behind the approval window, the board's and the exit's fees
  shown before anything is signed, and hears `leafArrived` and `leafSyncDue`.
  A site's on-chain room fills an on-chain order from leaves through the
  operator's round (`takeOrder`) and places an order on the chain from leaves
  (`placeOrderFromLeaves`); the wallet hands a take's forfeits over and lists an
  order on the relay by itself, with no window open, and reports where each
  stands (`getLeafTakes`, `getLeafOrders`, `leafTake`). Two wallets that hold
  leaves swap two assets in one reassignment in the tree: one offers
  (`leafSwapOffer`), the other accepts (`leafSwapAccept`) and the first completes
  (`leafSwapComplete`), each window showing what is given, got and paid before
  anything is signed (`getLeafSwaps`, `leafSwapCancel`). An order rests as a leaf
  in the operator's tree (`restOrder`): the wallet hands its forfeits over, lists it on
  the relay once the operator holds it, and may then close while takers fill it in the
  tree (`fillRestingOrder`, or the default view's `placeOrder`, which takes such an
  order in developer mode when it holds the best price); its maker cancels it
  (`cancelRestingOrder`) and reads it back with its credits (`getRestingOrders`). The leaf wallet runs in the offscreen document and syncs on its own schedule
  while the browser runs and the wallet is unlocked, in either mode once an
  operator is joined; leaves count in each asset's figure and in the headline in
  both modes. BTC is never a leaf: it stays on its own chain and on Lightning.
- **Supervised assets** — an asset whose issuer can freeze holdings by a rule of
  the chain is held, received and paid like any other and counted in its one
  figure. The leaf wallet holds it only as leaves whose way out of the tree pays
  the wallet's own landing key (the phrase's first on-chain key), which the
  library makes and checks by itself. When the issuer freezes that key or pauses
  the asset, the frozen part shows under the asset's figure in either mode, as one
  sentence ("… is frozen by its issuer: it can't be sent until the issuer lifts
  the freeze"), never hidden; a send of it is refused, in user mode in plain
  words ("This asset is frozen by its issuer for this wallet: nothing was sent.").
  Developer mode shows each leaf's landing and whether it is frozen, with the
  library's note; such a leaf leaves the tree only into the landing key, where the
  coin stays frozen on the chain until the issuer lifts the freeze. The operator
  serves no take, resting order or Lightning payment in such an asset, so a market
  of one is never filled from the operator's tree.
- **Issuer-operated assets** — the operator may serve an asset issuer-operated:
  the issuer mints each round's float through the asset's mint limiter, and every
  batch's sweep can only burn. The library checks each new leaf against that
  profile by itself. Developer mode shows each leaf's batch profile under Leaves
  and their dates (`issuer-operated` or `open`) and, for each asset the operator
  serves issuer-operated, **Supply**: the operator's report of what it minted,
  burned and holds under burn-only sweeps, each mint and burn read again from the
  wallet's own node. It checks the transactions the report lists; it does not
  prove the list complete. User mode shows none of it.
- **The operator's bond** — the operator posts an equivocation bond: two
  different messages its key signs under one coin's salt prove it signed twice,
  and burn the bond whole. At the pace of the wallet's own upkeep (below), in
  either mode, the leaf wallet reads the bond (once it has seen it bonded, it
  requires it from then on) and runs the library's `watch_bond`, which checks the
  wallet's own evidence against the chain and the mempool and sends the slash
  itself should the operator key have signed twice. The library's gate does the
  rest: a receive or a swap is refused while the bond is missing or in notice, or
  when what the wallet would hold out of round is worth more than it. Nothing is
  said while the bond stands; such a refusal reads, wherever user mode shows one,
  "Not accepted: the security deposit that backs these instant payments is missing
  or being withdrawn, so this wallet takes no payment that rests on it. Nothing was
  signed." Developer mode shows the bond (its asset and value, state, coin, when it
  can be withdrawn, whether this wallet requires it, whether it covers what the
  wallet holds out of round) and the last watch, with **Watch now**.
- **What the wallet does by itself** — once an operator is joined, in either
  mode and with no prompt: after a sync, at most every ten minutes and once when
  the leaf wallet opens, it takes up every claim of a distribution named for one
  of its addresses (the asset then counts in its figure), signs a refresh plan
  for every leaf of a round so that a wallet closed across that leaf's expiry
  keeps it, whenever it closes, cancels the plan of a leaf that moved, and sends
  a leaf no round made into a round's refresh once that refresh could run within
  ten days, so it can be planned later. A plan's fee comes out of the leaf in the
  leaf's own asset; a leaf the operator will not plan is refreshed while the
  wallet is open instead. A planned leaf is paid out of round by no wallet, so a
  payment, take, swap, order or fill that the unplanned leaves cannot cover is
  made through the next round, by itself: the wallet gives the planned leaves it
  needs up in that round for leaves no plan names (which `care` leaves unplanned
  for a day, so they can be paid), waits until the round is final, and asks again. The person waits one round and sees nothing else.
  Developer mode shows the last run, the plans with Cancel and Release (the
  plan's leaf given up in the next round), each planned leaf marked under
  Leaves and their dates, and "Paying through the next round" while a payment
  waits.
- **Stakes** — the Stake tab lists every stake of the wallet's staking key,
  whichever wallet bonded it (the web wallet bonds with a lock of 43,200 blocks,
  Ambra with a time lock of 2,532 units of 512 seconds, about 15 days), found on
  the chain from the phrase alone. A stake can be unbonded once its lock has
  passed, the fee out of the stake and never above 1% of it; it stops counting
  as stake at once, and once the chain is anchored 2,016 Bitcoin blocks past the
  unbond it can be withdrawn into the wallet. Each step is reviewed in the popup
  before the transaction is built and signed, and broadcast only if it moves
  what the review showed.
- **Staking pool delegation** — the Stake tab lends an existing stake's weight
  to a pool, moves it to another pool, and takes it back. The staked coins
  never move. Delegating puts a small record on-chain (0.001 of the Sequence
  token, which leaving returns less its fee), and the network accepts that
  record only from a coin of the wallet's staking key, so joining is two
  transactions mined together: a payment from the wallet to its staking key,
  then the record created from that coin. If the second is refused, joining
  again reuses the payment.

Not included in the popup (use the [web wallet](https://sequentiatestnet.com/wallet)
or the desktop node wallet): creating a stake, running a pool, asset
issuance, and a DEX trading UI.

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

The wasm artifacts (`pkg/`, `leaves/pkg/`, `vendor/lightning/pkg/`) are
committed, so no build step is needed to load the extension.

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
  handlers, checking every transaction into a block. `SEQUENTIAD=/path/to/sequentiad
  node test/regtest/stake-unbond.mjs` bonds a stake under each lock, lists both,
  sees an early unbond refused by the wallet and by the node, moves the chain's
  clock and height past both locks, unbonds and withdraws both through their
  reviews, and checks each transaction into a block.
- A contract spend against a private chain: `SEQUENTIAD=/path/to/sequentiad
  SWK_TEMPLATES=/path/to/SWK/lwk_contracts/templates CHROME=/path/to/chrome node
  test/regtest/contract-spend.mjs` asks for a faucet drip through the provider
  router, reads and decides the approval through the worker's own messages,
  renders the approval page, confirms the drip, and checks each refusal.
- A Pignus version 2 loan against a private chain: `SEQUENTIAD=/path/to/sequentiad
  PIGNUS_WEB=/path/to/pignus/web CHROME=/path/to/chrome node
  test/regtest/pignus-v2.mjs` runs the Pignus page in a headless Chromium with
  its `window.sequentia` bridged to the provider router, takes an offer, tops
  up and repays from the page, renders and clicks each approval page, confirms
  each spend, and checks the refusals. Its chain is anchored to a regtest
  parent run by the same binary, since the kit reads anchored headers.
- A Pignus loan of three oracles with a threshold of two, the same way:
  `SEQUENTIAD=… PIGNUS_WEB=… CHROME=… node test/regtest/pignus-threshold.mjs`
  takes a 2-of-3 offer from the page, then asks through the page's provider
  for the liquidation under a record two oracles signed, both signers' beacon
  coins spent and recreated; it checks that one signature is refused before
  any approval opens. It needs `python3` for the oracles' keys and signatures
  (Pignus's vendored `sequentia_oracle` module).
- A capped sale bought from Levo's sale page: `SEQUENTIAD=/path/to/sequentiad
  LEVO=/path/to/levo CHROME=/path/to/chrome node test/regtest/levo-capped.mjs`
  runs the real levod and its built page (`web/dist`) on such a chain, lists a
  capped sale with `bin/levo` with this wallet's contract key on its list, buys
  from the page through the router and the approval page, confirms each
  purchase, and checks that a purchase past the cap is refused before any
  approval opens.
- A SeqPal issuer's escrow opened and released from SeqPal's issuance page:
  `test/regtest/seqpal-issuer.mjs open|release`, run by SeqPal's own regtest
  drive (`scripts/regtest-escrow.sh` with `ISSUER_PAGE` set to it), which holds
  the chain, seqpald and the subscribers.
- Service-worker console: `CHROME=/path/to/chrome node scripts/sw-console-check.mjs`
  loads the unpacked extension in a headless Chromium twice and fails on any
  exception or console error the worker raises. Run it after any change to a
  module or to `pkg/`.
- A site's market and limit orders (`placeOrder`, `getOrders`, `cancelOrder`) on a
  private chain anchored to a regtest parent, with a local on-chain relay
  (`seqobd` from the `seqdex` repository) watching it:
  `SEQUENTIAD=/path/to/sequentiad SEQOBD=/path/to/seqobd node
  test/regtest/market-orders.mjs [evidence-dir]` runs them through the provider
  router with the approvals decided as the approval page decides them (a resting
  order, a market order filling part of it, a limit order filling the rest, the
  maker's credits, an order taken back after its time, and the refusals);
  `CHROME=/path/to/chrome SEQUENTIAD=… SEQOBD=… SEQDEX_WEB=/path/to/seqdex-web node
  test/market/drive.mjs <evidence-dir> <work-dir>` drives the same through the SeqDEX
  site's default view in headless Chromium, two profiles, the extension copied into
  the work directory with its engine on the private chain's network, every endpoint
  served at https://sequentiatestnet.com by a stand-in box (`test/market/box.mjs`).
- A site using the leaf methods, end to end in a headed Chromium:
  `CHROME=/path/to/chrome ARCA_OPERATOR_CONTROL=127.0.0.1:18640
  ARCA_CLI=/path/to/arca node test/leaves/drive.mjs <evidence-dir> <work-dir>`
  needs the `arca` repository's operator harness running
  (`bark-cli/tests/arca_operator_for_browsers.rs`, started fresh for each run)
  and its command-line wallet as the counterparty. The test site
  (`test/leaves/site.html`) follows the wallet's mode (its leaf features show
  only in developer mode, and follow `modeChanged`), connects, reads the leaf
  balances and address, asks for a receive request, a send, a board and an exit
  through the approval window, and hears the events; every step is a DOM assertion and a screenshot, every console line of
  the extension's contexts is logged, and an error from any of them fails the
  drive.
- What the wallet does by itself with leaves, the same way:
  `CHROME=/path/to/chrome ARCA_OPERATOR_CONTROL=127.0.0.1:18640
  ARCA_CLI=/path/to/arca node test/leaves/care-drive.mjs <evidence-dir> <work-dir>`
  has the command-line wallet distribute an asset to three holders, the
  extension's wallet one of them by the key of its receive address, sees the
  claim taken up with no click and counted in the popup's one figure in user
  mode, moves the chain's median time until the claimed leaf (a leaf of no round)
  is within ten days of its refresh and sees it sent into a round, sees the
  round's leaf planned at once and listed in developer mode with Cancel and
  Release, releases it into the next round and cancels the next plan, and checks
  that the user-mode screens carry none of the developer words
  (`DEVELOPER_WORDS` in `src/balance-view.js`).
- One phrase's whole balance, read where another wallet put it: `CHROME=…
  ARCA_OPERATOR_CONTROL=… TOTAL_PHRASE_FILE=… [WEB_TOTALS=…/totals.json] node
  test/leaves/total-drive.mjs <evidence-dir> <work-dir>` opens the phrase the web
  wallet's `tooling/total-drive.mjs` funded (on-chain coins, leaves, a Lightning
  channel, stakes under both locks), joins the same operator and restores its
  leaves, and reads the popup's one figure per asset and its headline in user mode,
  beside the web wallet's. It reads only, through a stand-in box at
  https://sequentiatestnet.com (an esplora shim over the harness's node, prices,
  fee rates, the registry, and the LSP's `/status` with one channel).
- An in-tree swap through the provider, end to end:
  `HEADLESS=1 CHROME=/path/to/chrome ARCA_OPERATOR_CONTROL=127.0.0.1:18640
  ARCA_CLI=/path/to/arca node test/leaves/swap-drive.mjs <evidence-dir> <work-dir>`,
  with the same harness and the command-line wallet as the other wallet. The test site
  accepts the command-line wallet's offer (`leafSwapAccept`), then offers one of its
  own, rejects it once (the offer is cancelled), offers it again and completes it with
  the command-line wallet's acceptance (`leafSwapComplete`); each window is checked and
  shot, both wallets' leaves are checked after each swap, and in user mode every swap
  method is refused before any window.
- The SeqDEX site's leaves room, end to end in headless Chromium:
  `CHROME=/path/to/chrome ARCA_OPERATOR_CONTROL=127.0.0.1:18640
  SEQOBD=/path/to/seqobd SEQDEX_WEB=/path/to/seqdex-web node test/leaf-room/drive.mjs
  <evidence-dir> <work-dir>` needs the `arca` repository's operator harness running
  (`bark-cli/tests/arca_operator_for_browsers.rs`, started fresh for each run) and
  SeqDEX's relay binary (`seqobd`, from the `seqdex` repository), which the drive
  starts itself, following the operator. Two browser profiles, a maker and a taker,
  reach the site, the relay, the operator and its node at https://sequentiatestnet.com
  through a stand-in box (`test/leaf-room/box.mjs`, a throwaway certificate). The
  maker places an order from leaves through the room; the taker fills part of it from
  leaves, closes the popup and restarts the browser inside the forfeit window, and the
  wallet hands its forfeits over once unlocked; the fill reaches final, an anchor
  rollback undoes it, and it is final again once mined again; a full fill of the rest
  is not offered while it is not final. Every state is a DOM assertion and a
  screenshot, and the service worker's console is read after every start.
- Orders resting in the operator's tree, end to end in headless Chromium: `CHROME=…
  ARCA_OPERATOR_CONTROL=127.0.0.1:18640 SEQOBD=/path/to/seqobd
  SEQDEX_WEB=/path/to/seqdex-web node test/resting/drive.mjs <evidence-dir>
  <work-dir>`, with the same harness, relay binary and stand-in box as the leaves room's
  drive, and three profiles. The maker rests three orders through the leaves room and
  closes its browser once the relay lists them; a taker buys part of one from the
  site's default view, where it is one more order of the market; a second taker's fill
  is shown, the first fills the order again before it is approved, and the operator's
  `order_moved` is answered by a fill where the order rests now; the default view takes
  the rest. The relay's refusals are posted to it directly (a locator the operator does
  not report, a value above what the leaf holds, a filled order, an order past its delist
  time, a cancelled order); the maker's wallet, opened again, holds every credit and
  cancels the last order; user mode refuses every method before any window.
- Icons: `node scripts/gen-icons.mjs`
- Rebuild the SWK wasm (needs the SWK checkout + clang):
  ```sh
  cd ../SWK/lwk_wasm
  CARGO_PROFILE_RELEASE_OPT_LEVEL=z ./build-web.sh pkg_ext   # build paths remapped
  cp pkg_ext/{lwk_wasm.js,lwk_wasm.d.ts,lwk_wasm_bg.wasm,package.json} ../../sequentia-extension/pkg/
  ```
- Rebuild the leaf wallet (`leaves/pkg/`, the `arca` repository's
  `wallet-wasm/`; needs the wasm32 target, `wasm-pack` and `protoc`):
  `scripts/build-leaf-wallet.sh ../arca`. Build paths are remapped, and the
  script refuses to copy a package that still names the build machine.

## Repository layout

```
manifest.json          MV3 manifest (module SW, wasm-unsafe-eval CSP)
background.js          service worker: message router, lifecycle, overview
src/                   engine (SWK wasm, dual-chain), vault, assets, openamp,
                       ln, dex, staking, permissions, provider router
offscreen.html/.js     persistent offscreen document: long Lightning and DEX
offscreen-boot.js      jobs (taker swaps, wallet-as-maker), survives SW death
offscreen-leaves.js    the leaf wallet's host in that document: its worker,
                       its schedule, its events
leaves/                the leaf wallet's worker and its wasm (committed)
content/               inpage provider (MAIN world) + relay (isolated world)
popup/                 wallet UI     approval/  site-request approval window
vendor/                modules copied from sequentia-web-wallet (btc.js,
                       seqln.js, seqln-keys.js, seqob.js, covenant.js,
                       covenant-order.js, covenant-fill-host.js,
                       noble-ciphers.js, contracts.js, bolt11.js,
                       lnupgrade.js, own-txs.js, lightning/ signer SDK)
pkg/                   SWK lwk_wasm build (committed)
doc/PROVIDER.md        the website provider protocol
```

Part of the Sequentia testnet ecosystem: https://sequentiatestnet.com
