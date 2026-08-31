#!/usr/bin/env bash
# End-to-end integration test of the whole .env-replacement pipeline,
# entirely headless. The `env` store (ZONE_SAVE=env) holds the
# bootstrap token in ZONE_CODE, and a FAKE bws (test/fixture/bin/bws)
# stands in for the real provider. Nothing touches a system keychain,
# so there are no GUI prompts and no real credentials. All state lives
# under a temp dir that is removed at the end.
#
#   bash test/e2e.sh
#
# Exits non-zero if any check fails.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ZONE="$(cd "$HERE/.." && pwd)"
TERM_HOST="$ZONE/../../host/line.js"
FIX="$HERE/fixture"
WORK="$(mktemp -d)"
PROJ="$WORK/proj"
SBOX="$WORK/home"
mkdir -p "$PROJ" "$SBOX"
cp "$FIX/manifest.zone.tree" "$PROJ/.zone.tree"

cleanup(){ rm -rf "$WORK"; }
trap cleanup EXIT

export PATH="$FIX/bin:$PATH"
export TERM_CACHE_HOME="$SBOX/.cache"
export HOME="$SBOX"
export ZONE_SAVE=env               # headless store: no keychain
export ZONE_CODE=fake-machine-token # the one bootstrap secret CI injects

PASS=0; FAIL=0
say(){ printf '\n=== %s ===\n' "$1"; }
ok(){ printf '  ok    %s\n' "$1"; PASS=$((PASS+1)); }
no(){ printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
strip(){ grep -vE '→ Booting|✓ Built|✓ Cached|Compiling|No build script'; }

zone(){ ( cd "$ZONE" && node "$TERM_HOST" boot code/line/base.tree -- "$@" 2>&1 | strip ); }
zonep(){ ( cd "$PROJ" && node "$TERM_HOST" boot "$ZONE/code/line/base.tree" -- "$@" 2>&1 | strip ); }

say "bind"
# `--sort development` is explicit because this harness exercises the LEGACY
# `.zone.tree` path, whose fixture declares `sort development`. The default
# is now `moon`, which is what the zone.tree world calls the same thing.
out=$(zone bind --mind lance --host e2ebox --team cluesurf --sort development); echo "$out"
[ -f "$SBOX/.base/@term/zone/zone.tree" ] && ok "config written" || no "config missing"

say "show (env store, code present via ZONE_CODE)"
out=$(zone show); echo "$out"
echo "$out" | grep -q 'save    env' && ok "env store selected"      || no "store was not env"
echo "$out" | grep -q 'code    yes' && ok "code present"            || no "code not seen"
echo "$out" | grep -q 'fake-machine-token' && no "SECRET LEAKED"    || ok "credential never printed"

say "test (reads the project's real names through the provider)"
out=$(zonep test); echo "$out"
for check in binding code access secrets; do
  echo "$out" | grep -q "ok  *$check" && ok "test: $check" || no "test: $check"
done

say "call: child sees ONLY the declared names, nothing else"
out=$(zonep call --sort development -- node -e 'console.log("OPENAI="+process.env.OPENAI_API_KEY); console.log("DB="+process.env.DATABASE_URL); console.log("SENTRY="+process.env.SENTRY_DSN); console.log("EXTRA="+(process.env.SOME_OTHER_SECRET||"none"))')
echo "$out"
echo "$out" | grep -q 'OPENAI=sk-fake-123'         && ok "OPENAI_API_KEY injected"      || no "OPENAI_API_KEY missing"
echo "$out" | grep -q 'DB=postgres://fake/db'      && ok "DATABASE_URL injected"        || no "DATABASE_URL missing"
echo "$out" | grep -q 'SENTRY=https://fake@sentry' && ok "SENTRY_DSN (want) injected"   || no "SENTRY_DSN missing"
echo "$out" | grep -q 'EXTRA=none'                 && ok "undeclared name not injected" || no "an undeclared name leaked"

say "call: child exit code passes through"
( cd "$PROJ" && node "$TERM_HOST" boot "$ZONE/code/line/base.tree" -- call --sort development -- node -e 'process.exit(7)' ) >/dev/null 2>&1
ec=$?; [ "$ec" = "7" ] && ok "child exit 7 propagated" || no "exit was $ec, not 7"

say "call: refuses when a required name is absent from the project"
cp "$FIX/manifest-missing.zone.tree" "$PROJ/.zone.tree"
out=$(zonep call --sort development -- node -e 'console.log("SHOULD NOT RUN")' 2>&1); echo "$out"
echo "$out" | grep -q 'SHOULD NOT RUN' && no "ran despite a missing secret" || ok "refused to start"
echo "$out" | grep -qi 'nonexistent-secret' && ok "names the missing secret" || no "did not name it"
cp "$FIX/manifest.zone.tree" "$PROJ/.zone.tree"

say "code save on the env store is an honest no-op"
out=$(zone code save development); echo "$out"
echo "$out" | grep -qi 'nothing to store' && ok "save explains itself" || no "save did not explain itself"

printf '\n=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
