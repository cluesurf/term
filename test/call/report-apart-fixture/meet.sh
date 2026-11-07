#!/bin/sh
# test/meet.tree run twice at once by the `term` under test (TERM_TEST_SELF, TERM_TEST_SELF_ENTRY): side a on node, and
# once side a has reported its first test, side b on rust, whose runner starts while side a's child still runs. Side a's
# second test reads the pipe `gate`, written once side b has ended, so side a ends after side b. Each side's output is
# printed with its side in front. Run from this folder, inside `term test`.
mkdir -p "$PWD/.base" || exit 2
M=$(mktemp -d "$PWD/.base/meet-XXXXXX") || exit 2
mkfifo "$M/gate" || exit 2
self() {
  if [ -n "$TERM_TEST_SELF_ENTRY" ]; then
    "$TERM_TEST_SELF" "$TERM_TEST_SELF_ENTRY" "$@"
  else
    "$TERM_TEST_SELF" "$@"
  fi
}
REPORT_MEET=$M REPORT_SIDE=a self test test/meet.tree --env node --color never --no-motion > "$M/a.log" 2>&1 &
A=$!
n=0
until [ -e "$M/a.here" ]; do
  n=$((n + 1))
  if [ $n -gt 3000 ] || ! kill -0 $A 2>/dev/null; then
    echo "side a never reached its second test"
    break
  fi
  sleep 0.1
done
REPORT_MEET=$M REPORT_SIDE=b self test test/meet.tree --env rust --color never --no-motion > "$M/b.log" 2>&1
B=$?
if [ -e "$M/a.here" ] && kill -0 $A 2>/dev/null; then
  echo open > "$M/gate"
fi
wait $A
echo "a exit $?"
echo "b exit $B"
# each side's last count, as `a: 2 tests · 2 passed`
echo "a: $(grep -o '[0-9]* tests* · .*' "$M/a.log" | tail -1)"
echo "b: $(grep -o '[0-9]* tests* · .*' "$M/b.log" | tail -1)"
sed 's/^/a: /' "$M/a.log"
sed 's/^/b: /' "$M/b.log"
rm -rf "$M"
