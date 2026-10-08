#!/usr/bin/env bash
# Builds the leaf wallet (the operator wallet library compiled to wasm, from the
# operator repository's `wallet-wasm/`) with every build-machine path remapped,
# and copies the package into this extension's leaves/pkg/.
#
#   scripts/build-leaf-wallet.sh <operator-repository-checkout>
#
# Needs the wasm32-unknown-unknown target, wasm-pack and protoc (set PROTOC when
# it is not on the PATH). The package names no home directory, checkout or cargo
# cache: the script fails rather than copy one that does.
set -euo pipefail
src="$(cd "${1:?name the operator repository checkout}" && pwd)"
ext="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"
# RUSTFLAGS replaces the crate's own target flags, so its one flag is repeated.
flags=(
  "--cfg" "getrandom_backend=\"wasm_js\""
  "--remap-path-prefix=$src=/arca"
  "--remap-path-prefix=$cargo_home/registry/src=/cargo/registry"
  "--remap-path-prefix=$cargo_home/git/checkouts=/cargo/git"
  "--remap-path-prefix=$rustup_home=/rustup"
)
if [ -n "${CARGO_TARGET_DIR:-}" ]; then
  flags+=("--remap-path-prefix=$CARGO_TARGET_DIR=/target")
fi
export CARGO_ENCODED_RUSTFLAGS="$(IFS=$'\x1f'; echo "${flags[*]}")"
cd "$src/wallet-wasm"
wasm-pack build --target web --release --out-name leaf_wallet
for p in "$HOME" "$src" "$cargo_home"; do
  if grep -a -q -F "$p" pkg/leaf_wallet_bg.wasm; then
    echo "error: pkg/leaf_wallet_bg.wasm still contains $p" >&2
    exit 1
  fi
done
mkdir -p "$ext/leaves/pkg"
cp pkg/leaf_wallet.js pkg/leaf_wallet.d.ts pkg/leaf_wallet_bg.wasm pkg/leaf_wallet_bg.wasm.d.ts "$ext/leaves/pkg/"
echo "built from $(git -C "$src" rev-parse --short=8 HEAD): leaf_wallet_bg.wasm $(wc -c < pkg/leaf_wallet_bg.wasm) bytes, sha256 $(sha256sum pkg/leaf_wallet_bg.wasm | cut -c1-16)…, no build-machine path"
