#!/usr/bin/env bash
# Lint and format the seed TypeScript in small, visible chunks.
#
# Prettier formats every .ts across the packages (fast, no type information). Eslint --fix then runs ONE DIRECTORY AT A
# TIME so each step finishes in a few seconds and logs its result, instead of one giant invocation that prints nothing
# for minutes and looks hung. A per-chunk timeout means no single directory can stall the whole run. Eslint findings do
# not abort the script, so the formatting always lands.
#
# Run from the seed package root:  bash task/lint.sh   (or  pnpm lint).
#
# CHECK MODE, for a gate:  bash task/lint.sh --check
# Writes nothing: prettier --check and eslint without --fix, over the same chunks. A gate must not write, since other
# builders compare live files against their own copies while it runs (traps.md T-0010, item term-self-host-001-0445).
# It ends with one summary line, `lint --check: <a> of <b> prettier chunks unformatted, <c> of <d> eslint chunks with
# issues, <e> timed out`, and exits 1 when any count but the timeouts is above zero, 0 otherwise.

set -u
cd "$(dirname "$0")/.." || exit 1

check=0
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    *) echo "lint.sh: unknown argument $arg (only --check)" >&2; exit 2 ;;
  esac
done

cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
green() { printf '  \033[32m%s\033[0m\n' "$*"; }
yellow() { printf '  \033[33m%s\033[0m\n' "$*"; }

start=$(date +%s)
chunklog=$(mktemp)

# the counts check mode reports
pretty_all=0
pretty_bad=0
eslint_all=0
eslint_bad=0
timed_out=0

count_ts() { find "$1" -name '*.ts' 2>/dev/null | wc -l | tr -d ' '; }

# ---- prettier: format (or, with --check, only check) all TypeScript across the packages ----
if [ "$check" = 1 ]; then
  cyan "== prettier --check: TypeScript, nothing written =="
  pretty_flag=--check
else
  cyan "== prettier: formatting TypeScript =="
  pretty_flag=--write
fi
for d in deck/make/code deck/call/code deck/flow/code deck/deck/code \
  deck/base/code deck/face/code deck/site/code test; do
  [ -d "$d" ] || continue
  c=$(count_ts "$d")
  [ "$c" = 0 ] && continue
  printf '  %-24s (%4s files) ... ' "$d" "$c"
  pretty_all=$((pretty_all + 1))
  if npx prettier "$pretty_flag" "$d/**/*.ts" >"$chunklog" 2>&1; then
    printf '\033[32mformatted\033[0m\n'
  else
    pretty_bad=$((pretty_bad + 1))
    if [ "$check" = 1 ]; then
      files=$(grep -c '^\[warn\] [^ ]*\.ts$' "$chunklog" 2>/dev/null || echo '?')
      printf '\033[33m%s file(s) unformatted\033[0m\n' "$files"
    else
      printf '\033[33mwarn\033[0m\n'
    fi
  fi
done
pretty_all=$((pretty_all + 1))
if npx prettier "$pretty_flag" '*.ts' >/dev/null 2>&1; then
  echo "  root *.ts             ... formatted"
else
  pretty_bad=$((pretty_bad + 1))
  echo "  root *.ts             ... unformatted"
fi

# ---- eslint (--fix unless --check): one directory chunk at a time ----
if [ "$check" = 1 ]; then
  cyan "== eslint: per-directory chunks (type-aware), nothing fixed =="
  eslint_flag=
else
  cyan "== eslint --fix: per-directory chunks (type-aware) =="
  eslint_flag=--fix
fi
eslint_run() {
  # $eslint_flag is empty in check mode, so it is left out rather than passed as an empty argument
  if [ -n "$eslint_flag" ]; then
    NODE_OPTIONS=--max-old-space-size=8192 timeout 240 npx eslint "$eslint_flag" "$@" >"$chunklog" 2>&1
  else
    NODE_OPTIONS=--max-old-space-size=8192 timeout 240 npx eslint "$@" >"$chunklog" 2>&1
  fi
}
eslint_chunk() {
  local path="$1"
  local c
  c=$(count_ts "$path")
  [ "$c" = 0 ] && return
  printf '  %-30s (%4s files) ... ' "${path#deck/}" "$c"
  eslint_all=$((eslint_all + 1))
  eslint_run "$path"/**/*.ts
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '\033[32mclean\033[0m\n'
  elif [ "$rc" -eq 124 ]; then
    timed_out=$((timed_out + 1))
    printf '\033[33mTIMEOUT, skipped\033[0m\n'
  else
    eslint_bad=$((eslint_bad + 1))
    local issues
    issues=$(grep -cE '^[[:space:]]+[0-9]+:[0-9]+' "$chunklog" 2>/dev/null || echo '?')
    if [ "$check" = 1 ]; then
      printf '\033[33m%s issue(s)\033[0m\n' "$issues"
    else
      printf '\033[33mfixed, %s issue(s) remain\033[0m\n' "$issues"
    fi
  fi
}

for root in deck/make/code deck/call/code deck/flow/code deck/deck/code test; do
  [ -d "$root" ] || continue
  for sub in "$root"/*/; do
    [ -d "$sub" ] && eslint_chunk "${sub%/}"
  done
  tc=$(find "$root" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$tc" != 0 ]; then
    printf '  %-30s (%4s files) ... ' "${root#deck/} (top)" "$tc"
    eslint_all=$((eslint_all + 1))
    eslint_run "$root"/*.ts
    rc=$?
    if [ "$rc" -eq 0 ]; then
      printf '\033[32mclean\033[0m\n'
    elif [ "$rc" -eq 124 ]; then
      timed_out=$((timed_out + 1))
      printf '\033[33mTIMEOUT, skipped\033[0m\n'
    else
      eslint_bad=$((eslint_bad + 1))
      if [ "$check" = 1 ]; then
        printf '\033[33missues\033[0m\n'
      else
        printf '\033[33mfixed\033[0m\n'
      fi
    fi
  fi
done

rm -f "$chunklog"
end=$(date +%s)
cyan "== lint complete in $((end - start))s =="

if [ "$check" = 1 ]; then
  echo "lint --check: $pretty_bad of $pretty_all prettier chunks unformatted, $eslint_bad of $eslint_all eslint chunks with issues, $timed_out timed out"
  if [ "$pretty_bad" -gt 0 ] || [ "$eslint_bad" -gt 0 ]; then
    exit 1
  fi
fi
