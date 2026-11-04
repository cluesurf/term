#!/usr/bin/env bash
#
# The swift backend: build its dependencies, compile every stdlib module for it, and run the smoke test.
#
#   deck/base/code/native/toolchain/swift.sh deps    resolve and build swift-nio + Hummingbird from deck/base/code/native/swift
#   deck/base/code/native/toolchain/swift.sh flags   print the swiftc flags that make those modules importable
#   deck/base/code/native/toolchain/swift.sh check   every stdlib module through swiftc -typecheck (NG_MATCH=... narrows it)
#   deck/base/code/native/toolchain/swift.sh test    run the asynchronous-file and HTTP-server smoke program
#
# WHY THE FLAGS ARE NOT OBVIOUS. The gate typechecks one emitted file at a time, which is fast and gives each
# module its own verdict, but a bare `swiftc -typecheck` knows nothing about a SwiftPM package. So `deps` builds
# the package once and this writes down the three things swiftc then needs:
#
#   -I <.build/debug/Modules>            the .swiftmodule files
#   -Xcc -fmodule-map-file=<each>        the C targets' generated module maps (CNIOAtomics and friends)
#   -Xcc -I<each Sources/*/include>      their headers
#
# Miss the module maps and swiftc reports `missing required module 'CNIOAtomics'` from a file that never mentions
# it.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SWIFT_CACHE="$CACHE/swift"
SWIFT_PACKAGE="$NATIVE/swift"
BUILD="$SWIFT_CACHE/build"
FLAGS="$SWIFT_CACHE/flags.txt"

# `deps if-broken` builds only when the flags are not whole (common.sh `listed_whole`), checked again under the lock,
# so the suites that found the cache broken together rebuild it once. A build that fails on what the purge left (a
# precompiled module whose files are gone) or leaves maps missing (emptied checkouts, which an incremental build does
# not fetch again) is reset and built from nothing
do_deps() {
  need swift
  mkdir -p "$SWIFT_CACHE"
  take_lock "$SWIFT_CACHE/deps.lock"

  if [ "${1:-}" = if-broken ] && listed_whole "$FLAGS"; then
    return
  fi

  rm -f "$FLAGS.whole"
  # one line per rebuild, kept beside the cache: the stderr of a build started by `term make` is not shown anywhere
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "${1:-deps}" >> "$SWIFT_CACHE/rebuilds.txt"
  say "swift: building $SWIFT_PACKAGE/Package.swift into $BUILD (a cold fetch of swift-nio takes minutes)"
  local built=1
  swift build --package-path "$SWIFT_PACKAGE" --scratch-path "$BUILD" >&2 || built=0
  [ "$built" = 1 ] && write_flags

  if [ "$built" = 0 ] || ! listed_whole "$FLAGS"; then
    say "swift: the build failed or left module maps missing, resetting $BUILD and building again"
    rm -f "$FLAGS.whole"
    swift package reset --package-path "$SWIFT_PACKAGE" --scratch-path "$BUILD" >&2
    swift build --package-path "$SWIFT_PACKAGE" --scratch-path "$BUILD" >&2
    write_flags
    listed_whole "$FLAGS" || die "swift: $FLAGS names files that are not there after a clean build"
  fi

  say "swift: dependencies ready, flags in $FLAGS"
}

# the flag list, one argument per line so a caller can read it without quoting games
write_flags() {
  local modules
  modules="$(find "$BUILD" -type d -name Modules -path '*/debug/*' | head -1)"
  [ -n "$modules" ] || die "swift: no Modules directory under $BUILD, did the build fail?"

  {
    printf -- '-I\n%s\n' "$modules"

    find "$BUILD" -name '*.modulemap' | while IFS= read -r map; do
      printf -- '-Xcc\n-fmodule-map-file=%s\n' "$map"
    done

    find "$BUILD/checkouts" -type d -name include | while IFS= read -r dir; do
      printf -- '-Xcc\n-I%s\n' "$dir"
    done
  } > "$FLAGS.part"

  # renamed into place whole, so a reader never sees half a list, and stamped after
  mv "$FLAGS.part" "$FLAGS"
  stamp_whole "$FLAGS"
}

do_flags() {
  listed_whole "$FLAGS" || do_deps if-broken >&2
  cat "$FLAGS"
}

do_check() {
  need swiftc
  need_checkout check
  listed_whole "$FLAGS" || do_deps if-broken
  cd "$TERM_DIR"
  NG_ONLY=swift pnpm run term:native-gate
}

# The suite is ASSEMBLED rather than checked in as a package, because SwiftPM refuses sources from outside a
# target's own directory and the whole point is to run the shipped shims where they live. So this copies the shim
# sources and the suite sources into one target and builds that. Copies, never edits: the tree is untouched.
do_test() {
  need swift
  local suite="$TERM_DIR/test/native/swift"
  [ -d "$suite" ] || die "no swift smoke suite at $suite"

  local build="$SWIFT_CACHE/suite"
  local sources="$build/Sources/suite"
  mkdir -p "$sources"

  # the shipped shims, by the same paths the compiler prepends them from
  local shims=(
    "$NATIVE/swift/file/runtime/aio.swift"
    "$NATIVE/swift/file/runtime/watch.swift"
    "$NATIVE/swift/file/asynchronous/runtime/stat.swift"
    "$NATIVE/swift/file/asynchronous/runtime/walk.swift"
    "$NATIVE/swift/network/runtime/server.swift"
    "$NATIVE/swift/network/runtime/http2.swift"
  )

  # clear ONLY the .swift files this script put here, and only under the cache it made. Never a recursive delete
  # of a path built from a variable: one empty variable and that is somebody's home directory.
  case "$sources" in
    "$CACHE"/*) find "$sources" -maxdepth 1 -name '*.swift' -delete ;;
    *) die "swift: refusing to clear $sources, it is not under $CACHE" ;;
  esac

  for shim in "${shims[@]}"; do
    [ -f "$shim" ] || die "swift: missing shim $shim"
    cp "$shim" "$sources/$(basename "$shim")"
  done

  cp "$suite"/*.swift "$sources/"

  cat > "$build/Package.swift" <<'PACKAGE'
// swift-tools-version:5.9
// GENERATED by deck/base/code/native/toolchain/swift.sh. The dependency list mirrors deck/base/code/native/swift/Package.swift.
import PackageDescription

let package = Package(
    name: "suite",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.65.0"),
        .package(
            url: "https://github.com/hummingbird-project/hummingbird.git",
            from: "2.0.0"
        ),
    ],
    targets: [
        .executableTarget(
            name: "suite",
            dependencies: [
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HummingbirdHTTP2", package: "hummingbird"),
                .product(name: "HummingbirdTLS", package: "hummingbird"),
            ],
            path: "Sources/suite"
        )
    ]
)
PACKAGE

  # the scratch is kept between runs and TMPDIR is purged file by file: a build that fails on what is left of it is
  # reset and built from nothing once (term-cli-in-term-0217)
  local scratch="$SWIFT_CACHE/suite-build"
  if ! swift build --package-path "$build" --scratch-path "$scratch" --product suite >&2; then
    say "swift: the suite's build failed, resetting $scratch and building again"
    swift package reset --package-path "$build" --scratch-path "$scratch" >&2
    swift build --package-path "$build" --scratch-path "$scratch" --product suite >&2
  fi

  say "swift: running the smoke suite"
  swift run --package-path "$build" --scratch-path "$scratch" suite
}

case "${1:-test}" in
  deps) do_deps ;;
  flags) do_flags ;;
  check) do_check ;;
  test) do_deps && do_test ;;
  *) usage ;;
esac
