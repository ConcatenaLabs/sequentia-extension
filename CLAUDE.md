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
  either mode once started; only what a site sees follows the mode. An in-tree swap
  (`src/leaf-swap.js`) keeps only which site started which swap and what the library
  answered when it did; the host follows a coin held for a swap ('offered') until the
  other wallet completes it, so its mailbox is read. Mode and leaf events reach
  pages through `chrome.tabs.sendMessage` to the content script, not the
  service worker's ports, which die when it sleeps.
- **Care is the library's, run by the host.** The offscreen host runs `care` once
  after the leaf wallet opens and after a sync at most every ten minutes
  (`careDue`, `src/leaf-schedule.js`, the web wallet's rules), in either mode,
  with `scan` = the kit wallet's next receive index + 20 (`claimScan`; the
  service worker tells the host through `ensureRunning`). Which claim to take,
  which coin to plan, its fee and every refusal are the library's; never decide
  one in JavaScript.
- **BigInt never crosses the message boundary** — all RPC amounts are strings.
- **No bundler, no framework, plain ES modules** (matches the web wallet).
  Content scripts: inpage.js runs in the MAIN world, content.js relays.
- The service worker has no `localStorage`; `src/shim.js` provides a
  write-through shim (vendor/seqln.js needs it). Import shim.js first.

## Provenance / sync obligations

- `vendor/btc.js`, `vendor/seqln.js`, `vendor/seqln-keys.js`,
  `vendor/seqob.js`, `vendor/covenant.js`, `vendor/covenant-order.js`, `vendor/covenant-flow.js`,
  `vendor/covenant-fill-host.js`, `vendor/noble-ciphers.js`, `vendor/contracts.js`, `vendor/bolt11.js`,
  `vendor/lnupgrade.js`, `vendor/own-txs.js`, `vendor/stake-records.js` and
  `vendor/lightning/` are copied from `sequentia-web-wallet` — fix bugs THERE
  and re-copy, don't fork them silently.
- `leaves/worker.js` is copied from `sequentia-web-wallet/leaves/worker.js`
  (fix it there and re-copy). `leaves/pkg/` is the `arca` repository's
  `wallet-wasm/` build, made with `scripts/build-leaf-wallet.sh`; nothing about
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

- Tests: `node --test 'test/*.test.mjs'`
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
- What the wallet does by itself with leaves: `CHROME=… ARCA_OPERATOR_CONTROL=…
  ARCA_CLI=… node test/leaves/care-drive.mjs <evidence-dir> <work-dir>` (a
  distribution's claim taken up with no click and shown in the popup's figure in
  user mode, a leaf planned within ten days of its step window, the user-mode
  screens checked against the developer words). Fresh operator harness each run.
- One phrase's figures and headline beside the web wallet's: `CHROME=…
  ARCA_OPERATOR_CONTROL=… TOTAL_PHRASE_FILE=… WEB_TOTALS=… node
  test/leaves/total-drive.mjs <evidence-dir> <work-dir>` (read only; never put the
  phrase in evidence or the repository).
- The SeqDEX site's leaves room, end to end in headless Chromium with two profiles:
  `CHROME=… ARCA_OPERATOR_CONTROL=… SEQOBD=… SEQDEX_WEB=… node test/leaf-room/drive.mjs
  <evidence-dir> <work-dir>` (README, Development). It reaches every endpoint at
  https://sequentiatestnet.com through a stand-in box (`test/leaf-room/box.mjs`), so
  `src/config.js` is not touched.
- A site's market and limit orders on a private chain: `SEQUENTIAD=… SEQOBD=… node
  test/regtest/market-orders.mjs`, and through the SeqDEX site's default view in
  headless Chromium: `CHROME=… SEQUENTIAD=… SEQOBD=… SEQDEX_WEB=… node
  test/market/drive.mjs <evidence-dir> <work-dir>` (README, Development). The orders
  (`src/market.js`, planned by `src/market-plan.js`, records in `src/market-orders.js`)
  read what a covenant order holds from the chain, never from the relay's listing,
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
- No camera QR scanning (paste or file only). QR display payloads are bare
  addresses (deliberately NOT `Address.QRCodeUri()`, which emits a
  wrong-network `liquidnetwork:` URI).
- RBF/CPFP rescue buttons are not yet ported from the web wallet.

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
