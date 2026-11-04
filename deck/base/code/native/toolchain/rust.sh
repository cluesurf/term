#!/usr/bin/env bash
#
# The rust backend: build its dependencies, compile every stdlib module for it, and run the smoke test.
#
#   deck/base/code/native/toolchain/rust.sh deps    fetch and build the crates in deck/base/code/native/rust/Cargo.toml
#   deck/base/code/native/toolchain/rust.sh flags   print CARGO_TARGET_DIR, the one thing the gate needs
#   deck/base/code/native/toolchain/rust.sh check   every stdlib module through cargo check (NG_MATCH=... narrows it)
#   deck/base/code/native/toolchain/rust.sh test    run the asynchronous-file and HTTP-server smoke program
#
# The async stack is tokio (`tokio::fs`) and hyper.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# THE SAME target directory the native gate uses (it sets CARGO_TARGET_DIR to it). Sharing it means the crate graph
# is compiled once for both, not once each: hyper, tokio and notify are minutes of build on a cold cache and a cache
# hit on a warm one.
RUST_CACHE="$CACHE/rust"
export CARGO_TARGET_DIR="${TMPDIR:-/tmp}/seed-rust-runtime/target"

do_deps() {
  need cargo
  say "rust: building $NATIVE/rust/Cargo.toml into $CARGO_TARGET_DIR"
  cargo build --manifest-path "$NATIVE/rust/Cargo.toml" --quiet
  say "rust: dependencies ready"
}

do_flags() {
  [ -d "$CARGO_TARGET_DIR" ] || do_deps
  printf 'CARGO_TARGET_DIR=%s\n' "$CARGO_TARGET_DIR"
}

do_check() {
  need cargo
  need_checkout check
  cd "$TERM_DIR"
  NG_ONLY=rust pnpm run term:native-gate
}

do_test() {
  need cargo
  local suite="$TERM_DIR/test/native/rust"
  [ -d "$suite" ] || die "no rust smoke suite at $suite"
  say "rust: running the smoke suite in $suite"
  cargo run --manifest-path "$suite/Cargo.toml" --quiet
}

case "${1:-test}" in
  deps) do_deps ;;
  flags) do_flags ;;
  check) do_check ;;
  test) do_deps && do_test ;;
  *) usage ;;
esac
