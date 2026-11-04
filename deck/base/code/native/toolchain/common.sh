# Shared settings for the three native backend scripts (rust.sh, swift.sh, kotlin.sh).
#
# They live in the stdlib's own tree, deck/base/code/native/toolchain/, because the shipped `term` runs them: a
# Compose build asks kotlin.sh for its libraries and a Swift build asks swift.sh for its flags, from an installed
# payload as from a checkout. Every path below is found from this file's own folder.
#
# Each script takes one verb:
#
#   deps    resolve and build that backend's dependency graph into the cache
#   flags   print what a compiler needs to see those dependencies (running `deps` first if the cache is cold)
#   check   compile every stdlib module for that backend, through the native gate (a checkout only)
#   test    build and RUN the smoke program: asynchronous file IO and an HTTP server, against the real shims (a
#           checkout only)
#
# The cache is outside the repository and survives between runs, because resolving swift-nio or ktor takes minutes
# on a cold fetch and seconds on a warm one. Override it with TERM_NATIVE_CACHE.

set -euo pipefail

# the stdlib's native folder, deck/base/code/native, and the Term root (or the install root) five folders above
NATIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERM_DIR="$(cd "$NATIVE/../../../.." && pwd)"
CACHE="${TERM_NATIVE_CACHE:-${TMPDIR:-/tmp}/term-native}"

mkdir -p "$CACHE"

# the cache's real path: a test run's TMPDIR links term-native in and is removed afterwards, so a path written through
# the link would name nothing on the next run
CACHE="$(cd "$CACHE" && pwd -P)"

say() {
  printf '%s\n' "$*" >&2
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. Install it and run again."
}

# A cache file that lists paths (swift's flags, kotlin's classpaths) is TRUSTED ONLY WHEN IT IS WHOLE: its stamp
# `<file>.whole`, written last, is there and no older than it, and every absolute path it names is still on disk. The
# cache is under $TMPDIR, which macOS purges file by file: on 2026-10-23 the swift build kept its folders and lost
# every module.modulemap, and a flags file that merely existed sent seven suites to swiftc with maps that were gone
# (term-cli-in-term-0217). A path is whatever follows the first `/` of a line or of a `:`-separated part, which reads
# `-fmodule-map-file=/x`, `-I/x` and a classpath alike
listed_whole() {
  local file="$1"
  [ -s "$file" ] && [ -f "$file.whole" ] && [ ! "$file" -nt "$file.whole" ] || return 1

  local path
  while IFS= read -r path; do
    [ -e "$path" ] || return 1
  done < <(tr ':' '\n' < "$file" | sed -n 's|^[^/]*\(/.*\)$|\1|p')
}

# the stamp listed_whole reads, written once the list is complete
stamp_whole() {
  touch "$1.whole"
}

# One rebuild at a time: the suites of a test run reach a broken cache together. The lock is a folder (mkdir is
# atomic) holding its owner's pid, taken over when that process is gone. Whoever waited checks the cache again
take_lock() {
  local lock="$1"
  until mkdir "$lock" 2>/dev/null; do
    local holder
    holder="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -f "$lock/pid"
      rmdir "$lock" 2>/dev/null || true
      continue
    fi
    sleep 1
  done
  printf '%s\n' "$$" > "$lock/pid"
  trap "rm -f '$lock/pid'; rmdir '$lock' 2>/dev/null || true" EXIT
}

# the native gate and the smoke suites are the Term repository's, not the payload's
need_checkout() {
  [ -f "$TERM_DIR/package.json" ] && [ -d "$TERM_DIR/test/native" ] || die "$1 runs in a Term checkout, not in an installed term"
}

usage() {
  say "usage: $(basename "$0") [deps|flags|check|test]"
  exit 2
}
