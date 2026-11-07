# CLAUDE.md — sequentia-extension

Chromium MV3 extension wallet for Sequentia + Bitcoin testnet4, built on SWK's
wasm. Read this before changing anything.

## First principles this repo must never violate

1. **Dual-chain, one address.** BTC (testnet4) is a first-class asset; the
   default unblinded Sequentia address IS the Bitcoin address (`tb1…`).
   Never add a Sequentia-only mode.
2. **No privileged asset.** tSEQ is one row among equals; no "native asset"
   labels, headline = portfolio total in the reference currency; a fresh
   wallet shows only a 0 BTC row (zero-balance assets hidden, BTC excepted).
3. **Fee rates are correct as-is.** Fees payable in any priced asset; rate
   units are the fee asset's OWN units/vByte, never "sat/vB" (BTC sends
   excepted). NO 1:1 fallback for unpriced assets — `feeRateFor` throwing is
   the design, not a bug.
4. **Transparent by default.** Confidential (`tsqb1…`) is opt-in per call.
5. **Never blind-sign.** OpenAMP transfers recompute sighashes locally and
   abort on mismatch; dapp PSETs show their decoded effect before signing.

## Architecture invariants

- **`withWollet` is load-bearing** (src/engine.js): wasm-bindgen forbids
  re-entrant `&mut` use; every scan and build→broadcast must go through the
  queue. The message-driven service worker has MORE concurrency than the web
  wallet page had, not less.
- **Own-tx ring**: after every `applyUpdate`, recent own broadcasts the scan
  did not return are re-applied (a stale backend Update otherwise reverts them
  and later builds re-select spent inputs). Never one the wollet already holds:
  the kit would make spendable again a change output spent since by the leaf
  wallet or another device (`vendor/own-txs.js`).
- **Scan cache**: IndexedDB persists exactly ONE kind of Update — one computed
  against an EMPTY wollet (from a throwaway scan), aged out weekly. Never
  persist a mid-session incremental update.
- **The leaf wallet lives in the offscreen document** (`offscreen-leaves.js`,
  its worker `leaves/worker.js`), never in the service worker: the library
  blocks on synchronous requests, which only a dedicated worker may make. Its
  store (SQLite on the extension's private file system) admits one worker at a
  time. The worker opens it only while the wallet is unlocked and has joined
  an operator, in either mode (its coins have dates to keep); locking closes it.
  User mode shows nothing of leaves and no provider method or leaf event reaches
  them; the host reports the balance (`leafBalance`) so each asset's figure and
  the headline count leaves in both modes. Each figure is on-chain + leaves +
  Lightning (`ln.balanceFor`: `balance_units`, else `spendable_units`) + staked
  (the Sequence token only, `staking.stakedSum`), in both modes
  (`src/balance-view.js`); user mode shows it with no rail controls, its parts a
  tap away in plain words that carry none of `DEVELOPER_WORDS`. The mode and the operator joined are
  kept for each wallet, by the descriptor's tag (`src/mode.js`, the web wallet's
  tag). The mode's words are the same in the web wallet and Ambra: change them in
  all three together. A take of an on-chain order and an order placed from leaves
  (`src/leaf-trade.js`, records in `src/leaf-orders.js`) are carried on with no window
  open: the host syncs every few seconds while a take waits on its forfeits, and the
  service worker lists an order on the relay once the library says it rests. Both run in
  either mode once started; only what a site sees follows the mode. An order resting in
  the operator's tree (`src/leaf-resting.js`) is carried on the same way: the host syncs
  for its participation as for a take, and the service worker lists it on the relay once
  the operator holds it. An in-tree swap
  (`src/leaf-swap.js`) keeps only which site started which swap and what the library
  answered when it did; the host follows a coin held for a swap ('offered') until the
  other wallet completes it, so its mailbox is read. Mode and leaf events reach
  pages through `chrome.tabs.sendMessage` to the content script, not the
  service worker's ports, which die when it sleeps.
- **Default mode is the web wallet's contract** (its `docs/DEFAULT_MODE.md`): the
  words and route rules come from the vendored modules, never rewritten here, and
  every default-mode screen is tested against `forbiddenIn` (`vendor/user-trade.js`).
  `src/default-mode.js` (service worker) joins the operator pinned in
  `src/config.js` (`ARCA`) by itself in user mode, after its server and then the
  wallet's own answer show the pinned key; makes the receive code (New code's address by
  `vendor/receive-index.js`, the Confidential switch's confidential address, an asset
  amount's `lightning_receive` invoice, a payment name's LNURL-pay); asks the faucet
  and takes its coin in by a mailbox read (the host's `takeIn`), never a whole sync;
  and routes each send (code → the tree, address → the chain else `offboard`,
  invoice → Lightning, BTC → the ark first; a confidential address → the chain, its amount
  hidden beside a blinded output to the wallet's own confidential address, a round amount first
  moved out of the tree while the popup says so and asks again, `vendor/confidential-pay.js` and
  `src/confidential-send.js`). The leaf host boards on-chain assets
  and reads the mailbox every 10 s in default mode (`defaults`). The payment name's link with the name service
  (`vendor/lnaddr.js` `mountLnAddress`) lives in `offscreen-ark.js` beside the ark that makes
  its invoices; it leaves the name's stock of signed receive codes with the service and tops it
  up (`vendor/name-stock.js`), each code made by the service worker at the index the stock picks
  (`default.nameCode`, from `default.nameIndices`). Receive shows the name as the QR code when the
  wallet has one (`receiveCode` `isName`, words in `src/receive-view.js`); Send checks a name's code
  against the name's key and the key kept from paying it before (`namePins`). BTC lives on the
  Bitcoin ark in the offscreen document (`offscreen-ark.js`, scope `ark`), open in
  both modes so its BTC is in BTC's figure; it boards the wallet's confirmed tb1
  coins in default mode, signed in that document with the phrase's own keys, within
  the limits the ark's server publishes (`info`, op `info`) and the web wallet's band
  (`vendor/ark-limits.js`, applied by `src/ark-band.js`, the service worker's `boardBtcSoon`,
  `moveDownSoon` and `receiveCode`): refilled only below a quarter of its resting level, the
  excess over it moved to the wallet's address once it holds the ceiling, and a payment of the
  band's `direct` figure or more sent to the address, never into the ark. One Lightning payment
  is held to the operator's published `max_payment` (`vendor/asset-lightning.js`
  `lnMaxPayment`), else to 1,500 USD; the figures are the web wallet's and never decided here
  (a test may set `ext.arkLimits` in local storage). The
  popup's composer reaches the leaf library (`default.leaf`) and the ark's
  Lightning (`default.ark`) through the service worker. What the wallet's own
  Lightning channels hold moves to the ark and the tree by itself in default mode
  (`src/ln-to-ark.js`, on the `leafHost` alarm, over the vendored move); the overview
  counts it in the figure while it moves (`moving`). BigInt crosses as
  `{ $big }` (`src/wire.js`). Remove wallet closes the leaf and ark wallets before
  the vault goes.
- **Every coin goes home without the operator.** The host notes whether the operator
  answers from each sync's `unreachable`; while it does not, `status` carries `home`
  (`{ unreachable, offer, onWay }`) and the popup's Balance shows the web wallet's card
  and review in both modes (`leaves.home`, `leaves.homeQuote`, `leaves.takeHome`).
  Quoting and sending are `homeQuote`/`homeTake` of `vendor/default-arca.js`, run by the
  host on the library: each exit is broadcast only on the fees its quote showed. Developer
  mode's Exit drill is per leaf (`leaves.exitQuote`, `leaves.exit`).
- **Channels are the library's, read by the host.** `care` runs with `channels`
  (`careArgs`), so the library opens a channel leaf in each asset the operator makes them
  of, reads it and folds its credit. In default mode the host reads the channels
  (`channel_sync`) every 300 ms while the popup is open (its `seq-ui` port, op `inUse`) and
  the wallet was used, opened or paid within three minutes, else every 5 s, never while
  another command runs, and never while a send review is open (`holdReads`); a channel paid
  reports the balance at once. When the channels a payer can pay change it sends
  `channelsChanged`, and the receive code is made again to name them (`codeNamesChannels`).
  Which channel pays, and every refusal, is the library's (`send` routes over a channel by
  itself when the receive code names one).
- **A person waiting comes first.** The host keeps one command in the leaf worker at a
  time and holds the rest in its own queue (`src/leaf-queue.js`): a command a person
  started (`run` with `paying`) goes ahead of every upkeep command waiting, and the
  faucet's coin taken in (`takeIn`) ahead of upkeep too, so each waits at most for the one
  command already running. A read the trade composer asks while nobody waits on it (it
  follows open trades every few seconds) is the wallet's own work instead: it goes in line
  with the upkeep and does not count as a person asking, so it never keeps the mailbox and
  channel reads off. The scheduled pass gives way between its commands while a
  person waits, starts no sooner than 15 s after a person's last command (put off 90 s at
  most, never while a take waits), and leaves the bond's watch to a later pass when a person
  is waiting. While the popup's trade composer prices or confirms a trade it also holds the
  upkeep (`default.holdUpkeep`, op `holdUpkeep`, at most two minutes, let go when the step
  ends). A sync the composer asks for (it follows open trades with one) waits while a
  person waits, and one asked within 10 s of the last sync's end is answered by that sync;
  a quote that finds coins not ready asks for one at the next quiet moment (`syncSoon`).
  Between the pass's commands the host reads the mailbox and the channels when they are
  due, so a payment to the receive code is not held up behind a whole pass. Every command
  over 10 s is logged with what it waited, and a slow sync names its slowest steps
  (`cost_by_step`). A command still running after 10 minutes ends the worker: every command
  waiting fails at once, and the leaf wallet opens again at the next request.
- **Care is the library's, run by the host.** The offscreen host runs `care` once
  after the leaf wallet opens and after a sync at most every ten minutes
  (`careDue`, `src/leaf-schedule.js`, the web wallet's rules), in either mode,
  with `scan` = the kit wallet's next receive index + 20 (`claimScan`; the
  service worker tells the host through `ensureRunning`) and the library's own
  planning reach: a leaf of a round is planned once its refresh could run within
  ten days (`careArgs`). Which claim to take, which coin to
  plan, its fee and every refusal are the library's; never decide one in
  JavaScript. Every leaf command a person or a site starts goes through one path:
  `leaves.run` asks the host with `paying`, and the host's `payThrough`
  (`src/leaf-schedule.js`) answers a refusal of kind `planned` with
  `plan_release` of the coins it names, syncs until that round has freed them,
  and asks again. The host carries that wait, so it outlives the service worker.
  Keep that one path; `runAny` (the work carried on by itself) does not take it.
  After each care, and at most every two minutes besides, the host reads the
  library's `claims` (only it gives a vesting claim's asset and value) and reports
  what vests later with the balance (`vesting`, `vestingLots` in
  `vendor/default-arca.js`); the service worker keeps the last reading for the
  wallet (`ext.leaves.sum`), so the overview counts it in the figure and the
  headline and lists a line per date while the wallet opens or is offline. It is
  never spendable: the composer's `held` and the Send form's balance leave it out,
  and `refuseIfVesting` (`src/default-mode.js`) refuses a send or a pool join that
  needs it, the composer through the engine's `vesting`.
- **A supervised asset's freeze is said, never hidden** (`src/leaf-profiles.js`, the
  web wallet's rules and words). The host reports, with each `leafBalance`, what of
  each asset its issuer has frozen for this wallet (frozen or paused held leaves, and
  the on-chain coins the library counts frozen), reading its coins on every tick while
  it holds such a leaf; the popup says it under the asset's figure in both modes, and
  user mode says a frozen refusal in the shared plain words. Which leaf lands where,
  and whether it is frozen, is the library's.
- **The operator's bond is read and watched at care's pace, in either mode** (the
  host's `watchBond`, after each `care`): `bond` engages the library's ratchet (a
  bond once seen bonded is required from then on) and `watch_bond` burns it should
  the operator key sign twice. The gate on a receive or a swap is the library's;
  user mode's words for its refusal are `BOND_WORDS` (`src/leaf-profiles.js`),
  shared with the web wallet and Ambra.
- **Issuer-operated assets are developer mode's only**: each leaf's `batch_profile`
  under Leaves and their dates, and Supply (the library's `supply`, every mint and
  burn the operator lists read again on the wallet's node) for each asset the
  operator's `info` marks `issuer`.
- **BigInt never crosses the message boundary** — all RPC amounts are strings.
- **No bundler, no framework, plain ES modules** (matches the web wallet).
  Content scripts: inpage.js runs in the MAIN world, content.js relays.
- The service worker has no `localStorage`; `src/shim.js` provides a
  write-through shim (vendor/seqln.js needs it). Import shim.js first.

## Provenance / sync obligations

- `vendor/btc.js`, `vendor/seqln.js`, `vendor/lncredit.js`, `vendor/seqln-keys.js`,
  `vendor/seqob.js`, `vendor/covenant.js`, `vendor/covenant-order.js`, `vendor/covenant-flow.js`,
  `vendor/covenant-fill-host.js`, `vendor/noble-ciphers.js`, `vendor/contracts.js`, `vendor/bolt11.js`,
  `vendor/lnupgrade.js`, `vendor/own-txs.js`, `vendor/stake-records.js`,
  `vendor/default-arca.js`, `vendor/confidential-pay.js`, `vendor/pay-code.js`, `vendor/faucet-wallet.js`, `vendor/btc-ark.js`, `vendor/lightning-to-ark.js`, `vendor/speed-up.js`,
  `vendor/user-trade.js`, `vendor/user-trade-btc.js`, `vendor/user-composer.js`,
  `vendor/asset-picker.js`, `vendor/market-view.js`, `vendor/chart.js`, `vendor/indicators.js`,
  `vendor/vendor/lightweight-charts/` (`vendor/` mirrors the web wallet's root, so the market
  view's relative import finds the library), `vendor/tooling/lsp/` and `vendor/lightning/` are copied from
  `sequentia-web-wallet` — fix bugs THERE and re-copy, don't fork them silently.
  `node scripts/vendor-check.mjs --sync` re-copies whatever differs from the web
  wallet's main; `test/vendor-drift.test.mjs` fails while anything does, so sync
  before every release.
  `btc-ark/worker.js` and `btc-ark/pkg/` are the web wallet's `btc-ark/`, copied.
  `popup/picker.css` is the web wallet's CSS for those modules, copied from its `index.html`;
  `src/pair.js` is its `canonicalPair` and `displayPair` (`swap.js`). Every asset `<select>` in the popup gets the shared
  chooser in front of it (`attachChooser`, `ASSET_SELECTS` in `popup/popup.js`; the select stays,
  hidden, as the value; its button is `<id>Chooser`). A new asset menu joins that list.
- `leaves/worker.js` is copied from `sequentia-web-wallet/leaves/worker.js`
  (fix it there and re-copy). `leaves/pkg/` is the `arca` repository's
  `wallet-wasm/` build, and what is committed is always that repository's CI
  build, copied exactly: the `leaf-wallet-pkg` artifact of a commit on its
  master, fetched by `scripts/fetch-leaf-wallet.sh <arca commit>` with its
  `BUILT_FROM` and `SHA256SUMS`, the same files the web wallet vendors, so the
  wasm a release ships is traced by its sha256 to one arca commit
  (`test/leaf-pkg-built-from.test.mjs`). Never commit a local build;
  `scripts/build-leaf-wallet.sh` is for trying an unmerged arca change. Nothing about
  a leaf is decided in this repository's JavaScript, every check, fee and
  refusal is that library's.
- `pkg/` is the SWK `lwk_wasm` build (size-optimized). Rebuild recipe in
  README.md. It is committed deliberately so the extension loads unpacked
  without a Rust toolchain.
- **The offscreen build stamp is the manifest version.** `OFFSCREEN_BUILD`, the
  literal on the first line of `offscreen.js`, is what the document answers the
  worker's `hello` with; the worker reuses a document only when it equals
  `manifest.json`'s `version`, and otherwise replaces it and waits for one that
  does. Raise both together on every version change, or every offscreen job
  fails with "the wallet engine did not come up".
  `test/offscreen-stamp.test.mjs` and `scripts/sw-console-check.mjs` check it.
- `doc/PROVIDER.md` is the contract with websites (the SeqDEX site first
  among them). `src/provider-router.js` and that document MUST change together.

## Endpoints

All backends live behind `https://sequentiatestnet.com` and are declared in
`src/config.js` (the only place origins may appear) + `manifest.json`
host_permissions. The LSP bearer token there is the shared public testnet-demo
token (already public in sequentia-web-wallet) — not a secret.

## Commands

- Tests: `node --test 'test/*.test.mjs'` (CI runs them on every pull request and on
  `master`: `.github/workflows/tests.yml`)
- The tests include `test/modules-parse.test.mjs`, which parses every module
  and links the import graph from each entry point, so a missing export (for
  instance a kit function the committed `pkg/` predates) fails there instead
  of silently killing the service worker. After rebuilding `pkg/`, run it.
- Service worker in a real browser: `CHROME=… node scripts/sw-console-check.mjs`
  (headless; no network). Run it before saying anything works in the browser.
- A contract spend on a private chain: `SEQUENTIAD=… SWK_TEMPLATES=… CHROME=…
  node test/regtest/contract-spend.mjs`. Every contract check and signature is
  the kit's contract engine (`src/contracts.js` hands it the request); never
  decide anything about a contract in JavaScript, and sign only the digest the
  approval page showed.
- A site's contract spend with the wallet's own coins: `SEQUENTIAD=… PIGNUS_WEB=…
  CHROME=… node test/regtest/pignus-v2.mjs` (the Pignus page, bridged to the
  router, on an anchored regtest chain); a 2-of-3 loan's take and liquidation:
  `test/regtest/pignus-threshold.mjs`, the same way.
- A capped sale bought from Levo's page: `SEQUENTIAD=… LEVO=… CHROME=… node
  test/regtest/levo-capped.mjs` (the real levod and page). A SeqPal escrow
  opened and released from SeqPal's page: `test/regtest/seqpal-issuer.mjs`,
  driven by SeqPal's `scripts/regtest-escrow.sh` (`ISSUER_PAGE`).
- Staking on a private chain: `SEQUENTIAD=… node test/regtest/stake-records.mjs
  block-one|fork`; a stake under each lock (height and time) found, unbonded and
  withdrawn: `SEQUENTIAD=… node test/regtest/stake-unbond.mjs`. Both rewrite
  `src/config.js` and the engine's network only through `test/regtest/loader.mjs`,
  which fails if a source text it replaces has changed. Every decision about a
  stake (where the chain holds one, where it stands, the unbond's and the
  withdrawal's transactions) is `vendor/stake-records.js`'s; `src/staking.js`
  gives it the extension's context (`stakeCtx`).
- A site using the leaf methods, headed, against a local operator:
  `CHROME=… ARCA_OPERATOR_CONTROL=… ARCA_CLI=… node test/leaves/drive.mjs
  <evidence-dir> <work-dir>` (README, Development). Start the operator harness
  fresh for each run: the drive moves the chain's median time.
- Every coin home with the operator gone, on the live testnet, through the web wallet's
  `tooling/live-proxy.mjs --cors` (`--refuse /arca` for the outage): `CHROME=… PROXY=…
  node test/leaves/outage-drive.mjs <work> setup|receive|settle|drill|home` (its header
  gives the order).
- Payments that arrive at once over channel leaves, two wallets in default mode against a local
  operator started with `ARCA_OPERATOR_CHANNELS=1000000`: `CHROME=… ARCA_OPERATOR_CONTROL=…
  ARCA_CLI=… node test/leaves/channel-drive.mjs <evidence-dir> <work-dir>` (twelve payments, each
  in the receiver's figure under a second with no block made, then one the channel cannot take).
- The Bitcoin ark's band and the Lightning limit on a receive, on the live testnet: `CHROME=…
  node test/default/band-drive.mjs <work> setup|refill|down|codes|state` (its header gives the
  order; the faucet's BTC is the only coin it uses).
- What the wallet does by itself with leaves: `CHROME=… ARCA_OPERATOR_CONTROL=…
  ARCA_CLI=… node test/leaves/care-drive.mjs <evidence-dir> <work-dir>` (a
  distribution's claim taken up with no click and shown in the popup's figure in
  user mode, the claimed leaf sent into a round once within ten days of its step
  window and the round's leaf planned at once, Release and Cancel, the user-mode
  screens checked against the developer words). Fresh operator harness each run.
- What an operator's profiles ask of the wallet: `CHROME=… ARCA_OPERATOR_CONTROL=…
  ARCA_CLI=… [SEQ_DRIVE_MNEMONIC_FILE=…] node test/leaves/profiles-drive.mjs
  <evidence-dir> <work-dir>` (a payment through the next round, a supervised asset
  frozen, landed and lifted, an issuer-operated asset's supply, the bond). The harness
  started with `ARCA_OPERATOR_SUPERVISED` and `ARCA_OPERATOR_ISSUER`; the phrase file
  is read when it exists, written (mode 600) when it does not, never put in evidence.
- One phrase's figures and headline beside the web wallet's: `CHROME=…
  ARCA_OPERATOR_CONTROL=… TOTAL_PHRASE_FILE=… WEB_TOTALS=… node
  test/leaves/total-drive.mjs <evidence-dir> <work-dir>` (read only; never put the
  phrase in evidence or the repository).
- The SeqDEX site's leaves room, end to end in headless Chromium with two profiles:
  `CHROME=… ARCA_OPERATOR_CONTROL=… SEQOBD=… SEQDEX_WEB=… node test/leaf-room/drive.mjs
  <evidence-dir> <work-dir>` (README, Development). It reaches every endpoint at
  https://sequentiatestnet.com through a stand-in box (`test/leaf-room/box.mjs`), so
  `src/config.js` is not touched.
- A site's fill of an interactive maker's order on a private chain, against a live
  SeqDEX maker, honest and hostile: `test/regtest/interactive-maker.mjs` (README,
  Development). The wallet checks the maker's co-signed swap against its own half
  (`Wollet.seqdexVerifyAccept`) before signing it; never sign a maker's answer
  unchecked.
- A site's market and limit orders on a private chain: `SEQUENTIAD=… SEQOBD=… node
  test/regtest/market-orders.mjs`, and through the SeqDEX site's default view in
  headless Chromium: `CHROME=… SEQUENTIAD=… SEQOBD=… SEQDEX_WEB=… node
  test/market/drive.mjs <evidence-dir> <work-dir>` (README, Development). The orders
  (`src/market.js`, planned by `src/market-plan.js`, records in `src/market-orders.js`)
  take only what SeqDEX's book lists (covenant orders, and orders resting in the joined
  operator's tree), never an interactive maker's offer, and replace an order that fails
  when taken with the next listed one inside the approval (`fallThrough` in
  `src/market-plan.js`); they read what a covenant order holds from the chain, never from the relay's listing,
  and build every spend after a scan begun after the wallet's own last broadcast
  (`engine.syncFresh`). Maker credits arrive at BIP86 payouts the main wollet does not
  track: a second wollet over `covenantMakerDescriptor` watches them once the wallet
  has placed an order, counts them in each asset's figure, and the minute alarm moves
  them into the wallet's own coins.
- Icons: `node scripts/gen-icons.mjs`

## Known limitations (candidates for future work)

- Receiving a Lightning payment needs the device signer online: create the
  invoice from the popup and keep it open until paid (same constraint as the
  web wallet page, surfaced differently by the ephemeral service worker).
- No camera QR scanning (paste or file only). Developer mode's QR payloads are
  bare addresses (deliberately NOT `Address.QRCodeUri()`, which emits a
  wrong-network `liquidnetwork:` URI); default mode's is the receive code.
- RBF bump and replace are not yet ported from the web wallet. Speed up (CPFP) is: in developer
  mode on every waiting transaction of both chains, and by itself in default mode
  (`engine.autoSpeedUp`, `vendor/speed-up.js`).

<!-- BEGIN SHARED AGENT CONVENTIONS: identical in every Sequentia repo. Change it in all of them together. -->
## Working with git and GitHub here

These rules are the same in every Sequentia repository. They are repeated in each
one because this file is the only thing an agent is guaranteed to read, whatever
machine it is working from.

**Nothing pushed to GitHub credits Claude, Anthropic, or any AI tool.** No
`Co-Authored-By: Claude` trailer, no `Claude-Session:` trailer or `claude.ai`
link, no "Generated with Claude Code" in a commit message or a pull request body,
no `claude/*` branch names or session ids, and no mention in source, comments,
docs or issue text. Agent tooling offers several of these by default; compose the
message without them rather than stripping them afterwards.

**Author every commit as the person the session is working for.** Several people
commit in these repositories and an agent always runs on behalf of one of them,
so derive the author from the authenticated GitHub account rather than from a
list of names that goes stale the moment somebody new arrives:

    git -c user.name="$(gh api user --jq '.name // .login')" \
        -c user.email="$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')" \
        commit ...

That address is the GitHub `noreply` form, which is what links a commit to its
account and keeps private addresses out of a public history. When `gh` is not
authenticated as the person the work belongs to, ask them instead of guessing.

**Never infer the author from `git log`.** The clones carry no `user.name` or
`user.email`, so `git commit` stops with "Author identity unknown" and the
nearest answer to hand is the author of the last commit — which is whoever
pushed last and says nothing about who is working now. Attributing a commit to
someone who did not write it puts their name on code they never reviewed, and
taking it back costs a history rewrite and a force-push over commits other
machines have already pulled.

**Every change lands through a pull request that you merge yourself, at once.**
There is no reviewer on this project; the pull request exists so the reasoning is
recorded beside the diff. Branch, push, open it, merge it, delete the branch, all
in one sitting. Pushing straight to the default branch is the rule most often
broken here, and it is the one that costs the record. A pull request stays open
only when the repository owner asks for that specific one, and that never carries
over to the next.

**Name branches `area/short-description`**: `fix/`, `doc/`, `feature/`, `test/`,
`build/`, or the component being changed. Never a tool name, a session id, or
`worktree-*`.

**Write the subject as `area: what changed`**, one line, 72 characters at the
outside and 50 where you can manage it. Put the reasoning in the body, and
explain why rather than what.

**These repositories are public and world-readable.** Never commit private keys,
seeds, `wallet.dat`, RPC credentials, `.env` files or API tokens. Read the diff
before every commit. Secrets belong on the server and in offline backups.

**A file belongs to the repository whose code it describes.** Decide which repo
owns it before writing it; if it landed in the wrong one, move it rather than
deleting it.

**Documentation is part of the change, not a follow-up.** A change that makes a
README, a doc page, a runbook or a code comment wrong is not finished until that
text is right again, in the same pull request as the code. Before you open the
pull request, search the repository for whatever you renamed, moved or removed —
the old binary name, the old path, the old flag, the old command — and fix every
hit. If the change falsifies another repository's documentation, that repository
gets its own pull request in the same sitting. A stale instruction costs a new
user more than a missing one: they trust it, run it, it fails, and the failure
reads as broken software rather than as an out-of-date sentence.

**Write documentation to be timeless.** Assume the reader is new, arrived today,
and wants to know what the software is and how to use it right now. They do not
care what changed, what it used to be called, or which version added what. So
write in the present tense about current behaviour, and leave the history out:
no changelogs, no "new in", no "recently", no "coming soon", no status or
progress sections, no roadmaps, no dated notes. Quote a version number only where
the reader cannot act without it, and prefer pointing at the file that carries it
over copying the digits. Timeless does not mean thin — what the product is, who
it is for, and how to install, configure and use it all still belong there, in
full. Documentation written this way survives a release without an edit, which is
what keeps it true; the history already has homes in the git log, the tags and
the release notes.

**Push the same day you commit.** The testnet server pulls only from GitHub, so a
branch left on one laptop is invisible to every other machine and to the box.
<!-- END SHARED AGENT CONVENTIONS -->
