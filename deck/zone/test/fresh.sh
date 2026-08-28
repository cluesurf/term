#!/usr/bin/env bash
# Cache freshness: when `zone read` skips the provider, how long a cache is
# good for, and what `--fresh` overrides.
#
#   bash test/fresh.sh
#
# The fake provider logs every invocation, so "the provider was not called"
# is asserted rather than inferred from the command being fast.
#
# Headless. No keychain, no network, no real credential.
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

zone word.surf
  need google-client-id

  zone star
    need sentry-dsn
EOF

cat > "$SBOX/.config/zone/zone.tree" <<'EOF'
mind lance
host freshbox
team cluesurf
sort moon
save env
EOF

export PATH="$ZONE/test/fixture/bin-read:$PATH"
export HOME="$SBOX"
export SEED_CACHE_HOME="$SBOX/.cache"
export ZONE_STORE=env
export ZONE_CODE=fake-machine-token
export ZONE_FAKE_LOG="$WORK/calls.log"
: > "$ZONE_FAKE_LOG"

# A master key for the cache, in the headless store.
(cd "$ZONE" && pnpm exec tsx test/make-key.ts "$WORK/key" >/dev/null 2>&1)
export ZONE_CODE_SEAL="$(cat "$WORK/key")"

zone(){ ( cd "$PROJ" && node "$TERM_HOST" boot "$ZONE/code/line/base.tree" -- "$@" 2>&1 | strip ); }
calls(){ wc -l < "$ZONE_FAKE_LOG" | tr -d ' '; }

echo "=== read: the first one fetches ==="
before=$(calls)
out="$(zone read)"; echo "$out"
after=$(calls)
[ -f "$PROJ/.base/@cluesurf/zone/zone.code.tree" ] && ok "the cache was written" || no "no cache written"
[ "$after" -gt "$before" ] && ok "the provider was called ($((after-before)) times)" || no "the provider was never called"

echo
echo "=== read: the second one skips the provider entirely ==="
before=$(calls)
out="$(zone read)"; echo "$out"
after=$(calls)
[ "$after" = "$before" ] && ok "the provider was NOT called" || no "the provider was called $((after-before)) times anyway"
echo "$out" | grep -qi 'still good'  && ok "it says the cache is still good" || no "it does not say why it skipped"
echo "$out" | grep -qi '\--fresh'    && ok "it says how to override"         || no "it does not name --fresh"

echo
echo "=== read --fresh: fetches anyway ==="
before=$(calls)
out="$(zone read --fresh)"; echo "$out"
after=$(calls)
[ "$after" -gt "$before" ] && ok "--fresh reached the provider" || no "--fresh did not fetch"

echo
echo "=== the window is set by the strictest tier the cache covers ==="
# This tree has a `star` zone, so the window is the short one.
good=$(grep -o 'good <[^>]*>' "$PROJ/.base/@cluesurf/zone/zone.code.tree" | head -1 | sed 's/good <//;s/>//')
hours=$(node -e 'const g=Date.parse(process.argv[1]); console.log(Math.round((g-Date.now())/3600000))' "$good")
[ "$hours" -le 1 ] && ok "a tree containing a star zone is good for about 1 hour (got $hours)" \
                   || no "expected about 1 hour for a star tree, got $hours"

# A tree with no star zone gets the long window.
cat > "$PROJ/zone.tree" <<'EOF'
self true

base bitwarden

need database-url

zone word.surf
  need google-client-id
EOF
zone read --fresh >/dev/null 2>&1
good=$(grep -o 'good <[^>]*>' "$PROJ/.base/@cluesurf/zone/zone.code.tree" | head -1 | sed 's/good <//;s/>//')
hours=$(node -e 'const g=Date.parse(process.argv[1]); console.log(Math.round((g-Date.now())/3600000))' "$good")
[ "$hours" -ge 11 ] && ok "a tree with no star zone is good for about 12 hours (got $hours)" \
                    || no "expected about 12 hours for a moon-only tree, got $hours"

echo
echo "=== read <path> fetches only that zone and what it inherits ==="
# A three-zone tree, so narrowing is measurable. An earlier check left a
# two-zone one in place, where `word.surf` and the whole tree are the same
# two projects and the comparison proves nothing.
cat > "$PROJ/zone.tree" <<'EOF'
self true

base bitwarden

need database-url

zone word.surf
  need google-client-id

  zone star
    need sentry-dsn
EOF
: > "$ZONE_FAKE_LOG"
zone read --fresh >/dev/null 2>&1
whole=$(grep -c "secret list" "$ZONE_FAKE_LOG")

: > "$ZONE_FAKE_LOG"
zone read word.surf --fresh >/dev/null 2>&1
narrow=$(grep -c "secret list" "$ZONE_FAKE_LOG")

[ "$whole" -gt "$narrow" ] && ok "a named path fetches fewer projects ($narrow vs $whole)" \
                           || no "naming a path fetched $narrow, same as the whole tree ($whole)"
grep -q "secret list base " "$ZONE_FAKE_LOG" && ok "it still fetches the zones it inherits from" \
                                             || no "it skipped an ancestor, so inherited names would be missing"
grep -q "word.surf/star" "$ZONE_FAKE_LOG" && no "it fetched a zone BELOW the one asked for" \
                                          || ok "it does not fetch below the named zone"

echo
echo "=== load with no cache at all: fetches once, loudly, and runs ==="
CACHE="$PROJ/.base/@cluesurf/zone/zone.code.tree"
mv "$CACHE" "$WORK/cache.aside"
before=$(calls)
out="$(zone load base -- node -e 'console.log("DB="+process.env.DATABASE_URL)' 2>&1)"
echo "$out"
after=$(calls)
echo "$out" | grep -q 'DB=from-base'          && ok "the child ran with the fetched value" || no "the child did not get its value"
echo "$out" | grep -qi 'no cached values'     && ok "it says why it went to the provider"  || no "it fetched silently"
[ "$after" -gt "$before" ]                    && ok "the provider was called"              || no "it never fetched"
[ -f "$CACHE" ]                               && ok "the cache was written for next time"  || no "no cache left behind"

echo
echo "=== and the second run is back to no provider at all ==="
before=$(calls)
out="$(zone load base -- node -e 'console.log("DB="+process.env.DATABASE_URL)' 2>&1)"
after=$(calls)
echo "$out" | grep -q 'DB=from-base' && ok "still works from the cache" || no "the cache it wrote is not usable"
[ "$after" = "$before" ]             && ok "the provider was NOT called" || no "it fetched again"
echo "$out" | grep -qi 'no cached values' && no "it claimed no cache while using one" || ok "it says nothing the second time"

echo
echo "=== no value is ever printed ==="
out="$(zone read --fresh)"
for v in from-base from-wordsurf from-star fake-machine-token; do
  echo "$out" | grep -q "$v" && no "LEAKED $v" || ok "never printed $v"
done

printf '\n=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
