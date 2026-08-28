#!/usr/bin/env bash
# The console's help surface.
#
#   bash test/help.sh
#
# Three things, none of which stay true on their own:
#
#   the top-level help fits one terminal screen
#   no line runs past 80 columns
#   every command it lists is real, and every real command is listed
#
# The last one is the one that rots. A command gets added to the dispatcher
# and not to the help, or renamed in one place, and the help quietly starts
# lying. Comparing the two lists in both directions is the only way that
# stays honest.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ZONE="$(cd "$HERE/.." && pwd)"
TERM_HOST="$ZONE/../../host/line.js"

# One screen. 24 rows is the traditional terminal, and the prompt that ran
# the command takes one, so the help gets the rest.
ROWS=23
COLS=80

PASS=0; FAIL=0
ok(){ printf '  ok    %s\n' "$1"; PASS=$((PASS+1)); }
no(){ printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
zone(){ ( cd "$ZONE" && node "$TERM_HOST" boot code/line/base.tree -- "$@" 2>&1 \
  | grep -vE '→ Booting|✓ Built|✓ Cached|Compiling|No build script' ); }

printf '\n=== help fits one screen ===\n'
HELP="$(zone --help)"
lines=$(printf '%s\n' "$HELP" | wc -l | tr -d ' ')
[ "$lines" -le "$ROWS" ] && ok "$lines lines, at most $ROWS" || no "$lines lines, over $ROWS"

widest=$(printf '%s\n' "$HELP" | awk '{ if (length($0) > m) m = length($0) } END { print m+0 }')
[ "$widest" -le "$COLS" ] && ok "widest line $widest, at most $COLS" || no "widest line $widest, over $COLS"

printf '\n=== every listed command is real ===\n'
listed=$(printf '%s\n' "$HELP" | awk '/^  [a-z]/ { print $1 }' | sort)
for c in $listed; do
  out="$(zone "$c" --help 2>&1)"
  printf '%s' "$out" | grep -qiE 'unknown|not a command' \
    && no "help lists $c, which the console does not know" \
    || ok "$c is real"
done

printf '\n=== every real command is listed ===\n'
# The dispatcher is the source of truth: a top-level `hook <name>` in the
# console is one command. Indented hooks are a command's own subcommands and
# do not belong in the top-level list.
real=$(awk '/^hook [a-z]/ { print $2 }' "$ZONE/code/line/base.tree" | sort -u)
missing=""
for c in $real; do
  printf '%s\n' "$listed" | grep -qx "$c" || missing="$missing $c"
done
count=$(printf '%s\n' "$real" | wc -l | tr -d ' ')
# A drift check that finds no commands would pass while checking nothing.
[ "$count" -ge 10 ] || no "only found $count commands in the dispatcher, so this check is not looking at the right thing"
[ -z "$missing" ] && ok "the help lists all $count commands" \
  || no "not listed in the help:$missing"

printf '\n=== every command says the same thing when there is no declaration ===\n'
# Six commands reach this check and used to say four different things: some
# named the directory and offered `zone lift`, some named it and offered
# nothing, some said "at or above this directory" without saying which.
EMPTY="$(mktemp -d)"
say_no_deck(){ ( cd "$EMPTY" && node "$TERM_HOST" boot "$ZONE/code/line/base.tree" -- "$@" 2>&1 \
  | grep -vE '→ Booting|✓ Built|✓ Cached|Compiling|No build script' ); }

for spec in "list" "read" "deck" "save" "load base -- true" "move wrangler --place x"; do
  name="${spec%% *}"
  # shellcheck disable=SC2086
  out="$(say_no_deck $spec)"
  ok_path=0; ok_fix=0
  printf '%s' "$out" | grep -q "$EMPTY"    && ok_path=1
  printf '%s' "$out" | grep -q 'zone lift' && ok_fix=1
  if [ "$ok_path" = 1 ] && [ "$ok_fix" = 1 ]; then
    ok "$name names where it looked, and what to run"
  else
    no "$name: path=$ok_path fix=$ok_fix"
  fi
done
rmdir "$EMPTY" 2>/dev/null

printf '\n=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
