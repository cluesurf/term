#!/bin/sh
# The notes demo's gate (term/assurance/demo): `term hold` must hold on notes/ and refuse every twin under twin/.
# A twin that holds is a law not yet enforced. Prints one line per package, exits 1 when any verdict is not the one
# expected. EXPECTED_HOLD lists the twins known to hold today, each with the item that will make it refuse.
#
# usage: sh /Users/lancepollard/base/crew/cluesurf/deck/term/deck/term/test/assurance/hold.sh
line=/Users/lancepollard/base/crew/cluesurf/deck/term/deck/term/host/line.js
here=/Users/lancepollard/base/crew/cluesurf/deck/term/deck/term/test/assurance
# pending: no-forged-permit and permit-reused wait on affine-kinds (check/hide.ts, check/sole.ts)
EXPECTED_HOLD="no-forged-permit permit-reused"
bad=0

verdict() {
  (cd "$1" && node "$line" hold > /dev/null 2>&1) && echo holds || echo refused
}

got=$(verdict "$here/notes")
echo "notes                  $got (want holds)"
[ "$got" = holds ] || bad=1

for dir in "$here"/twin/*/; do
  name=$(basename "$dir")
  want=refused
  for pending in $EXPECTED_HOLD; do
    [ "$pending" = "$name" ] && want="holds, pending"
  done
  got=$(verdict "$dir")
  printf '%-22s %s (want %s)\n' "twin/$name" "$got" "$want"
  case "$want" in
    refused) [ "$got" = refused ] || bad=1 ;;
    *) [ "$got" = holds ] || echo "  $name is refused now: move it out of EXPECTED_HOLD" ;;
  esac
done

exit $bad
