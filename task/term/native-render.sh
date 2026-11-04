#!/bin/sh
#
# Does the Solid-style render runtime compile natively? Emits @term/site's `view/reactive`, `view/render` and the
# typed in-memory host `dom/native/memory/dom` for swift and kotlin through `pnpm term:native-emit`, then typechecks
# the swift with swiftc. Exits non-zero while any swift file fails, so it can become a gate once it passes.
#
#   pnpm term:native-render
#
# The emitted sources and swiftc's errors stay in tmp/native-render/ to read. See note/project/term/app/10-native-dom.md,
# "What was measured": on 2026-10-02 every module emitted with 0 check errors on both backends and swiftc rejected
# all three (fields reached Swift as `Any`, and a form is a Swift struct, so a signal write lands on a copy).

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/tmp/native-render"
mkdir -p "$OUT"
failed=0
# the swift files written THIS run, so an output left by an earlier list of modules is never judged
written=""
kotlin_written=""

for env in swift kotlin; do
  # the memory host is what swift and kotlin resolve the dom to (compile/native.ts, NATIVE_ENV_FALLBACK)
  for mod in view/reactive view/render dom/native/memory/dom; do
    name="$env-$(echo "$mod" | tr '/' '-')"
    pnpm --silent --dir "$ROOT" term:native-emit "$env" "deck/site/code/$mod.tree" > "$OUT/$name.src" 2> "$OUT/$name.check"
    echo "$env $mod: emitted $(wc -l < "$OUT/$name.src" | tr -d ' ') lines, $(grep -c . "$OUT/$name.check") check lines"
    [ "$env" = swift ] && written="$written $OUT/$name.src"
    [ "$env" = kotlin ] && kotlin_written="$kotlin_written $OUT/$name.src"
  done
done

if command -v swiftc > /dev/null; then
  for src in $written; do
    swift="${src%.src}.swift"
    cp "$src" "$swift"
    # count location lines only: swiftc repeats each error as an annotation under the source line
    errors=$(swiftc -typecheck "$swift" 2>&1 | grep -c -E '^/.*: error:')
    echo "swiftc $(basename "$swift"): $errors errors"
    [ "$errors" -eq 0 ] || failed=1
  done
else
  echo "swiftc not found, swift typecheck skipped"
fi

# kotlinc has no typecheck-only mode, so each module compiles to classes in a directory under the output
if command -v kotlinc > /dev/null; then
  for src in $kotlin_written; do
    kt="${src%.src}.kt"
    cp "$src" "$kt"
    # judged by the exit status: kotlinc's error lines read `e: file://...`, and a pattern can miss a format change
    if kotlinc "$kt" -d "${src%.src}-classes" > "${src%.src}.kotlinc" 2>&1; then
      echo "kotlinc $(basename "$kt"): compiles"
    else
      echo "kotlinc $(basename "$kt"): FAILS, see ${src%.src}.kotlinc"
      failed=1
    fi
  done
else
  echo "kotlinc not found, kotlin compile skipped"
fi

exit $failed
