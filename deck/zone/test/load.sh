#!/usr/bin/env bash
# End to end test of `zone load`: a real sealed cache, a real master key in
# the headless store, and a child process that must see exactly the values
# its zone declares and nothing more.
#
#   bash test/load.sh
#
# Headless. Touches no keychain and no provider. All state lives under a temp
# directory that is removed at the end.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ZONE="$(cd "$HERE/.." && pwd)"
TERM_HOST="$ZONE/../../host/line.js"
WORK="$(mktemp -d)"
PROJ="$WORK/proj"
SBOX="$WORK/home"
mkdir -p "$PROJ" "$SBOX/.config/zone"

cleanup(){ rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok(){ printf '  ok    %s\n' "$1"; PASS=$((PASS+1)); }
no(){ printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
strip(){ grep -vE '→ Booting|✓ Built|✓ Cached|Compiling|No build script'; }

cat > "$PROJ/zone.tree" <<'EOF'
self true

base bitwarden

need database-url
want sentry-dsn

zone word.surf
  zone star
    need sentry-dsn

zone task.surf
  need never-sealed

zone land
  cast snake
  cast tf
  need database-url
    name legacy-database-url
EOF

cat > "$SBOX/.config/zone/zone.tree" <<'EOF'
zone <1>

mind tester
host test-machine
base moon

hold bitwarden
  team cluesurf

save env
EOF

KEY="$(cd "$ZONE" && pnpm exec tsx test/make-cache.ts "$PROJ" 2>/dev/null | tail -1)"

export HOME="$SBOX"
export SEED_CACHE_HOME="$SBOX/.cache"
export ZONE_STORE=env
export ZONE_CODE_SEAL="$KEY"

zone(){ ( cd "$PROJ" && node "$TERM_HOST" boot "$ZONE/code/line/base.tree" -- "$@" 2>&1 | strip ); }
# Same command with the two streams kept apart, for asserting which one a
# message went to. `zone` above merges them, which is right for most checks
# and wrong for exactly that one.
zoneout(){ ( cd "$PROJ" && node "$TERM_HOST" boot "$ZONE/code/line/base.tree" -- "$@" 2>/dev/null | strip ); }

echo "=== load: the child sees what its zone declares ==="
out="$(zone load word.surf/star -- node -e 'console.log("DB="+process.env.DATABASE_URL+" SENTRY="+process.env.SENTRY_DSN)')"
echo "$out" | grep -q 'DB=postgres://sealed/db' && ok "an inherited value is opened" || no "inherited value missing: $out"
echo "$out" | grep -q 'SENTRY=https://sealed@sentry' && ok "a zone's own value is opened" || no "own value missing: $out"

echo
echo "=== load: a name the zone does not declare is not passed on ==="
out="$(zone load base -- node -e 'console.log("SENTRY="+process.env.SENTRY_DSN)')"
echo "$out" | grep -q 'SENTRY=undefined' && ok "an undeclared name is absent" || no "leaked: $out"

echo
echo "=== load: an optional value that is not cached is not a problem ==="
out="$(zone load word.surf -- node -e 'console.log("ran ok")')"
echo "$out" | grep -q 'ran ok' && ok "a want that is absent still starts" || no "refused on an optional value: $out"

echo
echo "=== load: refuses when a REQUIRED value is not cached ==="
out="$(zone load task.surf -- node -e 'console.log("ran")' 2>&1)"
echo "$out" | grep -q 'ran' && no "it started anyway" || ok "refused rather than starting half populated"
echo "$out" | grep -q 'NEVER_SEALED' && ok "names the value that is missing" || no "did not name it: $out"

echo
echo "=== load: a value is published under every cast and every alias ==="
out="$(zone load land -- node -e 'console.log([
  "SNAKE="+process.env.DATABASE_URL,
  "TF="+process.env.TF_VAR_database_url,
  "ALIAS="+process.env.LEGACY_DATABASE_URL,
  "TFALIAS="+process.env.TF_VAR_legacy_database_url,
].join(" "))')"
echo "$out" | grep -q 'SNAKE=postgres://sealed/db'   && ok "the plain name"        || no "plain name missing: $out"
echo "$out" | grep -q 'TF=postgres://sealed/db'      && ok "the tf cast"           || no "tf cast missing: $out"
echo "$out" | grep -q 'ALIAS=postgres://sealed/db'   && ok "the name spelling"     || no "the name spelling missing: $out"
echo "$out" | grep -q 'TFALIAS=postgres://sealed/db' && ok "the name spelling, tf cast too" || no "the name spelling under tf missing: $out"

echo
echo "=== load: a zone with no cast still gets the plain name ==="
out="$(zone load base -- node -e 'console.log("DB="+process.env.DATABASE_URL+" TF="+(process.env.TF_VAR_database_url||"none"))')"
echo "$out" | grep -q 'DB=postgres://sealed/db' && ok "plain name where no cast is declared" || no "missing: $out"
echo "$out" | grep -q 'TF=none' && ok "no tf name leaks into a zone that did not ask" || no "tf leaked: $out"

echo
echo "=== load: the child is told which zone it is under ==="
out="$(zone load word.surf/star -- node -e 'console.log("ZONE="+process.env.ZONE)')"
echo "$out" | grep -q 'ZONE=base/word.surf/star' && ok "ZONE names the resolved path" || no "ZONE wrong: $out"

echo
echo "=== load: the child's exit code passes through ==="
( cd "$PROJ" && node "$TERM_HOST" boot "$ZONE/code/line/base.tree" -- load base -- node -e 'process.exit(7)' ) >/dev/null 2>&1
[ "$?" = "7" ] && ok "exit 7 propagated" || no "exit code lost"

echo
echo "=== load: a stale cache is said out loud, and does not block ==="
# Rebuild the same cache with a `good` stamp in the past.
(cd "$ZONE" && pnpm exec tsx test/make-cache.ts "$PROJ" "2000-01-01T00:00:00Z" >/dev/null 2>&1)
out="$(zone load word.surf/star -- node -e 'console.log("ran anyway")' 2>&1)"
echo "$out" | grep -q 'ran anyway'   && ok "a stale cache does not block the command" || no "stale cache blocked the command"
echo "$out" | grep -qi 'went stale'  && ok "it says the values went stale"            || no "no staleness warning"
echo "$out" | grep -qi 'ago'         && ok "it says how stale, in words"              || no "the warning is not in words"
echo "$out" | grep -qi 'zone read'   && ok "it says what to run"                      || no "the warning names no fix"

# The warning goes to stderr, so piped stdout stays clean.
clean="$(zoneout load word.surf/star -- node -e 'console.log("only this")')"
echo "$clean" | grep -qi 'went stale' && no "the warning corrupted stdout" || ok "the warning is on stderr, not stdout"

# put the fresh cache back for anything after this
(cd "$ZONE" && pnpm exec tsx test/make-cache.ts "$PROJ" >/dev/null 2>&1)
out="$(zone load word.surf/star -- node -e 'console.log("ran")' 2>&1)"
echo "$out" | grep -qi 'went stale' && no "a good cache warned anyway" || ok "a good cache says nothing"

echo
echo "=== load: no value is ever printed ==="
out="$(zone list word.surf/star)"
echo "$out" | grep -q 'sealed' && no "SECRET LEAKED" || ok "list prints names only"

echo
printf '=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ] || exit 1
