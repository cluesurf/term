#!/usr/bin/env bash
# Every zone suite, in one command.
#
#   bash test/all.sh                 from this package
#   pnpm zone:test                   from the monorepo base
#   pnpm zone:test --only note       one suite, while iterating
#   pnpm zone:test --list            name the suites and stop
#
# `--only` takes a substring and matches suite names, the same way
# `pnpm term:test --only` does. It exists because the alternative is
# what everybody actually does instead: a throwaway shell script that
# cd's into the package and runs one file, written again every time.
#
# Ordered cheapest first, so a broken build fails in seconds rather than
# after two minutes of shell harnesses.
#
#   tree     the language-level tests, run by the Term test runner
#   note     the secret note: written as `host` data, read by the compiler
#   seal     sealing and opening, including refusal on a tampered value
#   cache    the on-disk cache shape and its warm-read budget
#   sdk      the provider write path, against a fake SDK
#   help     the console's help surface, and drift between it and the dispatcher
#   fresh    cache freshness, and that a good cache never calls the provider
#   save     `zone save --name`: every value shape byte for byte, the cache
#            following the write, a bind edit reaching the next load
#   load     `zone load` end to end against a local cache
#   e2e      the whole pipeline against a fake provider, no keychain, no network
#
# Nothing here touches a real credential, a system keychain, or the network.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ZONE="$(cd "$HERE/.." && pwd)"
TERM_HOST="$ZONE/../../host/line.js"

cd "$ZONE" || exit 1

ONLY=""
LIST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 ;;
    --list) LIST=1; shift ;;
    *) shift ;;
  esac
done

NAMES="tree/base tree/read tree/zone tree/note tree/stamp note seal cache sdk help fresh save load e2e"

if [ -n "$LIST" ]; then
  for n in $NAMES; do echo "$n"; done
  exit 0
fi

FAILED=""
RAN=0
run(){
  local name="$1"; shift

  # `--only` is a SUBSTRING, so `--only tree` runs all three tree suites
  # and `--only note` runs the one.
  if [ -n "$ONLY" ] && [ "${name#*$ONLY}" = "$name" ]; then
    return 0
  fi

  RAN=$((RAN + 1))
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if "$@"; then
    printf '   \033[32mpassed\033[0m\n'
  else
    printf '   \033[31mFAILED\033[0m\n'
    FAILED="$FAILED $name"
  fi
}

printf '\033[1mbuilding\033[0m\n'
node "$TERM_HOST" make >/dev/null 2>&1 || { echo "  the build failed. Run \`term make\` to see why."; exit 1; }
echo "  built"

for t in base read zone note stamp; do
  run "tree/$t" node "$TERM_HOST" test "test/$t.tree"
done
run note  pnpm exec tsx test/note.ts
run seal  pnpm exec tsx test/seal.ts
run cache pnpm exec tsx test/cache.ts
run sdk   pnpm exec tsx test/sdk.ts
run help  bash test/help.sh
run fresh bash test/fresh.sh
run save  bash test/save.sh
run load  bash test/load.sh
run e2e   bash test/e2e.sh

if [ -n "$FAILED" ]; then
  printf '\n\033[31mfailed:%s\033[0m\n' "$FAILED"
  exit 1
fi

# A FILTER THAT MATCHES NOTHING MUST NOT READ AS SUCCESS. `--only nope`
# running zero suites and printing "passed" is the shape of gate that
# gets believed while checking nothing.
if [ "$RAN" -eq 0 ]; then
  printf '\n\033[31mno suite matched --only %s\033[0m\n' "$ONLY"
  printf 'Run `bash test/all.sh --list` to see the names.\n'
  exit 1
fi

if [ -n "$ONLY" ]; then
  printf '\n\033[32m%s zone suite(s) passed\033[0m\n' "$RAN"
else
  printf '\n\033[32mevery zone suite passed\033[0m\n'
fi
