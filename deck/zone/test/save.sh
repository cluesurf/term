#!/usr/bin/env bash
# `term zone save --name`, end to end: the value typed is the value the
# child process gets, through the provider, the cache and `term zone load`,
# and nothing in between reads it as anything but text.
#
#   bash test/save.sh
#
# Every shape a person will type or paste is here, and each is checked
# BYTE FOR BYTE (JSON-encoded on the way out, so a lost newline or a
# stripped quote is visible): an integer, a float, both booleans, a zero,
# a line with spaces, quotes, angle brackets, a dollar and a hash, a url,
# a pasted value with CRLF endings and surrounding whitespace, and a
# multi-line PEM key on stdin.
#
# Also held here:
#
#   the save is report-only without --commit, and asks for nothing
#   the cache follows the write, so no `term zone read --fresh` is needed
#   a second save of the same name updates, never duplicates
#   a name declared under a nested zone is filed under that zone
#   a name with a `from` is stored under the from key, the one read fetches
#   a `bind` edit in zone.tree reaches the next load with no provider call
#   a comment edit does not make `term zone test` refuse the cache
#   no value is ever printed
#
# Headless. The fake SDK persists its writes to $ZONE_FAKE_STORE so a save
# and a load, two processes, see one provider. No keychain, no network.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ZONE="$(cd "$HERE/.." && pwd)"
TERM_HOST="$ZONE/../../host/line.js"
WORK="$(mktemp -d)"
PROJ="$WORK/proj"
SBOX="$WORK/home"
mkdir -p "$PROJ" "$SBOX/.base/@term/zone"

cleanup(){ rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok(){ printf '  ok    %s\n' "$1"; PASS=$((PASS+1)); }
no(){ printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
strip(){ grep -vE '→ Booting|✓ Built|✓ Cached|Compiling|No build script'; }

write_deck(){
cat > "$PROJ/zone.tree" <<'TREE'
self true

base bitwarden
  bind organization, <00000000-0000-0000-0000-000000000000>
  bind mode, note
  bind project, <base>

bind git-name, <alice>

need database-url
want work-volume-size
want ratio
want on
want off
want none
want phrase
want place
want pem

zone word.surf
  need google-client-id

  zone tf
    want volume-size, from tf-var-volume-size
TREE
}
write_deck

cat > "$SBOX/.base/@term/zone/zone.tree" <<'EOF2'
mind lance
host savebox
team cluesurf
sort moon
save env
EOF2

export NODE_PATH="$ZONE/test/fixture/sdk/node_modules"
export HOME="$SBOX"
export TERM_CACHE_HOME="$SBOX/.cache"
export ZONE_SAVE=env
export ZONE_CODE=fake-machine-token
export ZONE_FAKE_LOG="$WORK/calls.log"
export ZONE_FAKE_STORE="$WORK/store.json"
: > "$ZONE_FAKE_LOG"

(cd "$ZONE" && pnpm exec tsx test/make-key.ts "$WORK/key" >/dev/null 2>&1)
export ZONE_LOCK="$(cat "$WORK/key")"

zone(){ ( cd "$PROJ" && node "$TERM_HOST" boot "$ZONE/code/line/base.tree" -- "$@" 2>&1 | strip ); }
calls(){ wc -l < "$ZONE_FAKE_LOG" | tr -d ' '; }
# The child prints one variable JSON-encoded, so every byte is visible.
seen(){ zone load "${2:-base}" -- node -e "process.stdout.write(JSON.stringify(process.env.$1 ?? null))" 2>/dev/null | tail -1; }
# The same JSON encoding of what was typed, minus the surrounding whitespace.
want(){ TYPED="$1" node -e 'process.stdout.write(JSON.stringify(process.env.TYPED.replace(/\r\n?/g, "\n").trim()))'; }

echo "=== the first read fills the cache ==="
out="$(zone read --fresh)"; echo "$out"
[ -f "$PROJ/.base/@cluesurf/zone/zone.code.tree" ] && ok "the cache was written" || no "no cache written"

echo
echo "=== save without --commit reports, asks for nothing, writes nothing ==="
before=$(calls)
out="$(printf 'should-not-be-read\n' | zone save --name work-volume-size)"; echo "$out"
echo "$out" | grep -q 'would write work-volume-size at base' && ok "says what it would write, and where" || no "no report: $out"
echo "$out" | grep -q '\-\-commit' && ok "names the flag" || no "does not name --commit"
grep -q 'secret create\|secret update' "$ZONE_FAKE_LOG" && no "wrote to the provider without --commit" || ok "the provider was not written"

echo
echo "=== one value of every shape, byte for byte ==="
# name, typed value (printf format, so escapes are real bytes)
check(){
  local name="$1" typed="$2" env="$3"
  local expect got
  expect="$(want "$typed")"
  out="$(printf '%s' "$typed" | zone save --name "$name" --commit)"
  echo "$out" | grep -q "$name \(made\|grew\) at" || no "$name: the save did not report a write: $out"
  echo "$out" | grep -q 'Filled ' || no "$name: the cache was not refilled after the save"
  got="$(seen "$env")"
  [ "$got" = "$expect" ] && ok "$name  ->  $got" || no "$name: typed $expect, child got $got"
}
check work-volume-size $'1000\n'                              WORK_VOLUME_SIZE
check ratio            $'3.5\n'                               RATIO
check on               $'true\n'                              ON
check off              $'false\n'                             OFF
check none             $'0\n'                                 NONE
check phrase           $'hello world "quoted" <angle> $dollar #hash it\'s back\\slash\n' PHRASE
check place            $'postgres://user:p%40ss@host:5432/db?sslmode=require&x=1\n' PLACE
check pem              $'-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nabc/def+ghi==\n-----END PRIVATE KEY-----\n' PEM

echo
echo "=== pasted with CRLF endings and whitespace around it ==="
check work-volume-size $'  \t1000\r\n\r\n' WORK_VOLUME_SIZE

echo
echo "=== the cache follows the write: no read --fresh, no provider call at load ==="
printf '2000\n' | zone save --name work-volume-size --commit >/dev/null 2>&1
before=$(calls)
got="$(seen WORK_VOLUME_SIZE)"
after=$(calls)
[ "$got" = '"2000"' ] && ok "the load sees the value just saved" || no "the load saw $got, not \"2000\""
[ "$after" = "$before" ] && ok "the load did not call the provider" || no "the load called the provider $((after-before)) times"

echo
echo "=== a second save of one name updates it, never a second copy ==="
n=$(grep -c '"key": "work-volume-size"' "$ZONE_FAKE_STORE")
[ "$n" = "1" ] && ok "one copy at the provider after $(grep -c 'secret update work-volume-size' "$ZONE_FAKE_LOG") updates" || no "$n copies of work-volume-size at the provider"

echo
echo "=== a name declared under a nested zone is filed under that zone ==="
out="$(printf 'nested-client\n' | zone save --name google-client-id --commit)"; echo "$out"
echo "$out" | grep -q 'google-client-id grew at base/word.surf' && ok "filed at base/word.surf" || no "filed elsewhere: $out"
grep -q 'list zone, <base/word.surf>' "$ZONE_FAKE_STORE" && ok "the note names the nested zone" || no "the note does not name base/word.surf"
got="$(seen GOOGLE_CLIENT_ID word.surf)"
[ "$got" = '"nested-client"' ] && ok "load word.surf sees it" || no "load word.surf saw $got"

echo
echo "=== a name with a \`from\` is stored under the from key, which is what read fetches by ==="
out="$(printf '1000\n' | zone save --name volume-size --commit)"; echo "$out"
echo "$out" | grep -q 'volume-size made at base/word.surf/tf, stored as tf-var-volume-size' && ok "stored as the from key, and says so" || no "wrong key or no report: $out"
grep -q '"key": "tf-var-volume-size"' "$ZONE_FAKE_STORE" && ok "the provider holds tf-var-volume-size" || no "the provider does not hold the from key"
grep -q '"key": "volume-size"' "$ZONE_FAKE_STORE" && no "a second secret under the declared name" || ok "nothing stored under the declared name"
got="$(seen VOLUME_SIZE word.surf/tf)"
[ "$got" = '"1000"' ] && ok "load word.surf/tf reads it back as VOLUME_SIZE" || no "load word.surf/tf saw $got"
out="$(zone save --name volume-size)"
echo "$out" | grep -q 'stored as tf-var-volume-size' && ok "the report names the key too" || no "the report does not name the key: $out"

echo
echo "=== a bind edit reaches the next load, with no provider and no refetch ==="
got="$(seen GIT_NAME)"
[ "$got" = '"alice"' ] && ok "bind git-name reaches the child" || no "GIT_NAME was $got"
sed -i '' 's/bind git-name, <alice>/bind git-name, <bob>/' "$PROJ/zone.tree"
before=$(calls)
out="$(zone load base -- node -e 'process.stdout.write(JSON.stringify(process.env.GIT_NAME))')"
after=$(calls)
echo "$out" | grep -q '"bob"' && ok "the edited bind is what the child gets" || no "the child did not get bob: $out"
[ "$after" = "$before" ] && ok "the provider was not called" || no "a bind edit called the provider"
echo "$out" | grep -qi 'stale\|declaration' && no "a bind edit produced a warning: $out" || ok "no warning about the declaration"
out="$(zone test)"; echo "$out" | grep -i 'built against'
echo "$out" | grep -q 'ok.*built against this declaration' && ok "zone test still accepts the cache" || no "zone test refuses the cache after a bind edit"

echo
echo "=== a comment edit does not invalidate the cache either ==="
printf '\n# a comment somebody added\n' >> "$PROJ/zone.tree"
out="$(zone test)"
echo "$out" | grep -q 'ok.*built against this declaration' && ok "zone test accepts the cache after a comment" || no "a comment invalidated the cache"
before=$(calls)
out="$(zone read)"
after=$(calls)
[ "$after" = "$before" ] && ok "zone read does not refetch after a comment" || no "a comment made zone read fetch again"

echo
echo "=== and a NEW need does invalidate it ==="
printf '\nneed just-added\n' >> "$PROJ/zone.tree"
out="$(zone test)"
echo "$out" | grep -q 'ok.*built against this declaration' && no "a new need did not invalidate the cache" || ok "a new need invalidates the cache"

echo
echo "=== no value is ever printed ==="
all="$(cat "$ZONE_FAKE_LOG")"
for v in 1000 2000 3.5 nested-client 'hello world' 'BEGIN PRIVATE' 'p%40ss'; do
  echo "$all" | grep -q "$v" && no "the provider log holds $v" || ok "never logged $v"
done
out="$(printf 'secret-9\n' | zone save --name database-url --commit)"
echo "$out" | grep -q 'secret-9' && no "the save printed the value" || ok "the save never printed the value"

printf '\n=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
