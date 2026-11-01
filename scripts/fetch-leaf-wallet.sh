#!/usr/bin/env bash
# Copies the leaf wallet into leaves/pkg/ exactly as the operator repository's CI built it: the
# `leaf-wallet-pkg` artifact of a commit on ConcatenaLabs/arca's master (its workflow
# .github/workflows/leaf-wallet-pkg.yml), with the BUILT_FROM and SHA256SUMS files the artifact
# carries. Every release ships this, so the wasm a wallet serves is traced by its sha256 to one
# arca commit and one CI run.
#
#   scripts/fetch-leaf-wallet.sh <arca commit on master>
#
# Needs `gh`, signed in. Refuses an artifact whose files do not match its SHA256SUMS, or whose
# BUILT_FROM names another commit.
set -euo pipefail
want="${1:?name the arca commit}"
dest="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/leaves/pkg"
repo=ConcatenaLabs/arca
sha=$(gh api "repos/$repo/commits/$want" --jq .sha)
run=$(gh run list -R "$repo" --workflow leaf-wallet-pkg --commit "$sha" --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')
[ -n "$run" ] || { echo "no successful leaf-wallet-pkg run for $sha" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -r "$tmp"' EXIT
gh run download "$run" -R "$repo" -n "leaf-wallet-pkg-$sha" -D "$tmp"
( cd "$tmp" && sha256sum -c --quiet SHA256SUMS )
[ "$(tr -d '[:space:]' < "$tmp/BUILT_FROM")" = "$sha" ] || { echo "the artifact's BUILT_FROM is not $sha" >&2; exit 1; }
for f in leaf_wallet.js leaf_wallet.d.ts leaf_wallet_bg.wasm BUILT_FROM SHA256SUMS; do cp "$tmp/$f" "$dest/$f"; done
echo "leaves/pkg: arca $sha (run $run), $(grep leaf_wallet_bg.wasm "$dest/SHA256SUMS")"
