#!/usr/bin/env bash
# Every zone suite, in one command.
#
#   bash test/all.sh          from this package
#   pnpm zone:test            from the monorepo base
#
# Ordered cheapest first, so a broken build fails in seconds rather than
# after two minutes of shell harnesses.
#
#   tree     the language-level tests, run by the Term test runner
#   seal     sealing and opening, including refusal on a tampered value
#   cache    the on-disk cache shape and its warm-read budget
#   help     the console's help surface, and drift between it and the dispatcher
#   fresh    cache freshness, and that a good cache never calls the provider
#   load     `zone load` end to end against a local cache
#   e2e      the whole pipeline against a fake provider, no keychain, no network
#
# Nothing here touches a real credential, a system keychain, or the network.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ZONE="$(cd "$HERE/.." && pwd)"
TERM_HOST="$ZONE/../../host/line.js"

cd "$ZONE" || exit 1

FAILED=""
run(){
  local name="$1"; shift
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

for t in base read zone; do
  run "tree/$t" node "$TERM_HOST" test "test/$t.tree"
done
run seal  pnpm exec tsx test/seal.ts
run cache pnpm exec tsx test/cache.ts
run help  bash test/help.sh
run fresh bash test/fresh.sh
run load  bash test/load.sh
run e2e   bash test/e2e.sh

if [ -n "$FAILED" ]; then
  printf '\n\033[31mfailed:%s\033[0m\n' "$FAILED"
  exit 1
fi
printf '\n\033[32mevery zone suite passed\033[0m\n'
