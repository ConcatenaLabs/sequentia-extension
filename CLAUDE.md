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
- **Own-tx ring**: after every `applyUpdate`, recent own broadcasts are
  re-applied (a stale backend Update otherwise reverts them and later builds
  re-select spent inputs).
- **Scan cache**: IndexedDB persists exactly ONE kind of Update — one computed
  against an EMPTY wollet (from a throwaway scan), aged out weekly. Never
  persist a mid-session incremental update.
- **BigInt never crosses the message boundary** — all RPC amounts are strings.
- **No bundler, no framework, plain ES modules** (matches the web wallet).
  Content scripts: inpage.js runs in the MAIN world, content.js relays.
- The service worker has no `localStorage`; `src/shim.js` provides a
  write-through shim (vendor/seqln.js needs it). Import shim.js first.

## Provenance / sync obligations

- `vendor/btc.js`, `vendor/seqln.js`, `vendor/seqln-keys.js`,
  `vendor/seqob.js`, `vendor/covenant.js`, `vendor/covenant-order.js`,
  `vendor/covenant-fill-host.js`, `vendor/noble-ciphers.js` and
  `vendor/lightning/` are copied from `sequentia-web-wallet` — fix bugs THERE
  and re-copy, don't fork them silently.
- `pkg/` is the SWK `lwk_wasm` build (size-optimized). Rebuild recipe in
  README.md. It is committed deliberately so the extension loads unpacked
  without a Rust toolchain.
- `doc/PROVIDER.md` is the contract with websites (the SeqDEX site first
  among them). `src/provider-router.js` and that document MUST change together.

## Endpoints

All backends live behind `https://sequentiatestnet.com` and are declared in
`src/config.js` (the only place origins may appear) + `manifest.json`
host_permissions. The LSP bearer token there is the shared public testnet-demo
token (already public in sequentia-web-wallet) — not a secret.

## Commands

- Tests: `node --test 'test/*.test.mjs'`
- Syntax sweep: copy each .js to a .mjs and `node --check` it
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
